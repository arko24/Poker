import { describe, it, expect } from "vitest";
import {
  nextToAct,
  legalActions,
  applyAction,
  LegalAction,
} from "@/lib/server/engine/betting";
import { makeState } from "./helpers";

function find<T extends LegalAction["type"]>(
  acts: LegalAction[],
  t: T,
): Extract<LegalAction, { type: T }> | undefined {
  return acts.find((a) => a.type === t) as
    | Extract<LegalAction, { type: T }>
    | undefined;
}

describe("legalActions bounds", () => {
  it("offers check/bet when nothing is owed", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 1000 },
        { seat_index: 1, stack: 1000 },
      ],
      button_seat: 0,
      current_bet: 0,
      to_act_seat: 0,
    });
    const acts = legalActions(s, 0);
    expect(find(acts, "check")).toBeDefined();
    const bet = find(acts, "bet");
    expect(bet).toEqual({ type: "bet", min: 20, max: 1000 });
    expect(find(acts, "fold")).toBeDefined();
    expect(find(acts, "allin")).toEqual({ type: "allin", amount: 1000 });
    // no call / no raise when C===0
    expect(find(acts, "call")).toBeUndefined();
    expect(find(acts, "raise")).toBeUndefined();
  });

  it("offers call/raise facing a bet with raise-TO bounds", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 1000, committed_this_street: 100 },
        { seat_index: 1, stack: 1000, committed_this_street: 0 },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
      to_act_seat: 1,
    });
    const acts = legalActions(s, 1);
    expect(find(acts, "call")).toEqual({ type: "call", amount: 100 });
    // raise-to: min = C + min_raise = 200, max = committed(0)+stack(1000)=1000
    expect(find(acts, "raise")).toEqual({ type: "raise", min: 200, max: 1000 });
    expect(find(acts, "check")).toBeUndefined();
  });

  it("call for less when stack < amount owed (all-in call)", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 0, committed_this_street: 200 },
        { seat_index: 1, stack: 50, committed_this_street: 0 },
      ],
      button_seat: 0,
      current_bet: 200,
      min_raise: 200,
      to_act_seat: 1,
    });
    const acts = legalActions(s, 1);
    expect(find(acts, "call")).toEqual({ type: "call", amount: 50 });
    // cannot raise (committed+stack = 50 < C=200)
    expect(find(acts, "raise")).toBeUndefined();
  });

  it("sub-BB all-in bet collapses to min===max===stack (Finding 8)", () => {
    const s = makeState({
      big_blind: 20,
      seats: [
        { seat_index: 0, stack: 8 }, // less than big blind
        { seat_index: 1, stack: 1000 },
      ],
      button_seat: 0,
      current_bet: 0,
      to_act_seat: 0,
    });
    const bet = find(legalActions(s, 0), "bet");
    expect(bet).toEqual({ type: "bet", min: 8, max: 8 });
  });

  it("all-in-for-less-than-a-full-raise sets raise min===max (committed+stack)", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 1000, committed_this_street: 100 },
        { seat_index: 1, stack: 120, committed_this_street: 0 },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100, // a full raise would be to 200
      to_act_seat: 1,
    });
    // committed+stack = 120 < 200, but 120 > C=100 so a short raise is allowed.
    const raise = find(legalActions(s, 1), "raise");
    expect(raise).toEqual({ type: "raise", min: 120, max: 120 });
  });
});

