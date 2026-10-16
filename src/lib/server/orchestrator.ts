// The orchestrator is the ONLY module where the pure engine, the DB repo, and
// Realtime meet. Every mutation follows: load -> validate -> apply pure reducer
// -> persist in one RPC -> broadcast.
//
// It owns:
//   * building HandState from DB rows (and marshalling back to RPC payloads),
//   * starting a hand (button rotation, blind posting incl. partial-blind-all-in),
//   * applying a human action (fingerprint + legality re-check),
//   * the fingerprint-+deadline-guarded bot/timeout advance loop,
//   * showdown evaluation (load hole_cards, build ranks, buildPots+awardPots /
//     awardUncontested, write hand_results) and hand completion,
//   * the deferred leave-credit, which the complete_hand RPC applies.
//
// The pure engine (src/lib/server/engine/*) stays I/O-free; this file is the
// only place that imports BOTH the engine and the repo/Realtime layers.

import type { RoomRow, SeatRow } from "./repo/rooms";
import { getRoomByCode, getSeats } from "./repo/rooms";
import type { HandRow, HandPlayerRow, HandPayload, PlayerPayload } from "./repo/hands";
import {
  getHandById,
  getHandPlayers,
  maxHandNo,
  startHand as startHandRpc,
  applyActionRpc,
  completeHandRpc,
} from "./repo/hands";
import { broadcastState } from "./realtime/broadcast";
import { freshShuffledDeck } from "./engine/cards";
import type { Card } from "./engine/cards";
import {
  HandState,
  SeatState,
  Street,
  advance,
} from "./engine/handState";
import {
  Action,
  LegalAction,
  applyAction,
  legalActions,
  nextToAct,
} from "./engine/betting";
import { evaluateBest, HandRank } from "./engine/handEval";
import { buildPots, awardPots, awardUncontested, Contribution } from "./engine/pots";
import { decide, BotView } from "./engine/bot";

// Max iterations of the bot/timeout loop before we bail (safety against a bug;
// one hand can never need more than a handful of seats * streets iterations).
const MAX_LOOP_ITERATIONS = 200;

// --------------------------------------------------------------------------
// HandState <-> DB marshalling
// --------------------------------------------------------------------------

/**
 * Build the pure HandState from DB rows. Hole cards are intentionally NOT part
 * of HandState (the reducer never needs them); the orchestrator loads them
 * separately for showdown evaluation.
 */
export function buildHandState(
  room: RoomRow,
  seats: SeatRow[],
  hand: HandRow,
  players: HandPlayerRow[],
): HandState {
  const bySeat = new Map<number, HandPlayerRow>();
  for (const p of players) bySeat.set(p.seat_index, p);
  const stackBySeat = new Map<number, number>();
  for (const s of seats) stackBySeat.set(s.seat_index, s.stack);

  const seatStates: SeatState[] = players.map((p) => ({
    seat_index: p.seat_index,
    stack: stackBySeat.get(p.seat_index) ?? 0,
    committed_this_street: Number(p.committed_this_street),
    total_committed: Number(p.total_committed),
    status: p.status,
    has_acted_this_street: p.has_acted_this_street,
    is_button: p.seat_index === hand.dealer_seat,
  }));

  return {
    street: hand.street,
    board: hand.board ?? [],
    deck: hand.deck ?? [],
    seats: seatStates,
    button_seat: hand.dealer_seat,
    small_blind: room.small_blind,
    big_blind: room.big_blind,
    current_bet: Number(hand.current_bet),
    min_raise: Number(hand.min_raise),
    last_aggressor_seat: hand.last_aggressor_seat,
    to_act_seat: hand.to_act_seat,
    action_seq: hand.action_seq,
    act_deadline: hand.act_deadline,
    turn_timeout_secs: room.turn_timeout_secs,
  };
}

function handPayload(state: HandState): HandPayload {
  return {
    street: state.street,
    board: state.board,
    deck: state.deck,
    pot: state.seats.reduce((sum, s) => sum + s.total_committed, 0),
    side_pots: buildSidePotsView(state),
    to_act_seat: state.to_act_seat,
    current_bet: state.current_bet,
    min_raise: state.min_raise,
    last_aggressor_seat: state.last_aggressor_seat,
    act_deadline: state.act_deadline,
  };
}

