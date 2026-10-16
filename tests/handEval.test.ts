import { describe, it, expect } from "vitest";
import {
  evaluateBest,
  compareRanks,
  HandCategory,
} from "@/lib/server/engine/handEval";

describe("handEval categories", () => {
  it("detects a straight flush", () => {
    const r = evaluateBest(["9h", "8h", "7h", "6h", "5h"]);
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreak[0]).toBe(9);
  });

  it("detects quads over a kicker", () => {
    const r = evaluateBest(["9h", "9d", "9c", "9s", "Kd"]);
    expect(r.category).toBe(HandCategory.Quads);
    expect(r.tiebreak).toEqual([9, 13]);
  });

  it("detects a full house", () => {
    const r = evaluateBest(["9h", "9d", "9c", "Ks", "Kd"]);
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreak).toEqual([9, 13]);
  });

  it("detects a flush (high-to-low kickers)", () => {
    const r = evaluateBest(["Ah", "Jh", "9h", "6h", "3h"]);
    expect(r.category).toBe(HandCategory.Flush);
    expect(r.tiebreak).toEqual([14, 11, 9, 6, 3]);
  });

  it("detects a straight", () => {
    const r = evaluateBest(["9h", "8d", "7c", "6s", "5h"]);
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreak[0]).toBe(9);
  });

  it("detects trips with kickers", () => {
    const r = evaluateBest(["9h", "9d", "9c", "Ks", "2d"]);
    expect(r.category).toBe(HandCategory.Trips);
    expect(r.tiebreak).toEqual([9, 13, 2]);
  });

  it("detects two pair with kicker", () => {
    const r = evaluateBest(["9h", "9d", "Kc", "Ks", "2d"]);
    expect(r.category).toBe(HandCategory.TwoPair);
    expect(r.tiebreak).toEqual([13, 9, 2]);
  });

  it("detects one pair with kickers", () => {
    const r = evaluateBest(["9h", "9d", "Kc", "7s", "2d"]);
    expect(r.category).toBe(HandCategory.Pair);
    expect(r.tiebreak).toEqual([9, 13, 7, 2]);
  });

  it("detects high card", () => {
    const r = evaluateBest(["Ah", "Jd", "9c", "6s", "3d"]);
    expect(r.category).toBe(HandCategory.HighCard);
    expect(r.tiebreak).toEqual([14, 11, 9, 6, 3]);
  });
});

describe("handEval straights edge cases", () => {
  it("handles the wheel A-2-3-4-5 as a five-high straight", () => {
    const r = evaluateBest(["Ah", "2d", "3c", "4s", "5h"]);
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreak[0]).toBe(5);
  });

  it("handles the ace-high (Broadway) straight", () => {
    const r = evaluateBest(["Ah", "Kd", "Qc", "Js", "Th"]);
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreak[0]).toBe(14);
  });

  it("wheel straight flush is five-high (steel wheel)", () => {
    const r = evaluateBest(["Ah", "2h", "3h", "4h", "5h"]);
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreak[0]).toBe(5);
  });

  it("a wheel straight loses to a six-high straight", () => {
    const wheel = evaluateBest(["Ah", "2d", "3c", "4s", "5h"]);
    const six = evaluateBest(["6h", "2d", "3c", "4s", "5h"]);
    expect(compareRanks(six, wheel)).toBeGreaterThan(0);
  });
});

describe("handEval category ordering", () => {
  it("flush beats a straight", () => {
    const flush = evaluateBest(["Ah", "Jh", "9h", "6h", "3h"]);
    const straight = evaluateBest(["9h", "8d", "7c", "6s", "5h"]);
    expect(compareRanks(flush, straight)).toBeGreaterThan(0);
  });

  it("full house beats a flush", () => {
    const fh = evaluateBest(["9h", "9d", "9c", "Ks", "Kd"]);
    const flush = evaluateBest(["Ah", "Jh", "9h", "6h", "3h"]);
    expect(compareRanks(fh, flush)).toBeGreaterThan(0);
  });

  it("straight flush beats quads", () => {
    const sf = evaluateBest(["9h", "8h", "7h", "6h", "5h"]);
    const quads = evaluateBest(["9h", "9d", "9c", "9s", "Kd"]);
    expect(compareRanks(sf, quads)).toBeGreaterThan(0);
  });
});

describe("handEval best-5-of-7 selection", () => {
  it("picks the flush out of 7 cards", () => {
    // Hole + board giving a flush plus noise.
    const r = evaluateBest(["Ah", "Kh", "Qh", "7h", "2h", "3c", "4d"]);
    expect(r.category).toBe(HandCategory.Flush);
    expect(r.tiebreak).toEqual([14, 13, 12, 7, 2]);
    expect(r.bestFive.length).toBe(5);
    // best five are all hearts
    expect(r.bestFive.every((c) => c[1] === "h")).toBe(true);
  });

  it("picks the best straight across 7 cards (ignores lower kickers)", () => {
    const r = evaluateBest(["9c", "8d", "7h", "6s", "5c", "2d", "2h"]);
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreak[0]).toBe(9);
  });

  it("picks quads + best kicker from 7 cards", () => {
    const r = evaluateBest(["9c", "9d", "9h", "9s", "Kd", "Qc", "2h"]);
    expect(r.category).toBe(HandCategory.Quads);
    expect(r.tiebreak).toEqual([9, 13]);
  });

  it("chooses full house over trips+pair ambiguity correctly", () => {
    const r = evaluateBest(["Ac", "Ad", "Ah", "Kc", "Kd", "3h", "2s"]);
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreak).toEqual([14, 13]);
  });
});

describe("compareRanks ties", () => {
  it("identical five-card hands tie", () => {
    const a = evaluateBest(["Ah", "Kd", "Qc", "Js", "Th"]);
    const b = evaluateBest(["As", "Kh", "Qd", "Jc", "Td"]);
    expect(compareRanks(a, b)).toBe(0);
  });

  it("same category differing kicker breaks the tie", () => {
    const a = evaluateBest(["9h", "9d", "Kc", "7s", "2d"]);
    const b = evaluateBest(["9h", "9d", "Kc", "6s", "2d"]);
    expect(compareRanks(a, b)).toBeGreaterThan(0);
  });
});
