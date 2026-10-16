// Pure betting-round logic: seat ordering, legal-action computation, and
// applyAction with round-reopen bookkeeping. No I/O.

import { HandState, SeatState } from "./handState";

export type Action =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "bet"; amount: number } // chips added this action (current_bet===0 street)
  | { type: "raise"; to: number } // target committed_this_street level
  | { type: "allin" }; // push entire remaining stack

export type LegalAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call"; amount: number } // chips the actor must add (may be all-in-for-less)
  | { type: "bet"; min: number; max: number } // only when current_bet===0
  | { type: "raise"; min: number; max: number } // raise-TO levels
  | { type: "allin"; amount: number }; // all remaining stack

function seatOf(state: HandState, seatIndex: number): SeatState {
  const s = state.seats.find((x) => x.seat_index === seatIndex);
  if (!s) throw new Error(`seat ${seatIndex} not in hand`);
  return s;
}

/** Seats that can still take a voluntary action: status 'in' with stack > 0. */
function canAct(seat: SeatState): boolean {
  return seat.status === "in";
}

/**
 * Walk clockwise (increasing seat_index, wrapping) from the seat after `from`,
 * returning the first seat matching `pred`, or null.
 */
function walkClockwise(
  state: HandState,
  from: number,
  pred: (s: SeatState) => boolean,
): number | null {
  const indexes = state.seats.map((s) => s.seat_index).sort((a, b) => a - b);
  const n = indexes.length;
  const startPos = indexes.indexOf(from);
  for (let step = 1; step <= n; step++) {
    const idx = indexes[(startPos + step) % n];
    const seat = seatOf(state, idx);
    if (pred(seat)) return idx;
  }
  return null;
}

/** Seats dealt into the hand that still contest (in or allin). */
function liveSeats(state: HandState): SeatState[] {
  return state.seats.filter((s) => s.status === "in" || s.status === "allin");
}

/**
 * True once the current betting round is closed: every 'in' seat has acted and
 * matched current_bet (allin seats are excepted). Returns false if any 'in'
 * seat still owes action.
 */
function roundClosed(state: HandState): boolean {
  const inSeats = state.seats.filter((s) => s.status === "in");
  // With one or zero seats able to act, betting cannot continue.
  for (const s of inSeats) {
    if (!s.has_acted_this_street) return false;
    if (s.committed_this_street !== state.current_bet) return false;
  }
  return true;
}

/**
 * Determine the seat to act next, or null if the street's betting is closed.
 * Handles the heads-up ordering inversion and the big-blind pre-flop option.
 */
export function nextToAct(state: HandState): number | null {
  // No betting if fewer than two seats can act and all bets are matched.
  if (roundClosed(state)) return null;

  // Find the reference seat to start searching from. We search clockwise for
  // the first 'in' seat that still owes action (not acted, or owes chips).
  const owes = (s: SeatState): boolean =>
    s.status === "in" &&
    (!s.has_acted_this_street || s.committed_this_street !== state.current_bet);

  // Determine the start reference per street / table size.
  const live = liveSeats(state);
  const activeCount = live.length;
  const button = state.button_seat;

  let reference: number;
  if (state.street === "preflop") {
    if (activeCount === 2) {
      // Heads-up: button posts SB and acts first pre-flop. Start from the seat
      // before the button so the clockwise walk lands on the button first.
      reference = prevSeatIndex(state, button);
    } else {
      // 3+: UTG (left of BB) acts first. BB = second seat left of button, so
      // UTG = third seat left of button. Start the walk from the BB seat.
      const sb = walkClockwise(state, button, (s) => isDealt(s));
      const bb = sb === null ? null : walkClockwise(state, sb, (s) => isDealt(s));
      reference = bb ?? button;
    }
  } else {
    // Post-flop: first active seat left of the button acts first. Start from
    // the button so the clockwise walk lands on button+1 first.
    reference = button;
  }

  // From the reference, find the first seat (clockwise) that still owes action.
  const found = walkClockwise(state, reference, owes);
  return found;
}

/** The seat_index immediately before `seat` (counter-clockwise), wrapping. */
function prevSeatIndex(state: HandState, seat: number): number {
  const indexes = state.seats.map((s) => s.seat_index).sort((a, b) => a - b);
  const pos = indexes.indexOf(seat);
  return indexes[(pos - 1 + indexes.length) % indexes.length];
}

/** A seat that was dealt into the hand (in / allin / folded, not absent). */
function isDealt(s: SeatState): boolean {
  return s.status === "in" || s.status === "allin" || s.status === "folded";
}

/**
 * Compute the legal actions (with bounds) for `seat`. Throws if it is not the
 * seat's turn. Bounds follow design.md's Finding 6 exactly.
 */
export function legalActions(state: HandState, seatIndex: number): LegalAction[] {
  const seat = seatOf(state, seatIndex);
  if (!canAct(seat)) return [];

  const committed = seat.committed_this_street;
  const stack = seat.stack;
  const C = state.current_bet;
  const out: LegalAction[] = [];

  // fold is always legal on the seat's turn.
  out.push({ type: "fold" });

  if (C === committed) {
    // check legal when nothing is owed.
    out.push({ type: "check" });
  } else {
    // call: owe C - committed, capped at stack (all-in call for less).
    const amount = Math.min(C - committed, stack);
    out.push({ type: "call", amount });
  }

  if (C === 0) {
    // bet legal only when no bet yet this street.
    const min = Math.min(state.big_blind, stack);
    const max = stack;
    if (max > 0) out.push({ type: "bet", min, max });
  } else {
    // raise legal only if the seat can exceed C.
    if (committed + stack > C) {
      const max = committed + stack; // all-in raise-to level
      const min = Math.min(C + state.min_raise, max);
      out.push({ type: "raise", min, max });
    }
  }

  // all-in convenience control whenever the seat has chips.
  if (stack > 0) out.push({ type: "allin", amount: stack });

  return out;
}