function playerPayloads(state: HandState): PlayerPayload[] {
  return state.seats.map((s) => ({
    seat_index: s.seat_index,
    committed_this_street: s.committed_this_street,
    total_committed: s.total_committed,
    status: s.status,
    has_acted_this_street: s.has_acted_this_street,
    stack: s.stack,
  }));
}

/** Display-only side-pot view, computed from current total_committed. */
function buildSidePotsView(
  state: HandState,
): Array<{ amount: number; eligible_seat_indexes: number[] }> {
  const contributions: Contribution[] = state.seats.map((s) => ({
    seat: s.seat_index,
    committed: s.total_committed,
    folded: s.status === "folded",
  }));
  return buildPots(contributions).map((p) => ({
    amount: p.amount,
    eligible_seat_indexes: p.eligibleSeats,
  }));
}

// --------------------------------------------------------------------------
// Fingerprint
// --------------------------------------------------------------------------

export interface Fingerprint {
  street: Street;
  to_act_seat: number | null;
  action_seq: number;
}

function fingerprintOf(hand: HandRow): Fingerprint {
  return {
    street: hand.street,
    to_act_seat: hand.to_act_seat,
    action_seq: hand.action_seq,
  };
}

// --------------------------------------------------------------------------
// Start hand
// --------------------------------------------------------------------------

/** Seats eligible to be dealt into a hand (active, with chips). */
function dealInSeats(seats: SeatRow[]): SeatRow[] {
  return seats
    .filter((s) => s.status === "active" && s.stack > 0)
    .sort((a, b) => a.seat_index - b.seat_index);
}

/** Choose the button seat per the rotation rule (design.md "Dealer-button rotation"). */
function chooseButton(dealtIn: SeatRow[], lastDealer: number | null): number {
  const indexes = dealtIn.map((s) => s.seat_index);
  if (lastDealer === null) return indexes[0];
  // Next dealt-in seat strictly clockwise after lastDealer, wrapping.
  const greater = indexes.filter((i) => i > lastDealer).sort((a, b) => a - b);
  if (greater.length > 0) return greater[0];
  return indexes[0];
}

function nextSeatClockwise(indexes: number[], from: number): number {
  const sorted = [...indexes].sort((a, b) => a - b);
  const pos = sorted.indexOf(from);
  return sorted[(pos + 1) % sorted.length];
}

interface StartResult {
  handId: string;
  snapshotHandId: string;
}

/**
 * Start a new hand in a waiting room. Posts blinds (incl. the partial-blind-all-in
 * fallback), deals hole cards, persists via start_hand, then runs the bot loop up
 * to the first human turn (or hand completion) before returning. Throws
 * 'not_enough_players' if fewer than two seats can be dealt in.
 */
