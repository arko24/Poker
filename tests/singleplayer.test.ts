// Single-player end-to-end verification (pure-engine integration variant).
//
// No Postgres test schema is reachable in this environment, so this drives a
// FULL hand through the pure engine exactly as the orchestrator does — deal ->
// preflop/flop/turn/river betting with bot actions -> showdown/fold-out ->
// payout — using a seeded deck, and asserts chip conservation and a legal
// terminal state. The DB-backed variant (tests/singleplayer.test.ts driving the
// real orchestrator RPCs) is noted as CI/manual-gated in FEAT-003 findings.
//
// It threads the SAME helpers the orchestrator uses: applyAction/advance/nextToAct
// from the engine, decide() from the bot, and evaluateShowdown() exported from
// the orchestrator (the pure part of its showdown logic).

import { describe, it, expect } from "vitest";
import { freshShuffledDeck, seededRandomInt, Card } from "@/lib/server/engine/cards";
import { HandState, SeatState, advance } from "@/lib/server/engine/handState";
import {
  Action,
  applyAction,
  legalActions,
  nextToAct,
} from "@/lib/server/engine/betting";
import { decide, BotView } from "@/lib/server/engine/bot";
import { evaluateShowdown } from "@/lib/server/orchestrator";

interface TableSeat {
  seat_index: number;
  isBot: boolean;
  startStack: number;
}

/** Total chips in play (stacks + committed) — must be invariant across a hand. */
function totalChips(state: HandState): number {
  return state.seats.reduce(
    (sum, s) => sum + s.stack + s.total_committed,
    0,
  );
}

/**
 * Set up a heads-up single-player hand (human seat 0 + one bot seat 1) with a
 * seeded deck, blinds posted, and the first actor chosen. Mirrors the
 * orchestrator's startHand blind/deal logic (without the DB).
 */
function setupHand(
  seats: TableSeat[],
  deck: Card[],
  smallBlind: number,
  bigBlind: number,
  button: number,
): { state: HandState; holeBySeat: Map<number, Card[]> } {
  const indexes = seats.map((s) => s.seat_index).sort((a, b) => a - b);
  const nextCw = (from: number): number =>
    indexes[(indexes.indexOf(from) + 1) % indexes.length];

  // Heads-up: button posts SB, other posts BB.
  const sbSeat = button;
  const bbSeat = nextCw(button);

  // Deal 2 hole cards each.
  const d = deck.slice();
  const holeBySeat = new Map<number, Card[]>();
  for (const s of seats) holeBySeat.set(s.seat_index, []);
  for (let r = 0; r < 2; r++) {
    for (const s of seats) holeBySeat.get(s.seat_index)!.push(d.shift()!);
  }

  const stack = new Map(seats.map((s) => [s.seat_index, s.startStack]));
  const committed = new Map(seats.map((s) => [s.seat_index, 0]));
  const status = new Map<number, SeatState["status"]>(
    seats.map((s) => [s.seat_index, "in"]),
  );
  const post = (seat: number, amt: number): void => {
    const posted = Math.min(amt, stack.get(seat)!);
    stack.set(seat, stack.get(seat)! - posted);
    committed.set(seat, committed.get(seat)! + posted);
    if (stack.get(seat) === 0) status.set(seat, "allin");
  };
  post(sbSeat, smallBlind);
  post(bbSeat, bigBlind);

  const currentBet = Math.max(committed.get(sbSeat)!, committed.get(bbSeat)!);

  const seatStates: SeatState[] = seats.map((s) => ({
    seat_index: s.seat_index,
    stack: stack.get(s.seat_index)!,
    committed_this_street: committed.get(s.seat_index)!,
    total_committed: committed.get(s.seat_index)!,
    status: status.get(s.seat_index)!,
    has_acted_this_street: false,
    is_button: s.seat_index === button,
  }));

  const state: HandState = {
    street: "preflop",
    board: [],
    deck: d,
    seats: seatStates,
    button_seat: button,
    small_blind: smallBlind,
    big_blind: bigBlind,
    current_bet: currentBet,
    min_raise: bigBlind,
    last_aggressor_seat: null,
    to_act_seat: null,
    action_seq: 0,
    act_deadline: null,
    turn_timeout_secs: 30,
  };
  state.to_act_seat = nextToAct(state);
  return { state, holeBySeat };
}

/** Choose a human action deterministically: call if possible, else check/fold. */
function humanAction(state: HandState, seat: number): Action {
  const legal = legalActions(state, seat);
  if (legal.some((a) => a.type === "check")) return { type: "check" };
  if (legal.some((a) => a.type === "call")) return { type: "call" };
  return { type: "fold" };
}

function botAction(
  state: HandState,
  seat: number,
  holeBySeat: Map<number, Card[]>,
  seed: number,
): Action {
  const seatState = state.seats.find((s) => s.seat_index === seat)!;
  const pot = state.seats.reduce((sum, s) => sum + s.total_committed, 0);
  const toCall = Math.max(0, state.current_bet - seatState.committed_this_street);
  const activeOpponents = state.seats.filter(
    (s) => s.seat_index !== seat && (s.status === "in" || s.status === "allin"),
  ).length;
  const view: BotView = {
    holeCards: holeBySeat.get(seat) ?? [],
    board: state.board,
    pot,
    toCall,
    stack: seatState.stack,
    legalActions: legalActions(state, seat),
    activeOpponents,
  };
  return decide(view, seed >>> 0);
}

/**
 * Drive a full hand to a terminal state ('complete' fold-out or 'showdown'),
 * mirroring the orchestrator's loop: apply the current actor's action, then
 * advance; repeat. Returns the terminal state.
 */
