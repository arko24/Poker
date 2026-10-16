// Table: renders the redacted snapshot — board, pot, seats (with stacks,
// status, hole cards for the viewer / revealed seats), to-act highlight, a turn
// countdown, and the action Controls (only on the viewer's own turn, bounded by
// legalActions). Start/Leave are the only table-level controls; there is NO
// payment/deposit/withdrawal/cash-out control anywhere.

"use client";

import { useEffect, useState } from "react";
import type { Snapshot } from "@/types";
import Board from "./Board";
import SeatView from "./Seat";
import Controls, { type ActionKind } from "./Controls";
import styles from "./Table.module.css";

interface TableProps {
  snapshot: Snapshot;
  /** Disable controls while a request is in flight. */
  busy?: boolean;
  onStart: () => void;
  onLeave: () => void;
  onAction: (action: ActionKind, amount?: number) => void;
}

function useCountdown(deadline: string | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!deadline) {
      setRemaining(null);
      return;
    }
    const tick = () => {
      const ms = new Date(deadline).getTime() - Date.now();
      setRemaining(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return remaining;
}

export default function Table({
  snapshot,
  busy = false,
  onStart,
  onLeave,
  onAction,
}: TableProps) {
  const { room, hand, seats, viewer_seat_index, legal_actions, result } = snapshot;
  const handLive = hand !== null && hand.street !== "complete";
  const countdown = useCountdown(hand?.act_deadline ?? null);

  const isViewerTurn =
    hand !== null &&
    viewer_seat_index !== null &&
    hand.to_act_seat === viewer_seat_index &&
    Array.isArray(legal_actions) &&
    legal_actions.length > 0;

  const canStart = !handLive && room.status !== "closed";

  return (
    <div className={styles.table}>
      <div className={styles.topBar}>
        <span className={styles.code}>Table {room.code}</span>
        <span className={styles.code}>
          {room.small_blind}/{room.big_blind} · {room.mode}
        </span>
      </div>

      <div className={styles.felt}>
        {hand ? (
          <Board
            board={hand.board}
            pot={hand.pot}
            sidePots={hand.side_pots}
            street={hand.street}
          />
        ) : (
          <div className={styles.waiting}>Waiting to start a hand.</div>
        )}

        <div className={styles.seats}>
          {seats.map((seat) => (
            <SeatView
              key={seat.seat_index}
              seat={seat}
              isViewer={seat.seat_index === viewer_seat_index}
              isToAct={hand?.to_act_seat === seat.seat_index && handLive}
              isDealer={hand?.dealer_seat === seat.seat_index}
              handLive={handLive}
            />
          ))}
        </div>
      </div>

      {handLive && countdown !== null ? (
        <div className={styles.countdown}>
          {hand?.to_act_seat === viewer_seat_index
            ? `Your turn — ${countdown}s`
            : `Waiting on seat ${hand?.to_act_seat} — ${countdown}s`}
        </div>
      ) : null}

      {result ? (
        <div className={styles.result}>
          {result.winners.map((w, i) => (
            <div key={i}>
              Seat {w.seat_index} wins {w.amount.toLocaleString()}
              {result.was_showdown ? " (showdown)" : ""}
            </div>
          ))}
        </div>
      ) : null}

      {isViewerTurn && legal_actions ? (
        <Controls
          legalActions={legal_actions}
          disabled={busy}
          onAction={onAction}
        />
      ) : null}

      <div className={styles.actionBar}>
        {canStart ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={onStart}
            disabled={busy}
          >
            {hand ? "Next hand" : "Start hand"}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.secondary}
          onClick={onLeave}
          disabled={busy}
        >
          Leave table
        </button>
      </div>
    </div>
  );
}