export async function startHand(code: string): Promise<StartResult> {
  const room = await getRoomByCode(code);
  if (!room) throw new Error("room_not_found");
  if (room.status === "in_hand" && room.current_hand_id) {
    // A hand is already live; return it rather than starting a second.
    return { handId: room.current_hand_id, snapshotHandId: room.current_hand_id };
  }

  const seats = await getSeats(room.id);
  const dealtIn = dealInSeats(seats);
  if (dealtIn.length < 2) throw new Error("not_enough_players");

  const indexes = dealtIn.map((s) => s.seat_index);
  const button = chooseButton(dealtIn, room.last_dealer_seat);

  // Blind seats per heads-up vs 3+ rule.
  let sbSeat: number;
  let bbSeat: number;
  if (dealtIn.length === 2) {
    // Heads-up: button posts SB, other posts BB.
    sbSeat = button;
    bbSeat = nextSeatClockwise(indexes, button);
  } else {
    sbSeat = nextSeatClockwise(indexes, button);
    bbSeat = nextSeatClockwise(indexes, sbSeat);
  }

  // Fresh shuffled deck; deal 2 hole cards each in seat order.
  const deck = freshShuffledDeck();
  const holeBySeat = new Map<number, Card[]>();
  for (const s of dealtIn) holeBySeat.set(s.seat_index, []);
  for (let round = 0; round < 2; round++) {
    for (const s of dealtIn) {
      const card = deck.shift();
      if (card === undefined) throw new Error("deck_exhausted");
      holeBySeat.get(s.seat_index)!.push(card);
    }
  }

  const stackBySeat = new Map<number, number>();
  for (const s of dealtIn) stackBySeat.set(s.seat_index, s.stack);

  // Post blinds into committed counters, clamping to stack (partial-blind-all-in).
  const committed = new Map<number, number>();
  const statusBySeat = new Map<number, "in" | "allin" | "folded">();
  for (const s of dealtIn) {
    committed.set(s.seat_index, 0);
    statusBySeat.set(s.seat_index, "in");
  }
  const actionsLog: HandPayload["actions"] = [];
  let seq = 0;

  const postBlind = (seat: number, amount: number): void => {
    const stack = stackBySeat.get(seat)!;
    const posted = Math.min(amount, stack);
    stackBySeat.set(seat, stack - posted);
    committed.set(seat, committed.get(seat)! + posted);
    if (stackBySeat.get(seat) === 0) statusBySeat.set(seat, "allin");
    actionsLog.push({
      seat_index: seat,
      street: "preflop",
      action_type: "post_blind",
      amount: posted,
      seq: ++seq,
    });
  };
  postBlind(sbSeat, room.small_blind);
  postBlind(bbSeat, room.big_blind);

  const currentBet = Math.max(
    committed.get(sbSeat) ?? 0,
    committed.get(bbSeat) ?? 0,
  );

  // Build the pre-action HandState to determine the first actor via nextToAct.
  const seatStates: SeatState[] = dealtIn.map((s) => ({
    seat_index: s.seat_index,
    stack: stackBySeat.get(s.seat_index)!,
    committed_this_street: committed.get(s.seat_index)!,
    total_committed: committed.get(s.seat_index)!,
    status: statusBySeat.get(s.seat_index)!,
    // BB gets its preflop option (has_acted stays false even though it posted).
    has_acted_this_street: false,
    is_button: s.seat_index === button,
  }));

  const preState: HandState = {
    street: "preflop",
    board: [],
    deck,
    seats: seatStates,
    button_seat: button,
    small_blind: room.small_blind,
    big_blind: room.big_blind,
    current_bet: currentBet,
    min_raise: room.big_blind,
    last_aggressor_seat: null,
    to_act_seat: null,
    action_seq: 0,
    act_deadline: null,
    turn_timeout_secs: room.turn_timeout_secs,
  };
  const firstActor = nextToAct(preState);
  preState.to_act_seat = firstActor;
  preState.act_deadline =
    firstActor === null
      ? null
      : new Date(Date.now() + room.turn_timeout_secs * 1000).toISOString();

  const handNo = (await maxHandNo(room.id)) + 1;

  const hand: HandPayload = {
    hand_no: handNo,
    dealer_seat: button,
    street: "preflop",
    board: [],
    deck: preState.deck,
    pot: seatStates.reduce((sum, s) => sum + s.total_committed, 0),
    side_pots: buildSidePotsView(preState),
    to_act_seat: preState.to_act_seat,
    current_bet: preState.current_bet,
    min_raise: preState.min_raise,
    last_aggressor_seat: preState.last_aggressor_seat,
    action_seq: 0,
    act_deadline: preState.act_deadline,
    actions: actionsLog,
  };
  const players: PlayerPayload[] = seatStates.map((s) => ({
    seat_index: s.seat_index,
    hole_cards: holeBySeat.get(s.seat_index) ?? [],
    committed_this_street: s.committed_this_street,
    total_committed: s.total_committed,
    status: s.status,
    has_acted_this_street: s.has_acted_this_street,
    stack: s.stack,
  }));

  const handId = await startHandRpc({ roomId: room.id, hand, players });

  // Persist authoritative blind-deducted stacks onto the seat rows.
  await setSeatStacks(
    room.id,
    seatStates.map((s) => ({ seat_index: s.seat_index, stack: s.stack })),
  );

  await broadcastState(code, {
    version: 0,
    street: "preflop",
    to_act_seat: preState.to_act_seat,
  });

  // Drive the bot/timeout loop up to the first human turn (or completion).
  await runLoop(code);

  return { handId, snapshotHandId: handId };
}

/** Persist seat stacks (used when blinds are posted outside an RPC). */
async function setSeatStacks(
  roomId: string,
  stacks: Array<{ seat_index: number; stack: number }>,
): Promise<void> {
  const { supabaseAdmin } = await import("./supabaseAdmin");
  const db = supabaseAdmin();
  for (const s of stacks) {
    const { error } = await db
      .from("seats")
      .update({ stack: s.stack })
      .eq("room_id", roomId)
      .eq("seat_index", s.seat_index);
    if (error) throw new Error(`setSeatStacks failed: ${error.message}`);
  }
}

