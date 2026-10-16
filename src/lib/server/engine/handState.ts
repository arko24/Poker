// Pure HandState type + the PURE street-advance reducer. No I/O.
//
// advance() makes ONLY street/transition decisions. The deck is passed IN as
// part of the state. advance() NEVER evaluates showdown hands and NEVER reads
// or writes the DB — the orchestrator (FEAT-003) owns evaluation + persistence.

import { Card } from "./cards";
import { nextToAct } from "./betting";

export type Street =
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "complete";

export type SeatHandStatus = "in" | "folded" | "allin";

/** Per-seat state within a single hand. Mirrors hand_players + seats.stack. */
export interface SeatState {
  seat_index: number;
  stack: number;
  committed_this_street: number;
  total_committed: number;
  status: SeatHandStatus;
  has_acted_this_street: boolean;
  is_button: boolean;
}

/**
 * The full, server-side hand state. Serializable. The engine never persists it;
 * the orchestrator maps it to/from the DB rows. `deck` holds the remaining
 * undealt cards and is consumed by advance() when dealing the next street.
 * Hole cards are intentionally NOT part of HandState: the reducer never needs
 * them, which keeps advance() incapable of evaluating a showdown.
 */
export interface HandState {
  street: Street;
  board: Card[];
  /** Remaining undealt cards. advance() pops from the front when dealing. */
  deck: Card[];
  seats: SeatState[];
  button_seat: number;
  small_blind: number;
  big_blind: number;
  current_bet: number;
  min_raise: number;
  last_aggressor_seat: number | null;
  to_act_seat: number | null;
  action_seq: number;
  /** ISO timestamp or null; advance() sets it when a human turn opens. */
  act_deadline: string | null;
  turn_timeout_secs: number;
}

/** Seats that were dealt into the hand (not left / sitting out). */
export function dealtInSeats(state: HandState): SeatState[] {
  return state.seats.filter((s) => s.status !== undefined);
}

/** Seats still contesting the pot (not folded). */
function contenders(state: HandState): SeatState[] {
  return state.seats.filter(
    (s) => s.status === "in" || s.status === "allin",
  );
}

/** True when at most one contender remains (everyone else folded). */
function isFoldedOut(state: HandState): boolean {
  return contenders(state).length <= 1;
}

/**
 * True when no further betting is possible because at most one contender still
 * has chips behind and is not all-in (so the rest of the board just runs out).
 */
function noFurtherBetting(state: HandState): boolean {
  const canStillBet = contenders(state).filter(
    (s) => s.status === "in" && s.stack > 0,
  );
  return canStillBet.length <= 1;
}

const STREET_ORDER: Street[] = [
  "preflop",
  "flop",
  "turn",
  "river",
  "showdown",
];

function nextStreet(street: Street): Street {
  const idx = STREET_ORDER.indexOf(street);
  return STREET_ORDER[idx + 1];
}

/** Number of community cards to deal when entering a given street. */
function cardsForStreet(street: Street): number {
  if (street === "flop") return 3;
  if (street === "turn" || street === "river") return 1;
  return 0;
}

function nowPlusSecs(secs: number): string {
  return new Date(Date.now() + secs * 1000).toISOString();
}

/**
 * Open a betting street: reset per-street bookkeeping and choose the first
 * actor via nextToAct. The caller must have already dealt the board cards.
 */
function openStreet(state: HandState): HandState {
  for (const s of state.seats) {
    s.committed_this_street = 0;
    if (s.status === "in") s.has_acted_this_street = false;
  }
  state.current_bet = 0;
  state.min_raise = state.big_blind;
  state.last_aggressor_seat = null;
  const toAct = nextToAct(state);
  state.to_act_seat = toAct;
  state.act_deadline = toAct === null ? null : nowPlusSecs(state.turn_timeout_secs);
  return state;
}

/** Deal `n` cards from the front of the deck onto the board. Mutates state. */
function dealBoard(state: HandState, n: number): void {
  for (let i = 0; i < n; i++) {
    const card = state.deck.shift();
    if (card === undefined) throw new Error("deck exhausted while dealing board");
    state.board.push(card);
  }
}

/**
 * PURE street-advance reducer. Runs after each applied action (and on timeout
 * ticks). Returns a new HandState. Decision order:
 *   1. Fold-out: <=1 contender -> terminate to 'complete' (no evaluation here).
 *   2. Street still open (nextToAct returns a seat) -> set to_act and stop.
 *   3. Street closed, more streets remain -> deal next board, open street.
 *   4. All-but-one all-in (no further betting) -> run out the board, go to
 *      'showdown' (the orchestrator evaluates and awards).
 *   5. River betting closed with >=2 contenders -> 'showdown'.
 */
export function advance(state: HandState): HandState {
  const s: HandState = structuredClone(state);

  // 1. Fold-out — terminate immediately. No hand evaluation here; the
  //    orchestrator calls awardUncontested. We only mark the hand complete.
  if (isFoldedOut(s)) {
    s.street = "complete";
    s.to_act_seat = null;
    s.act_deadline = null;
    return s;
  }

  // Already resolved streets.
  if (s.street === "showdown" || s.street === "complete") {
    s.to_act_seat = null;
    s.act_deadline = null;
    return s;
  }

  // 2. Street still open: hand control to the next actor.
  const toAct = nextToAct(s);
  if (toAct !== null) {
    s.to_act_seat = toAct;
    s.act_deadline = nowPlusSecs(s.turn_timeout_secs);
    return s;
  }

  // Betting on this street is closed.

  // 4. No further betting possible: run out remaining streets with no betting,
  //    then go to showdown (orchestrator evaluates).
  if (noFurtherBetting(s)) {
    // Run out the rest of the board (through the river) with no betting.
    if (s.board.length < 5) {
      dealBoard(s, 5 - s.board.length);
    }
    s.street = "showdown";
    s.to_act_seat = null;
    s.act_deadline = null;
    s.current_bet = 0;
    return s;
  }

  // 3 / 5. Advance to the next street.
  const upcoming = nextStreet(s.street);
  if (upcoming === "showdown") {
    // River betting closed with >=2 contenders.
    s.street = "showdown";
    s.to_act_seat = null;
    s.act_deadline = null;
    return s;
  }

  dealBoard(s, cardsForStreet(upcoming));
  s.street = upcoming;
  return openStreet(s);
}
