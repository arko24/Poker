// Board: community cards, main pot, and any side-pot layers for display. All
// values come from the redacted snapshot (pot/side_pots are server-computed
// display values).

import type { PotView, Street } from "@/types";
import { CardHand } from "./Card";
import styles from "./Board.module.css";

interface BoardProps {
  board: string[];
  pot: number;
  sidePots: PotView[];
  street: Street;
}

export default function Board({ board, pot, sidePots, street }: BoardProps) {
  return (
    <div className={styles.board}>
      <div className={styles.street}>{street}</div>
      <div className={styles.cards}>
        <CardHand cards={board} count={board.length || 0} />
      </div>
      <div className={styles.pot}>Pot: {pot.toLocaleString()}</div>
      {sidePots.length > 1 ? (
        <div className={styles.sidePots}>
          {sidePots.map((p: PotView, i) => (
            <span key={i}>
              {i === 0 ? "Main" : `Side ${i}`}: {p.amount.toLocaleString()} (seats{" "}
              {p.eligible_seat_indexes.join(", ")})
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