// --------------------------------------------------------------------------
// Apply a human action
// --------------------------------------------------------------------------

export interface ActionRequest {
  code: string;
  userSeatIndex: number;
  action: Action;
  fingerprint: Fingerprint;
}

/**
 * Apply a human player's action. Validates the fingerprint and legality against
 * the current authoritative state, persists atomically, then advances (running
 * any following bot turns / street transitions) up to the next human turn or
 * completion.
 */
export async function applyHumanAction(req: ActionRequest): Promise<void> {
  const room = await getRoomByCode(req.code);
  if (!room || !room.current_hand_id) throw new Error("hand_not_found");

  const hand = await getHandById(room.current_hand_id);
  if (!hand) throw new Error("hand_not_found");

  // Fingerprint compare (fast-fail before any mutation; the RPC re-asserts).
  const fp = fingerprintOf(hand);
  if (
    fp.street !== req.fingerprint.street ||
    fp.to_act_seat !== req.fingerprint.to_act_seat ||
    fp.action_seq !== req.fingerprint.action_seq
  ) {
    throw new Error("stale_fingerprint");
  }

  if (hand.to_act_seat !== req.userSeatIndex) {
    throw new Error("not_your_turn");
  }

  const seats = await getSeats(room.id);
  const players = await getHandPlayers(hand.id);
  const state = buildHandState(room, seats, hand, players);

  // Legality re-check regardless of client claims.
  assertLegal(state, req.userSeatIndex, req.action);

  const logType = actionLogType(state, req.userSeatIndex, req.action);
  const logAmount = actionLogAmount(state, req.userSeatIndex, req.action);

  const nextState = applyAction(state, req.userSeatIndex, req.action);

  await applyActionRpc({
    handId: hand.id,
    fp,
    hand: handPayload(nextState),
    players: playerPayloads(nextState),
    log: {
      seat_index: req.userSeatIndex,
      street: state.street,
      action_type: logType,
      amount: logAmount,
    },
  });

  await broadcastState(req.code, {
    version: hand.action_seq + 1,
    street: nextState.street,
    to_act_seat: nextState.to_act_seat,
  });

  // Advance through streets / bot turns up to the next human turn or completion.
  await runLoop(req.code);
}

function assertLegal(state: HandState, seat: number, action: Action): void {
  const legal = legalActions(state, seat);
  const ok = legal.some((la) => matchesLegal(la, action, state, seat));
  if (!ok) throw new Error("illegal_action");
}

function matchesLegal(
  la: LegalAction,
  action: Action,
  state: HandState,
  seat: number,
): boolean {
  switch (action.type) {
    case "fold":
      return la.type === "fold";
    case "check":
      return la.type === "check";
    case "call":
      return la.type === "call";
    case "allin":
      return la.type === "allin";
    case "bet":
      return (
        la.type === "bet" && action.amount >= la.min && action.amount <= la.max
      );
    case "raise":
      return la.type === "raise" && action.to >= la.min && action.to <= la.max;
    default:
      return false;
  }
}

// --------------------------------------------------------------------------
// The bot/timeout advance loop
// --------------------------------------------------------------------------

/**
 * Run the fingerprint-+deadline-guarded advance loop for a room until it reaches
 * a human turn or the hand completes. Each iteration:
 *   1. reads the hand fresh (fingerprint re-asserted inside every RPC),
 *   2. if the current street's betting is still open and to_act is a HUMAN whose
 *      deadline has not passed -> stop (nothing to do; wait for them),
 *   3. if to_act is a BOT -> compute its action and apply it,
 *   4. if to_act is a human whose deadline HAS passed -> apply timeout_check/fold,
 *   5. if the betting round is closed / showdown reached -> advance street or run
 *      the showdown/fold-out completion.
 */
