import { describe, it, expect } from "vitest";
import {
  buildPots,
  awardPots,
  awardUncontested,
  PotShare,
} from "@/lib/server/engine/pots";
import { evaluateBest, HandRank } from "@/lib/server/engine/handEval";

function rank(cards: string[]): HandRank {
  return evaluateBest(cards);
}

describe("buildPots", () => {
  it("builds a single pot when everyone committed the same", () => {
    const pots = buildPots([
      { seat: 0, committed: 100, folded: false },
      { seat: 1, committed: 100, folded: false },
      { seat: 2, committed: 100, folded: false },
    ]);
    expect(pots.length).toBe(1);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligibleSeats.sort()).toEqual([0, 1, 2]);
  });

  it("builds one main + one side pot for a single short all-in", () => {
    // Seat 2 all-in for 50; seats 0,1 to 100.
    const pots = buildPots([
      { seat: 0, committed: 100, folded: false },
      { seat: 1, committed: 100, folded: false },
      { seat: 2, committed: 50, folded: false },
    ]);
    expect(pots.length).toBe(2);
    // main pot: 50 * 3 = 150, all three eligible
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligibleSeats.sort()).toEqual([0, 1, 2]);
    // side pot: 50 * 2 = 100, only 0 and 1
    expect(pots[1].amount).toBe(100);
    expect(pots[1].eligibleSeats.sort()).toEqual([0, 1]);
  });

  it("folded contributors add chips but are not eligible", () => {
    const pots = buildPots([
      { seat: 0, committed: 100, folded: false },
      { seat: 1, committed: 100, folded: false },
      { seat: 2, committed: 40, folded: true }, // folded after committing 40
    ]);
    // level 40: 40*3 = 120, eligible 0,1 (2 folded)
    expect(pots[0].amount).toBe(120);
    expect(pots[0].eligibleSeats.sort()).toEqual([0, 1]);
    // level 100: 60*2 = 120, eligible 0,1
    expect(pots[1].amount).toBe(120);
    expect(pots[1].eligibleSeats.sort()).toEqual([0, 1]);
  });

  it("layers multiple side pots across three distinct all-in levels", () => {
    const pots = buildPots([
      { seat: 0, committed: 300, folded: false },
      { seat: 1, committed: 200, folded: false },
      { seat: 2, committed: 100, folded: false },
    ]);
    expect(pots.length).toBe(3);
    expect(pots[0].amount).toBe(300); // 100*3
    expect(pots[0].eligibleSeats.sort()).toEqual([0, 1, 2]);
    expect(pots[1].amount).toBe(200); // 100*2
    expect(pots[1].eligibleSeats.sort()).toEqual([0, 1]);
    expect(pots[2].amount).toBe(100); // 100*1
    expect(pots[2].eligibleSeats.sort()).toEqual([0]);
  });
});

describe("awardPots", () => {
  it("awards a single pot to the best hand", () => {
    const pots: PotShare[] = [{ amount: 300, eligibleSeats: [0, 1] }];
    const ranks = new Map<number, HandRank>([
      [0, rank(["Ah", "Ad", "Kc", "Qs", "Jd"])], // pair of aces
      [1, rank(["Kh", "Kd", "Qc", "Js", "9d"])], // pair of kings
    ]);
    const awards = awardPots(pots, ranks, 0);
    expect(awards).toEqual([{ seat: 0, pot_index: 0, amount: 300 }]);
  });

  it("splits a tied pot and gives the odd chip to first seat left of button", () => {
    const pots: PotShare[] = [{ amount: 101, eligibleSeats: [0, 2] }];
    const same = ["Ah", "Ad", "Kc", "Qs", "Jd"];
    const ranks = new Map<number, HandRank>([
      [0, rank(same)],
      [2, rank(["As", "Ac", "Kh", "Qd", "Jc"])],
    ]);
    // Button at seat 1: first eligible seat left of button is seat 2.
    const awards = awardPots(pots, ranks, 1);
    const bySeat = new Map(awards.map((a) => [a.seat, a.amount]));
    expect(bySeat.get(2)).toBe(51); // odd chip
    expect(bySeat.get(0)).toBe(50);
  });

  it("a single-eligible pot is taken uncontested by that seat", () => {
    const pots: PotShare[] = [{ amount: 100, eligibleSeats: [3] }];
    const ranks = new Map<number, HandRank>([
      [3, rank(["2h", "3d", "4c", "5s", "7d"])],
    ]);
    const awards = awardPots(pots, ranks, 0);
    expect(awards).toEqual([{ seat: 3, pot_index: 0, amount: 100 }]);
  });

  it("AC-16: three all-in for three amounts -> main + two side pots to best eligible", () => {
    // seat 0 committed 300 (best overall), seat 1 committed 200 (second),
    // seat 2 committed 100 (worst). Board run out.
    const pots = buildPots([
      { seat: 0, committed: 300, folded: false },
      { seat: 1, committed: 200, folded: false },
      { seat: 2, committed: 100, folded: false },
    ]);
    const board = ["2c", "7d", "9s", "Jh", "4c"];
    const ranks = new Map<number, HandRank>([
      [0, evaluateBest([...["As", "Ad"], ...board])], // pair of aces (best)
      [1, evaluateBest([...["Ks", "Kd"], ...board])], // pair of kings
      [2, evaluateBest([...["Qs", "Qd"], ...board])], // pair of queens
    ]);
    const awards = awardPots(pots, ranks, 2);
    // main pot (300, all eligible) -> seat 0
    // side pot 1 (200, seats 0,1) -> seat 0
    // side pot 2 (100, seat 0 only) -> seat 0
    // seat 0 wins everything here.
    const total0 = awards
      .filter((a) => a.seat === 0)
      .reduce((s, a) => s + a.amount, 0);
    expect(total0).toBe(600);
    // Now make seat 2 best to exercise the layering split.
    const ranks2 = new Map<number, HandRank>([
      [0, evaluateBest([...["3s", "3d"], ...board])], // trip? no -> two pair-ish low
      [1, evaluateBest([...["Ks", "Kd"], ...board])],
      [2, evaluateBest([...["As", "Ad"], ...board])], // aces (best) but only in main pot
    ]);
    const awards2 = awardPots(pots, ranks2, 2);
    const bySeat = new Map<number, number>();
    for (const a of awards2)
      bySeat.set(a.seat, (bySeat.get(a.seat) ?? 0) + a.amount);
    // main pot (300) -> seat 2 (aces). side pot1 (200, seats 0,1) -> seat1 (kings).
    // side pot2 (100, seat0 only) -> seat 0.
    expect(bySeat.get(2)).toBe(300);
    expect(bySeat.get(1)).toBe(200);
    expect(bySeat.get(0)).toBe(100);
  });
});

describe("awardUncontested (fold-out)", () => {
  it("gives all pot layers to the sole survivor with no ranks consulted", () => {
    const pots: PotShare[] = [
      { amount: 150, eligibleSeats: [0, 1, 2] },
      { amount: 100, eligibleSeats: [0, 1] },
    ];
    const awards = awardUncontested(pots, 1);
    expect(awards).toEqual([
      { seat: 1, pot_index: 0, amount: 150 },
      { seat: 1, pot_index: 1, amount: 100 },
    ]);
  });
});
