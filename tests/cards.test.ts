import { describe, it, expect } from "vitest";
import {
  buildDeck,
  shuffle,
  seededRandomInt,
  rankValue,
  suitOf,
  freshShuffledDeck,
} from "@/lib/server/engine/cards";

describe("cards", () => {
  it("builds a 52-card deck with all unique cards", () => {
    const deck = buildDeck();
    expect(deck.length).toBe(52);
    expect(new Set(deck).size).toBe(52);
  });

  it("includes every rank/suit combination", () => {
    const deck = buildDeck();
    expect(deck).toContain("As");
    expect(deck).toContain("2c");
    expect(deck).toContain("Td");
    expect(deck).toContain("Kh");
  });

  it("rankValue maps 2->2 and A->14", () => {
    expect(rankValue("2c")).toBe(2);
    expect(rankValue("Tc")).toBe(10);
    expect(rankValue("Ac")).toBe(14);
    expect(rankValue("Kc")).toBe(13);
  });

  it("suitOf reads the suit char", () => {
    expect(suitOf("Ah")).toBe("h");
    expect(suitOf("2c")).toBe("c");
  });

  it("shuffle preserves the multiset (same 52 cards)", () => {
    const deck = buildDeck();
    const shuffled = shuffle(deck, seededRandomInt(123));
    expect(shuffled.length).toBe(52);
    expect(new Set(shuffled)).toEqual(new Set(deck));
    // does not mutate input
    expect(deck).toEqual(buildDeck());
  });

  it("seeded shuffle is deterministic for the same seed", () => {
    const a = shuffle(buildDeck(), seededRandomInt(42));
    const b = shuffle(buildDeck(), seededRandomInt(42));
    expect(a).toEqual(b);
  });

  it("different seeds generally yield different orders", () => {
    const a = shuffle(buildDeck(), seededRandomInt(1));
    const b = shuffle(buildDeck(), seededRandomInt(2));
    expect(a).not.toEqual(b);
  });

  it("freshShuffledDeck returns 52 unique cards", () => {
    const d = freshShuffledDeck(seededRandomInt(7));
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
  });
});
