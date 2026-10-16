-- =============================================================================
-- 0001_init.sql — schema for the Telegram Hold'em Mini App (virtual coins).
--
-- All identifiers are snake_case. Timestamps are timestamptz default now().
-- Enums are Postgres enum types. The rooms<->hands circular FK is resolved by
-- creating rooms.current_hand_id without an inline FK, creating hands, then
-- adding a DEFERRABLE INITIALLY DEFERRED constraint so the start-hand RPC can
-- perform its two-step write inside one transaction.
--
-- RLS is enabled on every table with NO client policies: the browser anon client
-- only subscribes to Realtime Broadcast, and all reads/writes go through server
-- route handlers using the service-role key, which bypasses RLS.
-- =============================================================================

-- gen_random_uuid() lives in pgcrypto. Supabase enables it, but be explicit.
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type room_mode as enum ('single', 'multi');
create type room_status as enum ('waiting', 'in_hand', 'closed');
create type seat_status as enum ('active', 'sitting_out', 'left');
create type street as enum ('preflop', 'flop', 'turn', 'river', 'showdown', 'complete');
create type player_hand_status as enum ('in', 'folded', 'allin');
create type action_type as enum (
  'post_blind',
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'allin',
  'timeout_fold',
  'timeout_check'
);

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  username text,
  first_name text,
  coin_balance bigint not null default 1000,
  last_topup_at timestamptz,
  created_at timestamptz not null default now(),
  constraint users_coin_balance_nonneg check (coin_balance >= 0)
);

-- -----------------------------------------------------------------------------
-- rooms
--
-- current_hand_id is declared FK-less here; the FK to hands(id) is added via
-- ALTER TABLE below, after hands exists (circular FK resolution).
-- -----------------------------------------------------------------------------
create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  mode room_mode not null,
  status room_status not null default 'waiting',
  small_blind int not null,
  big_blind int not null,
  min_buy_in int not null,
  max_buy_in int not null,
  max_seats int not null default 6,
  last_dealer_seat int,
  turn_timeout_secs int not null default 30,
  created_by uuid references users(id),
  current_hand_id uuid,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- seats (players at a table; bots have user_id null)
-- -----------------------------------------------------------------------------
create table seats (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid references users(id),
  seat_index int not null,
  is_bot bool not null default false,
  bot_name text,
  stack bigint not null,
  status seat_status not null default 'active',
  joined_at timestamptz not null default now(),
  constraint seats_stack_nonneg check (stack >= 0),
  constraint seats_room_seat_unique unique (room_id, seat_index)
);

-- One active (non-left) seat per user per room: a retried join hits this and the
-- join RPC returns 409 instead of double-deducting a buy-in.
create unique index seats_room_user_active_unique
  on seats (room_id, user_id)
  where user_id is not null and status <> 'left';

-- -----------------------------------------------------------------------------
-- hands
--
-- deck is server-only remaining deck (never serialized to clients). pot and
-- side_pots are DISPLAY values recomputed from hand_players.total_committed;
-- they are not an independent source of truth.
-- -----------------------------------------------------------------------------
create table hands (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  hand_no int not null,
  dealer_seat int not null,
  street street not null default 'preflop',
  board text[] not null default '{}',
  deck text[] not null default '{}',
  pot bigint not null default 0,
  side_pots jsonb,
  to_act_seat int,
  current_bet bigint not null default 0,
  min_raise bigint not null,
  last_aggressor_seat int,
  action_seq int not null default 0,
  act_deadline timestamptz,
  created_at timestamptz not null default now()
);

-- Circular FK resolution: add the deferred FK now that hands exists. Deferred so
-- the start-hand RPC can INSERT a hand then UPDATE rooms.current_hand_id within a
-- single transaction without an intermediate violation.
alter table rooms
  add constraint rooms_current_hand_fk
  foreign key (current_hand_id) references hands(id)
  deferrable initially deferred;

-- -----------------------------------------------------------------------------
-- hand_players (per-hand per-seat state)
--
-- hole_cards is server-only; redacted for other viewers in the snapshot mapper.
-- -----------------------------------------------------------------------------
create table hand_players (
  id uuid primary key default gen_random_uuid(),
  hand_id uuid not null references hands(id) on delete cascade,
  seat_index int not null,
  hole_cards text[],
  committed_this_street bigint not null default 0,
  total_committed bigint not null default 0,
  status player_hand_status not null default 'in',
  has_acted_this_street bool not null default false,
  constraint hand_players_hand_seat_unique unique (hand_id, seat_index)
);

-- -----------------------------------------------------------------------------
-- actions (append-only action log / hand history detail)
--
-- seq equals the hands.action_seq value assigned to the action; it orders the
-- append-only log within a hand.
-- -----------------------------------------------------------------------------
create table actions (
  id uuid primary key default gen_random_uuid(),
  hand_id uuid not null references hands(id),
  seat_index int not null,
  street street not null,
  action_type action_type not null,
  amount bigint not null default 0,
  seq int not null,
  created_at timestamptz not null default now()
);

create index actions_hand_seq_idx on actions (hand_id, seq);

-- -----------------------------------------------------------------------------
-- hand_results (hand history summary; one per hand)
--
-- winners carries hand_rank + best_five for showdown winners only; on a fold-out
-- they are omitted and revealed_seats is empty.
-- -----------------------------------------------------------------------------
create table hand_results (
  id uuid primary key default gen_random_uuid(),
  hand_id uuid not null unique references hands(id),
  board text[] not null default '{}',
  winners jsonb not null default '[]',
  was_showdown bool not null,
  revealed_seats int[] not null default '{}',
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Indexes supporting the cron liveness query and common lookups.
-- -----------------------------------------------------------------------------
create index rooms_status_idx on rooms (status);
create index hands_room_idx on hands (room_id);
create index hands_act_deadline_idx on hands (act_deadline);
create index seats_room_idx on seats (room_id);
create index hand_players_hand_idx on hand_players (hand_id);

-- -----------------------------------------------------------------------------
-- Row Level Security: enabled on every table, with NO client policies. The
-- service-role key used by server route handlers bypasses RLS; the browser anon
-- client never reads these tables (Realtime Broadcast only).
-- -----------------------------------------------------------------------------
alter table users enable row level security;
alter table rooms enable row level security;
alter table seats enable row level security;
alter table hands enable row level security;
alter table hand_players enable row level security;
alter table actions enable row level security;
alter table hand_results enable row level security;