function playToTerminal(
  seats: TableSeat[],
  state: HandState,
  holeBySeat: Map<number, Card[]>,
): HandState {
  let s = state;
  let iterations = 0;
  const botSeats = new Set(seats.filter((t) => t.isBot).map((t) => t.seat_index));

  while (s.street !== "complete" && s.street !== "showdown") {
    iterations++;
    if (iterations > 500) throw new Error("loop did not terminate");

    const toAct = s.to_act_seat;
    if (toAct === null) {
      s = advance(s);
      continue;
    }
    const action = botSeats.has(toAct)
      ? botAction(s, toAct, holeBySeat, iterations * 7919 + toAct)
      : humanAction(s, toAct);
    s = applyAction(s, toAct, action);
    s = advance(s);
  }
  return s;
}

describe("single-player full hand (pure-engine integration)", () => {
  it("plays deal -> betting -> terminal with chip conservation and a legal end state", () => {
    const seats: TableSeat[] = [
      { seat_index: 0, isBot: false, startStack: 1000 },
      { seat_index: 1, isBot: true, startStack: 1000 },
    ];
    const deck = freshShuffledDeck(seededRandomInt(12345));
    const { state, holeBySeat } = setupHand(seats, deck, 10, 20, 0);

    const startTotal = 2000;
    expect(totalChips(state)).toBe(startTotal);

    const terminal = playToTerminal(seats, state, holeBySeat);

    // Terminal state must be legal.
    expect(["complete", "showdown"]).toContain(terminal.street);

    // Chips are conserved across the whole hand (stacks + committed constant).
    expect(totalChips(terminal)).toBe(startTotal);

    // Award the pot and assert stacks + winnings still conserve the chips.
    const { payouts, wasShowdown, revealedSeats } = evaluateShowdown(
      terminal,
      holeBySeat,
    );
    const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
    const potTotal = terminal.seats.reduce((sum, s) => sum + s.total_committed, 0);
    expect(paid).toBe(potTotal);

    // After crediting payouts, every chip is back in a stack.
    const finalStacks = new Map(
      terminal.seats.map((s) => [s.seat_index, s.stack]),
    );
    for (const p of payouts) {
      finalStacks.set(p.seat_index, finalStacks.get(p.seat_index)! + p.amount);
    }
    const finalTotal = [...finalStacks.values()].reduce((a, b) => a + b, 0);
    expect(finalTotal).toBe(startTotal);

    // Reveal rule sanity: fold-out reveals nothing; showdown reveals contenders.
    if (!wasShowdown) {
      expect(revealedSeats).toEqual([]);
    } else {
      expect(revealedSeats.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("runs many seeded hands to showdown/fold-out, always conserving chips", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const seats: TableSeat[] = [
        { seat_index: 0, isBot: false, startStack: 500 },
        { seat_index: 1, isBot: true, startStack: 500 },
      ];
      const deck = freshShuffledDeck(seededRandomInt(seed));
      const { state, holeBySeat } = setupHand(seats, deck, 5, 10, seed % 2);
      const terminal = playToTerminal(seats, state, holeBySeat);

      expect(["complete", "showdown"]).toContain(terminal.street);
      expect(totalChips(terminal)).toBe(1000);

      const { payouts } = evaluateShowdown(terminal, holeBySeat);
      const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
      const potTotal = terminal.seats.reduce(
        (sum, s) => sum + s.total_committed,
        0,
      );
      expect(paid).toBe(potTotal);
    }
  });

  it("awards a three-way all-in with layered side pots (orchestrator eval path)", () => {
    // Three players all-in for three different amounts; board run out. Exercises
    // the multi-level side-pot path evaluateShowdown shares with the orchestrator.
    const seatStates: SeatState[] = [
      {
        seat_index: 0,
        stack: 0,
        committed_this_street: 0,
        total_committed: 100,
        status: "allin",
        has_acted_this_street: true,
        is_button: true,
      },
      {
        seat_index: 1,
        stack: 0,
        committed_this_street: 0,
        total_committed: 200,
        status: "allin",
        has_acted_this_street: true,
        is_button: false,
      },
      {
        seat_index: 2,
        stack: 0,
        committed_this_street: 0,
        total_committed: 300,
        status: "allin",
        has_acted_this_street: true,
        is_button: false,
      },
    ];
    const state: HandState = {
      street: "showdown",
      board: ["2c", "7d", "9h", "Js", "4c"],
      deck: [],
      seats: seatStates,
      button_seat: 0,
      small_blind: 5,
      big_blind: 10,
      current_bet: 0,
      min_raise: 10,
      last_aggressor_seat: null,
      to_act_seat: null,
      action_seq: 10,
      act_deadline: null,
      turn_timeout_secs: 30,
    };
    const holeBySeat = new Map<number, Card[]>([
      [0, ["Ah", "Ad"]], // best hand (pair of aces)
      [1, ["Kh", "Kd"]], // second (pair of kings)
      [2, ["Qh", "Qd"]], // third (pair of queens)
    ]);

    const { payouts, awards } = evaluateShowdown(state, holeBySeat);
    const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
    expect(paid).toBe(600); // all committed chips awarded
    // Main pot (100*3=300, eligible 0/1/2) -> AA (seat 0).
    // Side pot 1 (100*2=200, eligible 1/2) -> KK (seat 1).
    // Side pot 2 (100, eligible only seat 2) -> seat 2 uncontested.
    const seat0 = payouts.find((p) => p.seat_index === 0)?.amount ?? 0;
    expect(seat0).toBe(300);
    const seat1 = payouts.find((p) => p.seat_index === 1)?.amount ?? 0;
    expect(seat1).toBe(200);
    const seat2 = payouts.find((p) => p.seat_index === 2)?.amount ?? 0;
    expect(seat2).toBe(100);
    expect(awards.length).toBe(3);
  });
});
