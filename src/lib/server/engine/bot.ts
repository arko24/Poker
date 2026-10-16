// Pure server-side bot policy. decide(view, seed) -> Action. No I/O.
//
// Strength is estimated from the current made hand (handEval) plus a cheap,
// capped Monte-Carlo equity for incomplete boards. Pot odds drive fold/call;
// strong hands raise with slight seeded randomization so play is not fully
// deterministic yet is reproducible under a fixed seed for tests.

import { Card, buildDeck, seededRandomInt } from "./cards";
import { evaluateBest, compareRanks } from "./handEval";
import { Action, LegalAction } from "./betting";

/**
 * The information a bot is allowed to act on. The orchestrator builds this from
 * the server's full state (the bot sees its OWN hole cards only).
 */
export interface BotView {
  holeCards: Card[]; // the bot's two hole cards
  board: Card[]; // 0, 3, 4, or 5 community cards
  /** Chips in the pot (all committed chips this hand). */
  pot: number;
  /** Chips the bot must add to call (0 if it can check). */
  toCall: number;
  /** The bot's remaining stack. */
  stack: number;
  /** Legal actions with bounds, as computed by legalActions for this seat. */
  legalActions: LegalAction[];
  /** Number of opponents still contesting the pot (status in/allin, not self). */
  activeOpponents: number;
}

/** Monte-Carlo sample cap. A bounded constant keeps decide() fast. */
const MC_SAMPLES = 200;

/**
 * Estimate the bot's win equity (fraction, 0..1) via capped Monte-Carlo.
 * Opponents are dealt random hole cards and the remaining board is completed.
 * With a complete board this collapses to a direct showdown estimate.
 */
export function estimateEquity(
  holeCards: Card[],
  board: Card[],
  activeOpponents: number,
  seed: number,
): number {
  const rng = seededRandomInt(seed);
  const known = new Set<Card>([...holeCards, ...board]);
  const remaining = buildDeck().filter((c) => !known.has(c));
  const opps = Math.max(1, activeOpponents);

  let wins = 0;
  let ties = 0;
  const samples = MC_SAMPLES;

  for (let i = 0; i < samples; i++) {
    // Shuffle a working copy of the remaining deck (seeded, partial).
    const pool = remaining.slice();
    // Fisher-Yates partial draw.
    const draw = (count: number): Card[] => {
      const picked: Card[] = [];
      for (let k = 0; k < count; k++) {
        const j = rng(pool.length);
        picked.push(pool[j]);
        pool[j] = pool[pool.length - 1];
        pool.pop();
      }
      return picked;
    };

    const needBoard = 5 - board.length;
    const fullBoard = [...board, ...draw(needBoard)];
    const heroRank = evaluateBest([...holeCards, ...fullBoard]);

    let heroBeatsAll = true;
    let tiedBest = false;
    for (let o = 0; o < opps; o++) {
      const oppHole = draw(2);
      const oppRank = evaluateBest([...oppHole, ...fullBoard]);
      const cmp = compareRanks(heroRank, oppRank);
      if (cmp < 0) {
        heroBeatsAll = false;
        break;
      }
      if (cmp === 0) tiedBest = true;
    }
    if (heroBeatsAll) {
      if (tiedBest) ties += 1;
      else wins += 1;
    }
  }
  return (wins + ties * 0.5) / samples;
}

/**
 * Decide an action. Deterministic for a fixed seed. Strategy:
 *  - Compute equity vs the field.
 *  - If facing a bet: compare equity to pot odds. Fold when clearly behind,
 *    call when roughly priced in, raise when strong (equity high).
 *  - If no bet to call: check normally, but bet/raise with strong equity.
 */
export function decide(view: BotView, seed: number): Action {
  const legal = view.legalActions;
  const can = (t: LegalAction["type"]): boolean =>
    legal.some((a) => a.type === t);

  const equity = estimateEquity(
    view.holeCards,
    view.board,
    view.activeOpponents,
    seed,
  );

  // Small seeded jitter so decisions near thresholds vary but reproducibly.
  const rng = seededRandomInt(seed ^ 0x9e3779b9);
  const jitter = (rng(1000) / 1000) * 0.1 - 0.05; // [-0.05, 0.05)
  const strength = Math.max(0, Math.min(1, equity + jitter));

  const facingBet = view.toCall > 0;

  if (!facingBet) {
    // No bet to call. Raise/bet with strong hands, else check.
    if (strength >= 0.68) {
      const raise = legal.find((a) => a.type === "raise");
      if (raise && raise.type === "raise") {
        // Size: toward the smaller end for medium, larger for very strong.
        const span = raise.max - raise.min;
        const frac = strength >= 0.85 ? 0.6 : 0.25;
        const to = Math.round(raise.min + span * frac);
        return { type: "raise", to };
      }
      const bet = legal.find((a) => a.type === "bet");
      if (bet && bet.type === "bet") {
        const span = bet.max - bet.min;
        const frac = strength >= 0.85 ? 0.6 : 0.25;
        const amount = Math.round(bet.min + span * frac);
        return { type: "bet", amount };
      }
    }
    if (can("check")) return { type: "check" };
    // No check available (shouldn't happen when not facing a bet) -> fold.
    return { type: "fold" };
  }

  // Facing a bet: pot odds = toCall / (pot + toCall).
  const potOdds = view.toCall / (view.pot + view.toCall);

  // Clear raise with very strong hands.
  if (strength >= 0.8) {
    const raise = legal.find((a) => a.type === "raise");
    if (raise && raise.type === "raise") {
      const span = raise.max - raise.min;
      const to = Math.round(raise.min + span * (strength >= 0.9 ? 0.6 : 0.3));
      return { type: "raise", to };
    }
  }

  // Call when priced in (equity exceeds pot odds, with a small margin).
  if (strength >= potOdds) {
    if (can("call")) return { type: "call" };
    if (can("check")) return { type: "check" };
  }

  // Otherwise fold if facing a bet, else check.
  if (can("check")) return { type: "check" };
  return { type: "fold" };
}