export async function runLoop(code: string): Promise<void> {
  for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
    const room = await getRoomByCode(code);
    if (!room || !room.current_hand_id || room.status !== "in_hand") return;

    const hand = await getHandById(room.current_hand_id);
    if (!hand) return;
    if (hand.street === "complete") return;

    const seats = await getSeats(room.id);
    const players = await getHandPlayers(hand.id);
    const state = buildHandState(room, seats, hand, players);

    // Showdown reached by a prior advance: evaluate + complete, then stop.
    if (state.street === "showdown") {
      await completeShowdown(room, hand, seats, players, state);
      return;
    }

    const toAct = state.to_act_seat;

    // Betting round closed on this street (nextToAct null): advance the street.
    if (toAct === null || nextToAct(state) === null) {
      const advanced = advance(state);
      // Fold-out or showdown terminal reached by advance?
      if (advanced.street === "complete" || advanced.street === "showdown") {
        await completeHandFromAdvance(room, hand, seats, players, advanced);
        return;
      }
      await persistAdvance(room, hand, advanced);
      continue; // loop again with the new street's first actor
    }

    // There is a seat to act. Is it a bot, a timed-out human, or a waiting human?
    const seatRow = seats.find((s) => s.seat_index === toAct);
    if (!seatRow) return; // defensive

    const deadlinePassed =
      hand.act_deadline !== null && Date.now() > Date.parse(hand.act_deadline);

    if (seatRow.is_bot) {
      await applyBotAction(room, hand, seats, players, state, toAct);
      continue;
    }

    if (deadlinePassed) {
      await applyTimeout(room, hand, state, toAct);
      continue;
    }

    // Human's turn, deadline not passed: nothing to drive. Stop.
    return;
  }
}

/** Compute and apply a bot's action for the seat to act. */
async function applyBotAction(
  room: RoomRow,
  hand: HandRow,
  seats: SeatRow[],
  players: HandPlayerRow[],
  state: HandState,
  seat: number,
): Promise<void> {
  const hp = players.find((p) => p.seat_index === seat);
  const holeCards = hp?.hole_cards ?? [];
  const seatState = state.seats.find((s) => s.seat_index === seat)!;
  const legal = legalActions(state, seat);
  const pot = state.seats.reduce((sum, s) => sum + s.total_committed, 0);
  const toCall = Math.max(0, state.current_bet - seatState.committed_this_street);
  const activeOpponents = state.seats.filter(
    (s) => s.seat_index !== seat && (s.status === "in" || s.status === "allin"),
  ).length;

  const view: BotView = {
    holeCards,
    board: state.board,
    pot,
    toCall,
    stack: seatState.stack,
    legalActions: legal,
    activeOpponents,
  };
  // Seed from stable per-turn values so the decision is deterministic yet varies.
  const seed = (hand.action_seq + 1) * 2654435761 + seat;
  const action = decide(view, seed >>> 0);

  const logType = actionLogType(state, seat, action);
  const logAmount = actionLogAmount(state, seat, action);
  const nextState = applyAction(state, seat, action);

  await applyActionRpc({
    handId: hand.id,
    fp: fingerprintOf(hand),
    hand: handPayload(nextState),
    players: playerPayloads(nextState),
    log: { seat_index: seat, street: state.street, action_type: logType, amount: logAmount },
  });
  await broadcastState(room.code, {
    version: hand.action_seq + 1,
    street: nextState.street,
    to_act_seat: nextState.to_act_seat,
  });
}

/** Apply a timeout: check if legal, else fold. */
async function applyTimeout(
  room: RoomRow,
  hand: HandRow,
  state: HandState,
  seat: number,
): Promise<void> {
  const legal = legalActions(state, seat);
  const canCheck = legal.some((a) => a.type === "check");
  const action: Action = canCheck ? { type: "check" } : { type: "fold" };
  const logType = canCheck ? "timeout_check" : "timeout_fold";
  const nextState = applyAction(state, seat, action);

  await applyActionRpc({
    handId: hand.id,
    fp: fingerprintOf(hand),
    hand: handPayload(nextState),
    players: playerPayloads(nextState),
    log: { seat_index: seat, street: state.street, action_type: logType, amount: 0 },
  });
  await broadcastState(room.code, {
    version: hand.action_seq + 1,
    street: nextState.street,
    to_act_seat: nextState.to_act_seat,
  });
}

/** Persist a street advance (no betting action; a new street opened). */
async function persistAdvance(
  room: RoomRow,
  hand: HandRow,
  advanced: HandState,
): Promise<void> {
  // A street transition still passes through apply_action with a synthetic log
  // so the action_seq increments and the fingerprint guard stays coherent.
  await applyActionRpc({
    handId: hand.id,
    fp: fingerprintOf(hand),
    hand: handPayload(advanced),
    players: playerPayloads(advanced),
    log: {
      seat_index: advanced.to_act_seat ?? hand.dealer_seat,
      street: advanced.street,
      action_type: "check",
      amount: 0,
    },
  });
  await broadcastState(room.code, {
    version: hand.action_seq + 1,
    street: advanced.street,
    to_act_seat: advanced.to_act_seat,
  });
}

