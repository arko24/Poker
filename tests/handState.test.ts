import { describe, it, expect } from "vitest";
import { nextToAct, applyAction } from "@/lib/server/engine/betting";
import { advance } from "@/lib/server/engine/handState";
import { makeState } from "./helpers";

describe("AC-13 nextToAct ordering", () => {
  it("heads-up preflop: button (SB) acts first", () => {
    // Button = seat 0, posts SB (10), BB = seat 1 (20). Preflop, button acts.
    const s = makeState({
      street: "preflop",
      seats: [
        { seat_index: 0, stack: 990, committed_this_street: 10, has_acted_this_street: false },
        { seat_index: 1, stack: 980, committed_this_street: 20, has_acted_this_street: false },
      ],
      button_seat: 0,
      current_bet: 20,
      min_raise: 20,
      to_act_seat: null,
    });
    expect(nextToAct(s)).toBe(0);
  });

  it("heads-up postflop: non-button acts first", () => {
    const s = makeState({
      street: "flop",
      seats: [
        { seat_index: 0, stack: 980, committed_this_street: 0, has_acted_this_street: false },
        { seat_index: 1, stack: 980, committed_this_street: 0, has_acted_this_street: false },
      ],
      button_seat: 0,
      current_bet: 0,
      min_raise: 20,
    });
    expect(nextToAct(s)).toBe(1);
  });

  it("3+ handed preflop: UTG (left of BB) acts first", () => {
    // Button seat 0; SB seat 1; BB seat 2; UTG seat 3 (wraps). 4 seats.
    const s = makeState({
      street: "preflop",
      seats: [
        { seat_index: 0, stack: 1000, committed_this_street: 0 },
        { seat_index: 1, stack: 990, committed_this_street: 10 },
        { seat_index: 2, stack: 980, committed_this_street: 20 },
        { seat_index: 3, stack: 1000, committed_this_street: 0 },
      ],
      button_seat: 0,
      current_bet: 20,
      min_raise: 20,
    });
    expect(nextToAct(s)).toBe(3);
  });

  it("3+ handed postflop: first active seat left of button acts first", () => {
    const s = makeState({
      street: "flop",
      seats: [
        { seat_index: 0, stack: 1000, committed_this_street: 0 },
        { seat_index: 1, stack: 990, committed_this_street: 0 },
        { seat_index: 2, stack: 980, committed_this_street: 0 },
      ],
      button_seat: 0,
      current_bet: 0,
      min_raise: 20,
    });
    expect(nextToAct(s)).toBe(1);
  });

  it("returns null when the round is closed (all acted and matched)", () => {
    const s = makeState({
      street: "flop",
      seats: [
        { seat_index: 0, stack: 900, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 1, stack: 900, committed_this_street: 100, has_acted_this_street: true },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
    });
    expect(nextToAct(s)).toBeNull();
  });

  it("skips folded and all-in seats in the walk", () => {
    const s = makeState({
      street: "flop",
      seats: [
        { seat_index: 0, stack: 0, committed_this_street: 100, status: "allin", has_acted_this_street: true },
        { seat_index: 1, stack: 900, committed_this_street: 0, status: "folded", has_acted_this_street: true },
        { seat_index: 2, stack: 900, committed_this_street: 0, has_acted_this_street: false },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
    });
    // Only seat 2 can act (owes a call).
    expect(nextToAct(s)).toBe(2);
  });
});

describe("AC-14 fold-out termination", () => {
  it("advance marks the hand complete with no reveal when all but one fold", () => {
    const s = makeState({
      street: "flop",
      board: ["2c", "7d", "9s"],
      seats: [
        { seat_index: 0, stack: 900, committed_this_street: 0, total_committed: 100 },
        { seat_index: 1, stack: 900, committed_this_street: 0, total_committed: 100, status: "folded" },
      ],
      button_seat: 0,
      current_bet: 0,
    });
    const next = advance(s);
    expect(next.street).toBe("complete");
    expect(next.to_act_seat).toBeNull();
    expect(next.act_deadline).toBeNull();
    // advance never deals more board or evaluates on a fold-out
    expect(next.board).toEqual(["2c", "7d", "9s"]);
  });
});

describe("advance street progression", () => {
  it("deals the flop and opens betting when preflop closes with 2+ contenders", () => {
    const s = makeState({
      street: "preflop",
      board: [],
      deck: ["Ah", "Kd", "Qc", "Jd", "9s", "4h"],
      seats: [
        { seat_index: 0, stack: 980, committed_this_street: 20, has_acted_this_street: true },
        { seat_index: 1, stack: 980, committed_this_street: 20, has_acted_this_street: true },
      ],
      button_seat: 0,
      current_bet: 20,
      min_raise: 20,
    });
    const next = advance(s);
    expect(next.street).toBe("flop");
    expect(next.board).toEqual(["Ah", "Kd", "Qc"]);
    expect(next.current_bet).toBe(0);
    expect(next.min_raise).toBe(20);
    // post-flop, non-button acts first heads-up
    expect(next.to_act_seat).toBe(1);
    // per-street counters reset
    expect(next.seats[0].committed_this_street).toBe(0);
    expect(next.seats[0].has_acted_this_street).toBe(false);
  });

  it("goes to showdown when river betting closes with 2+ contenders", () => {
    const s = makeState({
      street: "river",
      board: ["Ah", "Kd", "Qc", "Jd", "9s"],
      deck: [],
      seats: [
        { seat_index: 0, stack: 900, committed_this_street: 100, has_acted_this_street: true, total_committed: 100 },
        { seat_index: 1, stack: 900, committed_this_street: 100, has_acted_this_street: true, total_committed: 100 },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
    });
    const next = advance(s);
    expect(next.street).toBe("showdown");
    expect(next.to_act_seat).toBeNull();
  });

  it("runs out the board to showdown when all remaining players are all-in", () => {
    const s = makeState({
      street: "preflop",
      board: [],
      deck: ["Ah", "Kd", "Qc", "Jd", "9s", "4h", "2c"],
      seats: [
        { seat_index: 0, stack: 0, committed_this_street: 500, status: "allin", total_committed: 500, has_acted_this_street: true },
        { seat_index: 1, stack: 0, committed_this_street: 500, status: "allin", total_committed: 500, has_acted_this_street: true },
      ],
      button_seat: 0,
      current_bet: 500,
      min_raise: 500,
    });
    const next = advance(s);
    expect(next.street).toBe("showdown");
    expect(next.board.length).toBe(5);
    expect(next.board).toEqual(["Ah", "Kd", "Qc", "Jd", "9s"]);
    expect(next.to_act_seat).toBeNull();
  });

  it("one player all-in, one still has chips but has called -> run out (no further betting)", () => {
    const s = makeState({
      street: "flop",
      board: ["2c", "7d", "9s"],
      deck: ["Jd", "4h"],
      seats: [
        { seat_index: 0, stack: 0, committed_this_street: 200, status: "allin", total_committed: 200, has_acted_this_street: true },
        { seat_index: 1, stack: 500, committed_this_street: 200, status: "in", total_committed: 200, has_acted_this_street: true },
      ],
      button_seat: 0,
      current_bet: 200,
      min_raise: 200,
    });
    const next = advance(s);
    expect(next.street).toBe("showdown");
    expect(next.board.length).toBe(5);
  });
});

describe("partial-blind-all-in posting (modelled state)", () => {
  it("a seat posting its whole stack as a blind is all-in and can be run out", () => {
    // Seat 1 could only post 15 of a 20 BB -> all-in blind.
    const s = makeState({
      street: "preflop",
      board: [],
      deck: ["Ah", "Kd", "Qc", "Jd", "9s"],
      big_blind: 20,
      seats: [
        { seat_index: 0, stack: 980, committed_this_street: 20, has_acted_this_street: true, total_committed: 20 },
        { seat_index: 1, stack: 0, committed_this_street: 15, status: "allin", has_acted_this_street: true, total_committed: 15 },
      ],
      button_seat: 0,
      current_bet: 20,
      min_raise: 20,
    });
    // Seat 0 has acted and matched; the only contender with chips is seat 0,
    // seat 1 is all-in -> no further betting -> run out to showdown.
    const next = advance(s);
    expect(next.street).toBe("showdown");
    expect(next.board.length).toBe(5);
  });
});

describe("advance purity", () => {
  it("does not mutate the input state", () => {
    const s = makeState({
      street: "preflop",
      board: [],
      deck: ["Ah", "Kd", "Qc"],
      seats: [
        { seat_index: 0, stack: 980, committed_this_street: 20, has_acted_this_street: true },
        { seat_index: 1, stack: 980, committed_this_street: 20, has_acted_this_street: true },
      ],
      button_seat: 0,
      current_bet: 20,
      min_raise: 20,
    });
    const deckBefore = [...s.deck];
    advance(s);
    expect(s.deck).toEqual(deckBefore);
    expect(s.street).toBe("preflop");
    expect(s.board).toEqual([]);
  });
});
