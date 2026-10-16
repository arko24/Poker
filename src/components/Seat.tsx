// Seat: one player's position — name, stack, per-hand status, committed chips,
// and hole cards (only the viewer's own cards, or a revealed showdown seat, are
// face-up; all others render face-down backs). Highlights the seat to act.

import type { SeatView } from "@/types";
import { CardHand } from "./Card";
import styles from "./Seat.module.css";

interface SeatProps {
  seat: SeatView;
  isViewer: boolean;
  isToAct: boolean;
  /** Dealer button marker. */
  isDealer?: boolean;
  handLive: boolean;
}

export default function Seat({
  seat,
  isViewer,
  isToAct,
  isDealer = false,
  handLive,
}: SeatProps) {
  const name = isViewer
    ? "You"
    : seat.is_bot
      ? seat.bot_name ?? "Bot"
      : seat.display_name ?? `Seat ${seat.seat_index}`;

  const folded = seat.hand_status === "folded";
  const classes = [
    styles.seat,
    isToAct ? styles.toAct : "",
    folded ? styles.folded : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Show face-up cards only when the snapshot included them (own seat or a
  // revealed showdown seat). Otherwise draw backs while a hand is live.
  const hasOwnCards = Array.isArray(seat.hole_cards) && seat.hole_cards.length > 0;
  const showBacks = handLive && seat.hand_status !== null && !folded && !hasOwnCards;

  return (
    <div className={classes} aria-label={`Seat ${seat.seat_index}`}>
      <div className={styles.header}>
        <span className={`${styles.name} ${isViewer ? styles.you : ""}`}>
          {name}
          {isDealer ? " (D)" : ""}
        </span>
        <span className={styles.stack}>{seat.stack.toLocaleString()}</span>
      </div>

      {hasOwnCards ? (
        <CardHand cards={seat.hole_cards} />
      ) : showBacks ? (
        <CardHand hidden count={2} />
      ) : null}

      {seat.hand_status ? (
        <span
          className={`${styles.status} ${
            seat.hand_status === "allin" ? styles.allin : ""
          }`}
        >
          {seat.hand_status}
        </span>
      ) : null}

      {handLive && seat.committed_this_street > 0 ? (
        <span className={styles.committed}>
          bet {seat.committed_this_street.toLocaleString()}
        </span>
      ) : null}
    </div>
  );
}