// --------------------------------------------------------------------------
// Showdown / completion (orchestrator owns evaluation)
// --------------------------------------------------------------------------

/**
 * advance() returned a terminal street. Branch: 'complete' = fold-out
 * (awardUncontested, no evaluation), 'showdown' = contested (evaluate + award).
 */
async function completeHandFromAdvance(
  room: RoomRow,
  hand: HandRow,
  seats: SeatRow[],
  players: HandPlayerRow[],
  advanced: HandState,
): Promise<void> {
  if (advanced.street === "complete") {
    await completeFoldOut(room, hand, advanced);
  } else {
    // showdown: persist the run-out board first so completeShowdown sees it,
    // then evaluate. We fold this into one completion using the advanced state.
    await completeShowdownState(room, hand, players, advanced);
  }
}

/** Fold-out: sole survivor takes every pot layer; no cards revealed. */
async function completeFoldOut(
  room: RoomRow,
  hand: HandRow,
  state: HandState,
): Promise<void> {
  const { awards, payouts } = evaluateShowdown(state, new Map());

  await completeHandRpc({
    handId: hand.id,
    fp: fingerprintOf(hand),
    hand: {
      ...handPayload(state),
      street: "complete",
    },
    payouts,
    result: {
      board: state.board,
      winners: awards.map((a) => ({
        seat_index: a.seat,
        amount: a.amount,
        pot_index: a.pot_index,
      })),
      was_showdown: false,
      revealed_seats: [],
    },
  });
  await broadcastState(room.code, {
    version: hand.action_seq + 1,
    street: "complete",
    to_act_seat: null,
  });
}

/** Contested showdown driven from an in-memory advanced state (board run out). */
async function completeShowdownState(
  room: RoomRow,
  hand: HandRow,
  players: HandPlayerRow[],
  state: HandState,
): Promise<void> {
  const holeBySeat = new Map<number, string[]>();
  for (const p of players) holeBySeat.set(p.seat_index, p.hole_cards ?? []);

  const { awards, payouts, revealedSeats } = evaluateShowdown(
    state,
    holeBySeat,
  );
  const ranks = new Map<number, HandRank>();
  for (const seat of revealedSeats) {
    const hole = holeBySeat.get(seat) ?? [];
    ranks.set(seat, evaluateBest([...hole, ...state.board]));
  }

  await completeHandRpc({
    handId: hand.id,
    fp: fingerprintOf(hand),
    hand: {
      ...handPayload(state),
      street: "complete",
    },
    payouts,
    result: {
      board: state.board,
      winners: awards.map((a) => {
        const r = ranks.get(a.seat);
        return {
          seat_index: a.seat,
          amount: a.amount,
          pot_index: a.pot_index,
          hand_rank: r?.category,
          best_five: r?.bestFive,
        };
      }),
      was_showdown: true,
      revealed_seats: revealedSeats,
    },
  });
  await broadcastState(room.code, {
    version: hand.action_seq + 1,
    street: "complete",
    to_act_seat: null,
  });
}

/** Showdown reached as the current persisted street; load rows and complete. */
async function completeShowdown(
  room: RoomRow,
  hand: HandRow,
  _seats: SeatRow[],
  players: HandPlayerRow[],
  state: HandState,
): Promise<void> {
  await completeShowdownState(room, hand, players, state);
}

/**
 * PURE showdown evaluation, shared by the completion path and the integration
 * test. Given a terminal HandState (street 'showdown' or a fold-out 'complete')
 * and each contender's hole cards, returns the awards, the aggregated payouts,
 * the revealed seats, and whether it was a contested showdown. Performs no I/O.
 */
