-- =============================================================================
-- 0002_rpc.sql — transactional Postgres functions (RPCs) for the Hold'em app.
--
-- These functions are the atomic boundary. The pure game engine (shuffle, hand
-- evaluation, betting legality, pot math, bot policy) runs in TypeScript inside
-- the server orchestrator; it computes the next HandState and hands the result
-- to these RPCs, which persist it atomically with:
--   * balance<->stack conservation guards and non-negativity CHECKs (schema),
--   * the deferred circular FK two-step write (start_hand),
--   * the {street,to_act_seat,action_seq} fingerprint compare-and-increment and
--     the chip-conservation assert against total_committed (apply_action),
--   * single-conditional-UPDATE idempotency (claim_topup),
--   * idempotent, no-double-deduct / no-double-credit semantics (join/leave).
--
-- All functions are SECURITY DEFINER and run with the service-role; the browser
-- anon client never calls them (RLS has no client policies).
-- Error signalling uses RAISE EXCEPTION with a short code in MESSAGE/ERRCODE so
-- the route handlers can map to 409/404/etc.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- claim_topup(p_user_id uuid) -> bigint (new coin_balance)
--
-- Single atomic conditional UPDATE: credits coins back up to the 1000 starting
-- bonus ONLY when the user is low (coin_balance <= 100) and has not claimed in
-- the last 24h. If no row is updated the user is ineligible -> 409.
-- Two concurrent claims cannot both credit: only one UPDATE matches the guard.
-- -----------------------------------------------------------------------------
create or replace function claim_topup(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
begin
  update users
     set coin_balance = 1000,
         last_topup_at = now()
   where id = p_user_id
     and coin_balance <= 100
     and (last_topup_at is null or last_topup_at < now() - interval '24 hours')
  returning coin_balance into v_balance;

  if v_balance is null then
    raise exception 'topup_not_eligible' using errcode = 'P0001';
  end if;

  return v_balance;
end;
$$;

-- -----------------------------------------------------------------------------
-- join_room(p_room_code text, p_user_id uuid, p_buy_in int, p_seat_index int)
--   -> int (assigned seat_index)
--
-- Idempotent buy-in. Atomically: validates the room is joinable and the seat is
-- free, enforces min/max buy-in and buyIn <= coin_balance, deducts the buy-in
-- from coin_balance under a coin_balance >= buyIn predicate, and inserts the
-- seat with stack = buyIn. A retried join for an already-seated user hits the
-- partial unique index and returns 409 'already_seated' WITHOUT a second deduct.
-- -----------------------------------------------------------------------------
create or replace function join_room(
  p_room_code text,
  p_user_id uuid,
  p_buy_in int,
  p_seat_index int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room rooms%rowtype;
  v_deducted int;
begin
  select * into v_room from rooms where code = p_room_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;
  if v_room.status = 'closed' then
    raise exception 'room_closed' using errcode = 'P0001';
  end if;

  -- Buy-in bounds (server-authoritative; the client clamp is advisory only).
  if p_buy_in < v_room.min_buy_in or p_buy_in > v_room.max_buy_in then
    raise exception 'buy_in_out_of_bounds' using errcode = 'P0001';
  end if;

  if p_seat_index < 0 or p_seat_index >= v_room.max_seats then
    raise exception 'seat_out_of_range' using errcode = 'P0001';
  end if;

  -- Deduct the buy-in only if the balance covers it (prevents over-deduct; the
  -- CHECK (coin_balance >= 0) is the backstop).
  update users
     set coin_balance = coin_balance - p_buy_in
   where id = p_user_id
     and coin_balance >= p_buy_in
  returning 1 into v_deducted;

  if v_deducted is null then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  -- Insert the seat. A retried join for an already-seated user violates the
  -- partial unique index seats_room_user_active_unique -> map to 'already_seated'.
  begin
    insert into seats (room_id, user_id, seat_index, is_bot, stack, status)
    values (v_room.id, p_user_id, p_seat_index, false, p_buy_in, 'active');
  exception
    when unique_violation then
      -- Undo the deduction so the retry is a true no-op on balance.
      update users set coin_balance = coin_balance + p_buy_in where id = p_user_id;
      raise exception 'already_seated' using errcode = 'P0001';
  end;

  return p_seat_index;
end;
$$;

-- -----------------------------------------------------------------------------
-- leave_room(p_room_code text, p_user_id uuid) -> bigint (coin_balance)
--
-- Idempotent reconcile. If the user has an active (non-left) seat: credit the
-- uncommitted stack back to coin_balance, zero the stack, mark the seat 'left'.
-- If a hand is in progress and this seat is still 'in'/'allin', fold it in the
-- current hand first so its already-committed chips stay in the pot (committed
-- chips are NEVER credited here — only the uncommitted stack). If the seat is
-- already 'left' or absent, this is a no-op returning the current balance (so a
-- retried leave never double-credits).
-- -----------------------------------------------------------------------------
create or replace function leave_room(
  p_room_code text,
  p_user_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room rooms%rowtype;
  v_seat seats%rowtype;
  v_balance bigint;
begin
  select * into v_room from rooms where code = p_room_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  select * into v_seat
    from seats
   where room_id = v_room.id
     and user_id = p_user_id
     and status <> 'left'
   for update;

  -- Idempotent no-op: already left / never seated. Return current balance.
  if not found then
    select coin_balance into v_balance from users where id = p_user_id;
    return v_balance;
  end if;

  -- Mid-hand: fold the leaving seat in the live hand so its committed chips
  -- remain in the pot. Only the uncommitted stack is reconciled here.
  if v_room.current_hand_id is not null and v_room.status = 'in_hand' then
    update hand_players
       set status = 'folded'
     where hand_id = v_room.current_hand_id
       and seat_index = v_seat.seat_index
       and status in ('in', 'allin');
  end if;

  -- Credit the uncommitted stack back to the balance; zero the stack so it can
  -- never be credited a second time; mark the seat left.
  update users
     set coin_balance = coin_balance + v_seat.stack
   where id = p_user_id
  returning coin_balance into v_balance;

  update seats
     set stack = 0,
         status = 'left'
   where id = v_seat.id;

  return v_balance;
end;
$$;

-- -----------------------------------------------------------------------------
-- start_hand(p_room_id uuid, p_hand jsonb, p_players jsonb) -> uuid (hand_id)
--
-- Two-step write under the deferred circular FK, inside one transaction:
--   1. INSERT a hands row from the orchestrator-computed p_hand payload
--      (hand_no, dealer_seat, street, board, deck, to_act_seat, current_bet,
--       min_raise, last_aggressor_seat, act_deadline, pot, side_pots).
--   2. INSERT the per-seat hand_players rows from p_players (hole_cards, blinds
--      already posted into committed_this_street/total_committed, status).
--   3. UPDATE rooms SET current_hand_id = <new id>, status='in_hand',
--      last_dealer_seat = dealer_seat.
-- The dealer_seat (button) is chosen by the orchestrator per the rotation rule
-- (first hand = lowest occupied seat; thereafter next dealt-in seat clockwise)
-- and passed in; this RPC just persists it. The deferred FK makes the
-- intermediate state (room pointing at a not-yet-committed hand) legal.
-- Blind postings are also committed to the actions log via p_hand->'actions'.
-- -----------------------------------------------------------------------------
create or replace function start_hand(
  p_room_id uuid,
  p_hand jsonb,
  p_players jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hand_id uuid;
  v_dealer int;
  v_player jsonb;
  v_action jsonb;
begin
  perform 1 from rooms where id = p_room_id for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  v_dealer := (p_hand->>'dealer_seat')::int;

  insert into hands (
    room_id, hand_no, dealer_seat, street, board, deck, pot, side_pots,
    to_act_seat, current_bet, min_raise, last_aggressor_seat, action_seq,
    act_deadline
  )
  values (
    p_room_id,
    (p_hand->>'hand_no')::int,
    v_dealer,
    coalesce(p_hand->>'street', 'preflop')::street,
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_hand->'board')), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_hand->'deck')), '{}'),
    coalesce((p_hand->>'pot')::bigint, 0),
    p_hand->'side_pots',
    nullif(p_hand->>'to_act_seat', '')::int,
    coalesce((p_hand->>'current_bet')::bigint, 0),
    (p_hand->>'min_raise')::bigint,
    nullif(p_hand->>'last_aggressor_seat', '')::int,
    coalesce((p_hand->>'action_seq')::int, 0),
    nullif(p_hand->>'act_deadline', '')::timestamptz
  )
  returning id into v_hand_id;

  -- Per-seat dealt-in state.
  for v_player in select * from jsonb_array_elements(p_players)
  loop
    insert into hand_players (
      hand_id, seat_index, hole_cards, committed_this_street, total_committed,
      status, has_acted_this_street
    )
    values (
      v_hand_id,
      (v_player->>'seat_index')::int,
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(v_player->'hole_cards')), null),
      coalesce((v_player->>'committed_this_street')::bigint, 0),
      coalesce((v_player->>'total_committed')::bigint, 0),
      coalesce(v_player->>'status', 'in')::player_hand_status,
      coalesce((v_player->>'has_acted_this_street')::bool, false)
    );
  end loop;

  -- Blind-posting log entries (optional, provided by the orchestrator).
  if p_hand ? 'actions' then
    for v_action in select * from jsonb_array_elements(p_hand->'actions')
    loop
      insert into actions (hand_id, seat_index, street, action_type, amount, seq)
      values (
        v_hand_id,
        (v_action->>'seat_index')::int,
        (v_action->>'street')::street,
        (v_action->>'action_type')::action_type,
        coalesce((v_action->>'amount')::bigint, 0),
        (v_action->>'seq')::int
      );
    end loop;
  end if;

  -- Step 3: point the room at the live hand (legal mid-txn via the deferred FK).
  update rooms
     set current_hand_id = v_hand_id,
         status = 'in_hand',
         last_dealer_seat = v_dealer
   where id = p_room_id;

  return v_hand_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- apply_action(
--   p_hand_id uuid,
--   p_fp_street street, p_fp_to_act int, p_fp_action_seq int,  -- client fingerprint
--   p_hand jsonb,        -- orchestrator-computed next hands state
--   p_players jsonb,     -- orchestrator-computed next hand_players state
--   p_log jsonb          -- the action to append to the log
-- ) returns int (new action_seq)
--
-- Optimistic concurrency: compares the fingerprint {street,to_act_seat,
-- action_seq} to the current hands row (locked FOR UPDATE). If any field differs
-- the hand has moved on -> 409 'stale_fingerprint', nothing is mutated. On a
-- match it persists the computed next state, appends the action log row, and
-- increments action_seq. It asserts chip conservation against total_committed:
-- sum(seats.stack for dealt-in seats) + sum(next total_committed) must equal the
-- pre-action total, so a logic error aborts the transaction instead of minting
-- or destroying chips.
-- -----------------------------------------------------------------------------
create or replace function apply_action(
  p_hand_id uuid,
  p_fp_street street,
  p_fp_to_act int,
  p_fp_action_seq int,
  p_hand jsonb,
  p_players jsonb,
  p_log jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hand hands%rowtype;
  v_room_id uuid;
  v_new_seq int;
  v_player jsonb;
  v_before bigint;
  v_after bigint;
begin
  select * into v_hand from hands where id = p_hand_id for update;
  if not found then
    raise exception 'hand_not_found' using errcode = 'P0002';
  end if;

  -- Fingerprint compare: reject stale actions, mutate nothing.
  if v_hand.street is distinct from p_fp_street
     or v_hand.to_act_seat is distinct from p_fp_to_act
     or v_hand.action_seq is distinct from p_fp_action_seq then
    raise exception 'stale_fingerprint' using errcode = 'P0001';
  end if;

  v_room_id := v_hand.room_id;

  -- Chip-conservation baseline: dealt-in seats' live stacks + committed before.
  select coalesce(sum(s.stack), 0) + coalesce(sum(hp.total_committed), 0)
    into v_before
    from hand_players hp
    join seats s on s.room_id = v_room_id and s.seat_index = hp.seat_index
   where hp.hand_id = p_hand_id;

  v_new_seq := v_hand.action_seq + 1;

  -- Persist the computed next hands state and bump action_seq.
  update hands
     set street = coalesce(p_hand->>'street', street::text)::street,
         board = coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_hand->'board')), board),
         deck = coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_hand->'deck')), deck),
         pot = coalesce((p_hand->>'pot')::bigint, pot),
         side_pots = coalesce(p_hand->'side_pots', side_pots),
         to_act_seat = nullif(p_hand->>'to_act_seat', '')::int,
         current_bet = coalesce((p_hand->>'current_bet')::bigint, current_bet),
         min_raise = coalesce((p_hand->>'min_raise')::bigint, min_raise),
         last_aggressor_seat = nullif(p_hand->>'last_aggressor_seat', '')::int,
         action_seq = v_new_seq,
         act_deadline = nullif(p_hand->>'act_deadline', '')::timestamptz
   where id = p_hand_id;

  -- Persist per-seat next state and apply any stack deltas to seats.
  for v_player in select * from jsonb_array_elements(p_players)
  loop
    update hand_players
       set committed_this_street = coalesce((v_player->>'committed_this_street')::bigint, committed_this_street),
           total_committed = coalesce((v_player->>'total_committed')::bigint, total_committed),
           status = coalesce(v_player->>'status', status::text)::player_hand_status,
           has_acted_this_street = coalesce((v_player->>'has_acted_this_street')::bool, has_acted_this_street)
     where hand_id = p_hand_id
       and seat_index = (v_player->>'seat_index')::int;

    -- Optional authoritative stack set (chips moved out of the stack into pot).
    if v_player ? 'stack' then
      update seats
         set stack = (v_player->>'stack')::bigint
       where room_id = v_room_id
         and seat_index = (v_player->>'seat_index')::int;
    end if;
  end loop;

  -- Append the action to the log using the new seq.
  insert into actions (hand_id, seat_index, street, action_type, amount, seq)
  values (
    p_hand_id,
    (p_log->>'seat_index')::int,
    coalesce(p_log->>'street', p_hand->>'street')::street,
    (p_log->>'action_type')::action_type,
    coalesce((p_log->>'amount')::bigint, 0),
    v_new_seq
  );

  -- Chip-conservation assert: total chips in play must be unchanged.
  select coalesce(sum(s.stack), 0) + coalesce(sum(hp.total_committed), 0)
    into v_after
    from hand_players hp
    join seats s on s.room_id = v_room_id and s.seat_index = hp.seat_index
   where hp.hand_id = p_hand_id;

  if v_after is distinct from v_before then
    raise exception 'chip_conservation_violation: before=% after=%', v_before, v_after
      using errcode = 'P0001';
  end if;

  return v_new_seq;
