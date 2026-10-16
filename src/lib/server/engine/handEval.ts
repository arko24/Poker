// Pure 5-to-7 card hand evaluator. Enumerates the C(7,5)=21 five-card
// combinations and keeps the best per compareRanks. No I/O.

import { Card, rankValue, suitOf } from "./cards";

export enum HandCategory {
  HighCard = 1,
  Pair,
  TwoPair,
  Trips,
  Straight,
  Flush,
  FullHouse,
  Quads,
  StraightFlush,
}

export interface HandRank {
  category: HandCategory;
  /** Tiebreak kickers, high-to-low; compared lexicographically. */
  tiebreak: number[];
  bestFive: Card[];
}

/**
 * Score exactly five cards into a HandRank. Internal helper for evaluateBest.
 */
function scoreFive(cards: Card[]): HandRank {
  if (cards.length !== 5) throw new Error("scoreFive requires exactly 5 cards");

  const values = cards.map(rankValue).sort((a, b) => b - a); // high -> low
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  // Count rank occurrences.
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

  // Distinct ranks sorted by (count desc, rank desc) for pair/trips tiebreaks.
  const grouped = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const countPattern = grouped.map((g) => g[1]); // e.g. [3,2] full house
  const groupedRanks = grouped.map((g) => g[0]);

  // Straight detection. Distinct, sorted descending.
  const distinct = [...new Set(values)].sort((a, b) => b - a);
  let straightHigh = 0; // 0 means no straight
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) {
      straightHigh = distinct[0];
    } else if (
      // Wheel: A-2-3-4-5 (ace counts low). distinct desc would be 14,5,4,3,2.
      distinct[0] === 14 &&
      distinct[1] === 5 &&
      distinct[2] === 4 &&
      distinct[3] === 3 &&
      distinct[4] === 2
    ) {
      straightHigh = 5; // five-high straight
    }
  }

  const bestFive = cards.slice();

  if (straightHigh && isFlush) {
    return {
      category: HandCategory.StraightFlush,
      tiebreak: [straightHigh],
      bestFive,
    };
  }
  if (countPattern[0] === 4) {
    // Quads: [quadRank, kicker]
    return {
      category: HandCategory.Quads,
      tiebreak: [groupedRanks[0], groupedRanks[1]],
      bestFive,
    };
  }
  if (countPattern[0] === 3 && countPattern[1] === 2) {
    return {
      category: HandCategory.FullHouse,
      tiebreak: [groupedRanks[0], groupedRanks[1]],
      bestFive,
    };
  }
  if (isFlush) {
    return { category: HandCategory.Flush, tiebreak: values, bestFive };
  }
  if (straightHigh) {
    return {
      category: HandCategory.Straight,
      tiebreak: [straightHigh],
      bestFive,
    };
  }
  if (countPattern[0] === 3) {
    // Trips: [tripRank, kicker1, kicker2]
    return {
      category: HandCategory.Trips,
      tiebreak: groupedRanks,
      bestFive,
    };
  }
  if (countPattern[0] === 2 && countPattern[1] === 2) {
    // Two pair: [highPair, lowPair, kicker]
    return {
      category: HandCategory.TwoPair,
      tiebreak: groupedRanks,
      bestFive,
    };
  }
  if (countPattern[0] === 2) {
    // One pair: [pairRank, k1, k2, k3]
    return {
      category: HandCategory.Pair,
      tiebreak: groupedRanks,
      bestFive,
    };
  }
  // High card.
  return { category: HandCategory.HighCard, tiebreak: values, bestFive };
}

/** Compare two tiebreak arrays lexicographically; returns >0, 0, <0. */
function compareTiebreak(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Compare two ranks: >0 if a beats b, 0 if tie, <0 if b beats a. */
export function compareRanks(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  return compareTiebreak(a.tiebreak, b.tiebreak);
}

/** All C(n,5) index combinations. */
function combinations5(n: number): number[][] {
  const result: number[][] = [];
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) result.push([a, b, c, d, e]);
  return result;
}

/**
 * Evaluate the best 5-card hand from 5..7 cards. Pure. Throws on <5 cards.
 */
export function evaluateBest(cards: Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateBest requires 5..7 cards, got ${cards.length}`);
  }
  if (cards.length === 5) return scoreFive(cards);

  let best: HandRank | null = null;
  for (const combo of combinations5(cards.length)) {
    const five = combo.map((i) => cards[i]);
    const rank = scoreFive(five);
    if (best === null || compareRanks(rank, best) > 0) best = rank;
  }
  // combinations5 always yields at least one combo for n>=5.
  return best as HandRank;
}