export function evaluateShowdown(
  state: HandState,
  holeBySeat: Map<number, Card[]>,
): {
  awards: Array<{ seat: number; pot_index: number; amount: number }>;
  payouts: Array<{ seat_index: number; amount: number }>;
  revealedSeats: number[];
  wasShowdown: boolean;
} {
  const contributions: Contribution[] = state.seats.map((s) => ({
    seat: s.seat_index,
    committed: s.total_committed,
    folded: s.status === "folded",
  }));
  const pots = buildPots(contributions);
  const contenders = state.seats.filter(
    (s) => s.status === "in" || s.status === "allin",
  );

  if (contenders.length <= 1) {
    const survivor = contenders[0];
    const awards = survivor ? awardUncontested(pots, survivor.seat_index) : [];
    return {
      awards,
      payouts: aggregatePayouts(awards),
      revealedSeats: [],
      wasShowdown: false,
    };
  }

  const ranks = new Map<number, HandRank>();
  for (const c of contenders) {
    const hole = holeBySeat.get(c.seat_index) ?? [];
    ranks.set(c.seat_index, evaluateBest([...hole, ...state.board]));
  }
  const awards = awardPots(pots, ranks, state.button_seat);
  return {
    awards,
    payouts: aggregatePayouts(awards),
    revealedSeats: contenders.map((c) => c.seat_index),
    wasShowdown: true,
  };
}

/** Collapse per-pot awards into one payout per seat. */
function aggregatePayouts(
  awards: Array<{ seat: number; pot_index: number; amount: number }>,
): Array<{ seat_index: number; amount: number }> {
  const bySeat = new Map<number, number>();
  for (const a of awards) {
    bySeat.set(a.seat, (bySeat.get(a.seat) ?? 0) + a.amount);
  }
  return [...bySeat.entries()].map(([seat_index, amount]) => ({
    seat_index,
    amount,
  }));
}

// --------------------------------------------------------------------------
// Action-log helpers
// --------------------------------------------------------------------------

function actionLogType(state: HandState, seat: number, action: Action): string {
  const seatState = state.seats.find((s) => s.seat_index === seat)!;
  switch (action.type) {
    case "fold":
      return "fold";
    case "check":
      return "check";
    case "call":
      return "call";
    case "bet":
      return "bet";
    case "raise":
      return "raise";
    case "allin": {
      // Resolve to the concrete logged type for the history.
      if (state.current_bet === 0) return "bet";
      const allInLevel = seatState.committed_this_street + seatState.stack;
      if (allInLevel <= state.current_bet) return "call";
      return "raise";
    }
    default:
      return "check";
  }
}

function actionLogAmount(
  state: HandState,
  seat: number,
  action: Action,
): number {
  const seatState = state.seats.find((s) => s.seat_index === seat)!;
  const C = state.current_bet;
  const committed = seatState.committed_this_street;
  switch (action.type) {
    case "fold":
    case "check":
      return 0;
    case "call":
      return Math.min(C - committed, seatState.stack);
    case "bet":
      return action.amount;
    case "raise":
      return action.to - committed;
    case "allin":
      return seatState.stack;
    default:
      return 0;
  }
}

// --------------------------------------------------------------------------
// Snapshot loading for GET /state
// --------------------------------------------------------------------------

export interface LoadedRoomState {
  room: RoomRow;
  seats: SeatRow[];
  hand: HandRow | null;
  handPlayers: HandPlayerRow[];
}

/** Load the full authoritative room state (room, seats, live hand, players). */
export async function loadRoomState(code: string): Promise<LoadedRoomState | null> {
  const room = await getRoomByCode(code);
  if (!room) return null;
  const seats = await getSeats(room.id);
  let hand: HandRow | null = null;
  let handPlayers: HandPlayerRow[] = [];
  if (room.current_hand_id) {
    hand = await getHandById(room.current_hand_id);
    if (hand) handPlayers = await getHandPlayers(hand.id);
  }
  return { room, seats, hand, handPlayers };
}

/**
 * For GET /state: returns true if the current to_act seat is a BOT (so the read
 * should drive the guarded advance before returning), false on a human turn
 * (pure read). A passed deadline on a human turn also warrants a drive (timeout).
 */
export function shouldDriveOnRead(state: LoadedRoomState): boolean {
  const { hand, seats, room } = state;
  if (!hand || room.status !== "in_hand") return false;
  if (hand.street === "complete") return false;
  if (hand.to_act_seat === null) return true; // round closed -> needs advance
  const seatRow = seats.find((s) => s.seat_index === hand.to_act_seat);
  if (!seatRow) return false;
  if (seatRow.is_bot) return true;
  // Human turn: only drive if the deadline has passed (timeout).
  if (hand.act_deadline !== null && Date.now() > Date.parse(hand.act_deadline)) {
    return true;
  }
  return false;
}
