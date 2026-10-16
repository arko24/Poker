// Pure card primitives for the poker engine. No I/O other than the optional
// use of Node's crypto.randomBytes for the production (unseeded) shuffle. The
// seedable variant is fully deterministic and is what the unit tests exercise.
//
// A Card is a two-char string: rank (2-9,T,J,Q,K,A) + suit (s,h,d,c), e.g. "Ah".

import { randomBytes } from "crypto";

export type Card = string;

export const RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
] as const;

export const SUITS = ["s", "h", "d", "c"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];

/** Numeric rank value, 2..14 (ace high). Used by the evaluator. */
export function rankValue(card: Card): number {
  const r = card[0];
  const idx = RANKS.indexOf(r as Rank);
  if (idx < 0) throw new Error(`invalid card rank: ${card}`);
  return idx + 2; // "2" -> 2 ... "A" -> 14
}

export function suitOf(card: Card): Suit {
  const s = card[1];
  if (!SUITS.includes(s as Suit)) throw new Error(`invalid card suit: ${card}`);
  return s as Suit;
}

/** Build an ordered 52-card deck. Pure. */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}

/**
 * A random-number source returning a uniform integer in [0, max). The crypto
 * source draws from Node's CSPRNG; the seeded source is a deterministic PRNG.
 */
export type RandomInt = (maxExclusive: number) => number;

/** Crypto-backed uniform integer source (rejection-sampled, unbiased). */
export const cryptoRandomInt: RandomInt = (maxExclusive: number): number => {
  if (maxExclusive <= 0) throw new Error("maxExclusive must be > 0");
  if (maxExclusive === 1) return 0;
  // Rejection sampling over whole bytes to avoid modulo bias.
  const bytesNeeded = Math.ceil(Math.log2(maxExclusive) / 8);
  const maxValid = Math.floor(256 ** bytesNeeded / maxExclusive) * maxExclusive;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const buf = randomBytes(bytesNeeded);
    let value = 0;
    for (let i = 0; i < bytesNeeded; i++) {
      value = value * 256 + buf[i];
    }
    if (value < maxValid) return value % maxExclusive;
  }
};

/**
 * Deterministic PRNG (mulberry32) -> RandomInt. Same seed yields the same
 * sequence, so shuffles are reproducible in tests. Pure given its seed.
 */
export function seededRandomInt(seed: number): RandomInt {
  let state = seed >>> 0;
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (maxExclusive: number): number => {
    if (maxExclusive <= 0) throw new Error("maxExclusive must be > 0");
    return Math.floor(next() * maxExclusive);
  };
}

/**
 * Fisher-Yates shuffle returning a new array (does not mutate the input).
 * `rng` defaults to the crypto source; pass a seeded source for determinism.
 */
export function shuffle(deck: Card[], rng: RandomInt = cryptoRandomInt): Card[] {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Convenience: a freshly built, shuffled deck. */
export function freshShuffledDeck(rng: RandomInt = cryptoRandomInt): Card[] {
  return shuffle(buildDeck(), rng);
}