end;
$$;

-- -----------------------------------------------------------------------------
-- complete_hand(
--   p_hand_id uuid,
--   p_fp_street street, p_fp_to_act int, p_fp_action_seq int,  -- fingerprint
--   p_hand jsonb,          -- final hands state (street='complete', final board)
--   p_payouts jsonb,       -- [{seat_index, amount}] chips credited to each winner
--   p_result jsonb         -- hand_results payload (winners, was_showdown, revealed_seats)
-- ) returns void
--
-- Showdown / hand-complete persistence the orchestrator calls after the pure
-- engine awards pots (buildPots -> awardPots / awardUncontested). Fingerprint-
-- guarded like apply_action. Atomically: sets the final hands state to
-- 'complete', credits each winner's seat stack by the awarded amount, writes the
-- single hand_results row, clears rooms.current_hand_id, and sets the room back
-- to 'waiting'. Reconciles any seat marked 'left' during the hand by crediting
-- its remaining uncommitted stack to coin_balance and zeroing the stack (the
-- deferred leave credit; committed chips were already resolved into the pot).
-- -----------------------------------------------------------------------------
create or replace function complete_hand(
  p_hand_id uuid,
  p_fp_street street,
  p_fp_to_act int,
  p_fp_action_seq int,
  p_hand jsonb,
  p_payouts jsonb,
  p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hand hands%rowtype;
  v_room_id uuid;
  v_payout jsonb;
  v_left seats%rowtype;
begin
  select * into v_hand from hands where id = p_hand_id for update;
  if not found then
    raise exception 'hand_not_found' using errcode = 'P0002';
  end if;

  if v_hand.street is distinct from p_fp_street
     or v_hand.to_act_seat is distinct from p_fp_to_act
     or v_hand.action_seq is distinct from p_fp_action_seq then
    raise exception 'stale_fingerprint' using errcode = 'P0001';
  end if;

  v_room_id := v_hand.room_id;

  -- Final hands state.
  update hands
     set street = coalesce(p_hand->>'street', 'complete')::street,
         board = coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_hand->'board')), board),
         pot = coalesce((p_hand->>'pot')::bigint, pot),
         side_pots = coalesce(p_hand->'side_pots', side_pots),
         to_act_seat = null,
         act_deadline = null,
         action_seq = action_seq + 1
   where id = p_hand_id;

  -- Credit winners' stacks.
  for v_payout in select * from jsonb_array_elements(p_payouts)
  loop
    update seats
       set stack = stack + (v_payout->>'amount')::bigint
     where room_id = v_room_id
       and seat_index = (v_payout->>'seat_index')::int;
  end loop;

  -- One hand_results row.
  insert into hand_results (hand_id, board, winners, was_showdown, revealed_seats)
  values (
    p_hand_id,
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_result->'board')), '{}'),
    coalesce(p_result->'winners', '[]'::jsonb),
    (p_result->>'was_showdown')::bool,
    coalesce((select array_agg(value::int) from jsonb_array_elements_text(p_result->'revealed_seats')), '{}')
  );

  -- Deferred leave reconciliation: any seat that left during the hand gets its
  -- remaining uncommitted stack credited to balance now, then zeroed.
  for v_left in
    select * from seats
     where room_id = v_room_id and status = 'left' and stack > 0
  loop
    update users set coin_balance = coin_balance + v_left.stack where id = v_left.user_id;
    update seats set stack = 0 where id = v_left.id;
  end loop;

  -- Release the room for the next hand.
  update rooms
     set current_hand_id = null,
         status = 'waiting'
   where id = v_room_id;
end;
$$;