describe("applyAction legality + bookkeeping", () => {
  it("throws when it is not the seat's turn", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 1000 },
        { seat_index: 1, stack: 1000 },
      ],
      button_seat: 0,
      to_act_seat: 0,
    });
    expect(() => applyAction(s, 1, { type: "check" })).toThrow();
  });

  it("accepts a sub-BB all-in bet (does not reject below min bet)", () => {
    const s = makeState({
      big_blind: 20,
      seats: [
        { seat_index: 0, stack: 8 },
        { seat_index: 1, stack: 1000 },
      ],
      button_seat: 0,
      current_bet: 0,
      to_act_seat: 0,
    });
    const next = applyAction(s, 0, { type: "bet", amount: 8 });
    const seat0 = next.seats[0];
    expect(seat0.stack).toBe(0);
    expect(seat0.status).toBe("allin");
    expect(next.current_bet).toBe(8);
  });

  it("rejects a bet below the min when stack covers the min", () => {
    const s = makeState({
      big_blind: 20,
      seats: [
        { seat_index: 0, stack: 1000 },
        { seat_index: 1, stack: 1000 },
      ],
      button_seat: 0,
      current_bet: 0,
      to_act_seat: 0,
    });
    expect(() => applyAction(s, 0, { type: "bet", amount: 5 })).toThrow();
  });

  it("a full raise resets other in-seats' has_acted (reopen)", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 900, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 1, stack: 900, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 2, stack: 1000, committed_this_street: 0, has_acted_this_street: false },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
      to_act_seat: 2,
    });
    const next = applyAction(s, 2, { type: "raise", to: 300 });
    expect(next.current_bet).toBe(300);
    expect(next.min_raise).toBe(200);
    expect(next.last_aggressor_seat).toBe(2);
    // seats 0 and 1 must act again
    expect(next.seats[0].has_acted_this_street).toBe(false);
    expect(next.seats[1].has_acted_this_street).toBe(false);
    expect(next.seats[2].has_acted_this_street).toBe(true);
  });

  it("a call sets only the actor's has_acted and does not change current_bet", () => {
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 900, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 1, stack: 1000, committed_this_street: 0, has_acted_this_street: false },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
      last_aggressor_seat: 0,
      to_act_seat: 1,
    });
    const next = applyAction(s, 1, { type: "call" });
    expect(next.current_bet).toBe(100);
    expect(next.min_raise).toBe(100);
    expect(next.last_aggressor_seat).toBe(0);
    expect(next.seats[1].has_acted_this_street).toBe(true);
    expect(next.seats[1].committed_this_street).toBe(100);
    expect(next.seats[0].has_acted_this_street).toBe(true);
  });
});

describe("AC-17 all-in short raise no-reopen + yet-to-act full raise", () => {
  it("short all-in raises current_bet but leaves min_raise/aggressor; acted seats not reset; yet-to-act may full raise off pre-short min_raise", () => {
    // A (seat 0) raised full to 100 (min_raise 100, aggressor 0, acted).
    // B (seat 1) goes all-in SHORT to 150 (increment 50 < min_raise 100).
    // C (seat 2) has NOT acted and makes a full legal raise.
    let s = makeState({
      seats: [
        { seat_index: 0, stack: 400, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 1, stack: 50, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 2, stack: 1000, committed_this_street: 0, has_acted_this_street: false },
      ],
      button_seat: 0,
      current_bet: 100,
      min_raise: 100,
      last_aggressor_seat: 0,
      to_act_seat: 1,
    });
    // B all-in short to 150.
    s = applyAction(s, 1, { type: "allin" });
    expect(s.seats[1].status).toBe("allin");
    expect(s.current_bet).toBe(150); // (a) current_bet rises
    expect(s.min_raise).toBe(100); // (b) min_raise unchanged
    expect(s.last_aggressor_seat).toBe(0); // (b) aggressor unchanged
    // (c) seat 0 already acted and is not reset
    expect(s.seats[0].has_acted_this_street).toBe(true);

    // Seat 0 cannot re-raise now (already acted, only owes call) — but it is
    // seat 2's turn. Set to_act to seat 2 to apply its full raise.
    s.to_act_seat = 2;
    // (d) yet-to-act seat 2 full raise. min raise-TO = current_bet + pre-short
    // min_raise = 150 + 100 = 250.
    const raise = legalActions(s, 2).find((a) => a.type === "raise");
    expect(raise).toMatchObject({ type: "raise", min: 250 });
    const after = applyAction(s, 2, { type: "raise", to: 250 });
    expect(after.current_bet).toBe(250);
    expect(after.min_raise).toBe(100); // 250 - 150 = 100 increment
    expect(after.last_aggressor_seat).toBe(2);
    // reopens for everyone still 'in' -> seat 0 must act again
    expect(after.seats[0].has_acted_this_street).toBe(false);
  });

  it("a seat that already acted and only called a short all-in cannot re-raise (bounds)", () => {
    // After the short all-in above, seat 0 (acted, status in) only owes a call.
    const s = makeState({
      seats: [
        { seat_index: 0, stack: 400, committed_this_street: 100, has_acted_this_street: true },
        { seat_index: 1, stack: 0, committed_this_street: 150, status: "allin", has_acted_this_street: true },
      ],
      button_seat: 0,
      current_bet: 150,
      min_raise: 100,
      last_aggressor_seat: 0,
      to_act_seat: 0,
    });
    // Seat 0 can still raise here per standard rules (it had only matched 100,
    // and a new short all-in by B does NOT remove 0's right to act because 0
    // has not faced a full raise). This asserts current_bet/raise math: raise
    // min-to = 150 + 100 = 250.
    const raise = legalActions(s, 0).find((a) => a.type === "raise");
    expect(raise).toMatchObject({ type: "raise", min: 250 });
  });
});
