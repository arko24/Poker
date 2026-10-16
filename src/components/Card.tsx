// Renders a single playing card (two-char "Ah"/"Td"/"2c") or a face-down back.
// Card type is the client-safe DTO string from src/types.

import type { Card } from "@/types";
import styles from "./Card.module.css";

const SUIT_SYMBOL: Record<string, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

function isRed(suit: string): boolean {
  return suit === "h" || suit === "d";
}

export function CardView({ card }: { card?: Card | null }) {
  if (!card) {
    return <span className={`${styles.card} ${styles.back}`} aria-hidden />;
  }
  const rank = card.slice(0, card.length - 1);
  const suit = card.slice(-1);
  const symbol = SUIT_SYMBOL[suit] ?? suit;
  const colorClass = isRed(suit) ? styles.red : styles.black;
  return (
    <span className={`${styles.card} ${colorClass}`} aria-label={`${rank}${symbol}`}>
      {rank}
      {symbol}
    </span>
  );
}

/** Renders a row of cards; when `hidden`, draws `count` face-down backs. */
export function CardHand({
  cards,
  hidden = false,
  count = 2,
}: {
  cards?: Card[];
  hidden?: boolean;
  count?: number;
}) {
  if (hidden || !cards) {
    return (
      <span className={styles.hand}>
        {Array.from({ length: count }, (_, i) => (
          <CardView key={i} card={null} />
        ))}
      </span>
    );
  }
  return (
    <span className={styles.hand}>
      {cards.map((c, i) => (
        <CardView key={`${c}-${i}`} card={c} />
      ))}
    </span>
  );
}
