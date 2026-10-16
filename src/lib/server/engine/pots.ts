// Pure pot & side-pot construction and award. No I/O.
//
// buildPots layers contributions by distinct commit level. Folded players still
// contribute chips to the pots but are never eligible to win. awardPots splits
// ties and assigns the odd chip to the first eligible seat left of the button.
// awardUncontested is the dedicated fold-out path and consults no ranks.

import { HandRank, compareRanks } from "./handEval";

export interface PotShare {
  amount: number;
  eligibleSeats: number[];
}

export interface Contribution {
  seat: number;
  committed: number;
  folded: boolean;
}

export interface Award {
  seat: number;
  pot_index: number;
  amount: number;
}

/**
 * Build main + side pots from each contender's total committed chips. Pots are
 * layered at each distinct positive commit level; a seat is eligible for a pot
 * layer only if it reached that layer's level AND did not fold.
 */
export function buildPots(contributions: Contribution[]): PotShare[] {
  // Distinct positive levels, ascending.
  const levels = [
    ...new Set(
      contributions.map((c) => c.committed).filter((amt) => amt > 0),
    ),
  ].sort((a, b) => a - b);

  const pots: PotShare[] = [];
  let prev = 0;
  for (const level of levels) {
    const layerWidth = level - prev;
    let amount = 0;
    const eligibleSeats: number[] = [];
    for (const c of contributions) {
      if (c.committed > prev) {
        // This seat contributes to this layer: min(layerWidth, remaining).
        amount += Math.min(layerWidth, c.committed - prev);
        // Eligible only if it covered the full layer AND is not folded.
        if (c.committed >= level && !c.folded) eligibleSeats.push(c.seat);
      }
    }
    if (amount > 0) {
      pots.push({ amount, eligibleSeats });
    }
    prev = level;
  }
  return pots;
}

/**
 * Order eligible seats clockwise starting from the first seat left of the
 * button (button+1, wrapping). Used for the deterministic odd-chip rule.
 */
function seatsLeftOfButton(seats: number[], buttonSeat: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  // Rotate so the first entry is the lowest seat strictly greater than button,
  // wrapping around if none is greater.
  const after = sorted.filter((s) => s > buttonSeat);
  const beforeOrEqual = sorted.filter((s) => s <= buttonSeat);
  return [...after, ...beforeOrEqual];
}

/**
 * Award each pot to its best eligible hand(s). Ties split evenly; the odd chip
 * goes to the first eligible winner seat left of the button. `ranks` must have
 * an entry for every eligible seat in any pot; extra entries are tolerated.
 */
export function awardPots(
  pots: PotShare[],
  ranks: Map<number, HandRank>,
  buttonSeat: number,
): Award[] {
  const awards: Award[] = [];
  pots.forEach((pot, potIndex) => {
    if (pot.eligibleSeats.length === 0 || pot.amount === 0) return;

    // Find the best rank among eligible seats.
    let best: HandRank | null = null;
    const winners: number[] = [];
    for (const seat of pot.eligibleSeats) {
      const r = ranks.get(seat);
      if (!r) continue; // defensively skip; eligible seats should have a rank
      if (best === null || compareRanks(r, best) > 0) {
        best = r;
        winners.length = 0;
        winners.push(seat);
      } else if (compareRanks(r, best) === 0) {
        winners.push(seat);
      }
    }

    if (winners.length === 0) return;

    const base = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - base * winners.length;

    // Odd chips go to winners in order left-of-button.
    const order = seatsLeftOfButton(winners, buttonSeat);
    for (const seat of order) {
      let amt = base;
      if (remainder > 0) {
        amt += 1;
        remainder -= 1;
      }
      if (amt > 0) awards.push({ seat, pot_index: potIndex, amount: amt });
    }
  });
  return awards;
}

/**
 * Fold-out award: the single remaining seat takes every pot layer. No ranks are
 * consulted. Used when all but one player folded.
 */
export function awardUncontested(
  pots: PotShare[],
  winnerSeat: number,
): Award[] {
  const awards: Award[] = [];
  pots.forEach((pot, potIndex) => {
    if (pot.amount > 0) {
      awards.push({ seat: winnerSeat, pot_index: potIndex, amount: pot.amount });
    }
  });
  return awards;
}