/** Reset has_acted for every other 'in' seat (reopening the round). */
function reopenRound(state: HandState, actorSeat: number): void {
  for (const s of state.seats) {
    if (s.seat_index !== actorSeat && s.status === "in") {
      s.has_acted_this_street = false;
    }
  }
}

/**
 * Apply an action to the state, returning a NEW state. Throws on an illegal
 * action/amount. Drives round-reopen bookkeeping (Finding 3), including the
 * all-in short-raise no-reopen rule.
 */
export function applyAction(
  state: HandState,
  seatIndex: number,
  action: Action,
): HandState {
  if (state.to_act_seat !== seatIndex) {
    throw new Error(`not seat ${seatIndex}'s turn`);
  }
  const next: HandState = structuredClone(state);
  const seat = seatOf(next, seatIndex);
  const C = next.current_bet;
  const committed = seat.committed_this_street;

  // Normalize an 'allin' convenience action into bet/call/raise semantics.
  const resolved = resolveAllin(next, seat, action);

  switch (resolved.type) {
    case "fold": {
      seat.status = "folded";
      seat.has_acted_this_street = true;
      break;
    }
    case "check": {
      if (C !== committed) throw new Error("cannot check facing a bet");
      seat.has_acted_this_street = true;
      break;
    }
    case "call": {
      if (C <= committed) throw new Error("nothing to call");
      const amount = Math.min(C - committed, seat.stack);
      commitChips(seat, amount);
      seat.has_acted_this_street = true;
      if (seat.stack === 0) seat.status = "allin";
      break;
    }
    case "bet": {
      if (C !== 0) throw new Error("cannot bet facing a bet");
      const legal = legalActions(next, seatIndex).find((a) => a.type === "bet");
      if (!legal || legal.type !== "bet") throw new Error("bet not legal");
      const amount = resolved.amount;
      if (amount < legal.min || amount > legal.max) {
        throw new Error(`bet amount ${amount} out of bounds`);
      }
      commitChips(seat, amount);
      const newLevel = seat.committed_this_street;
      next.current_bet = newLevel;
      next.min_raise = newLevel; // from 0, the raise increment is the bet size
      next.last_aggressor_seat = seatIndex;
      seat.has_acted_this_street = true;
      if (seat.stack === 0) seat.status = "allin";
      reopenRound(next, seatIndex);
      break;
    }
    case "raise": {
      if (C === 0) throw new Error("cannot raise with no bet");
      const legal = legalActions(next, seatIndex).find((a) => a.type === "raise");
      if (!legal || legal.type !== "raise") throw new Error("raise not legal");
      const to = resolved.to;
      if (to < legal.min || to > legal.max) {
        throw new Error(`raise-to ${to} out of bounds`);
      }
      const addNeeded = to - committed;
      commitChips(seat, addNeeded);
      const newLevel = seat.committed_this_street; // === to
      const increment = newLevel - C;
      const isAllin = seat.stack === 0;
      const isFullRaise = increment >= next.min_raise;

      // current_bet always rises to the new highest level.
      next.current_bet = newLevel;
      seat.has_acted_this_street = true;
      if (isAllin) seat.status = "allin";

      if (isFullRaise) {
        // Full legal raise: new min_raise = increment, new aggressor, reopen.
        next.min_raise = increment;
        next.last_aggressor_seat = seatIndex;
        reopenRound(next, seatIndex);
      } else {
        // All-in short raise: current_bet rose (above), but min_raise and
        // last_aggressor_seat are UNCHANGED and already-acted seats are NOT
        // reset. Only seats that have not yet acted may still full-raise.
        // (We intentionally do nothing else here.)
        if (!isAllin) {
          // A non-all-in short raise is illegal and should have been rejected
          // by the bounds check above; guard defensively.
          throw new Error("short raise below min_raise not allowed");
        }
      }
      break;
    }
    default:
      throw new Error(`unknown action`);
  }

  seat.total_committed += 0; // no-op; total updated inside commitChips
  return next;
}

/** Move `amount` chips from stack into committed counters. */
function commitChips(seat: SeatState, amount: number): void {
  if (amount < 0) throw new Error("negative commit");
  if (amount > seat.stack) throw new Error("commit exceeds stack");
  seat.stack -= amount;
  seat.committed_this_street += amount;
  seat.total_committed += amount;
}

/**
 * Resolve an {type:'allin'} convenience action into the concrete bet/call/raise
 * it represents given the current bet. Other action types pass through.
 */
function resolveAllin(
  state: HandState,
  seat: SeatState,
  action: Action,
): Action {
  if (action.type !== "allin") return action;
  const C = state.current_bet;
  const committed = seat.committed_this_street;
  const allInLevel = committed + seat.stack;
  if (seat.stack === 0) throw new Error("no chips to go all-in");
  if (C === 0) {
    return { type: "bet", amount: seat.stack };
  }
  if (allInLevel <= C) {
    // all-in for less than the current bet -> a call for less.
    return { type: "call" };
  }
  return { type: "raise", to: allInLevel };
}
