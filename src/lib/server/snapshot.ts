// Per-viewer redacted snapshot mapper (SERVER-ONLY).
//
// Builds the client-safe Snapshot DTO (src/types) from the DB rows. Redaction
// rules (design.md "Snapshot DTO" + "legalActions redaction", Findings 6 & 9):
//   * NEVER include the deck.
//   * Include a seat's hole_cards only when it is the VIEWER'S own seat, OR when
//     street==='complete' AND was_showdown AND seat ∈ revealed_seats.
//   * Attach legalActions to exactly one viewer's snapshot: only when
//     to_act_seat === viewerSeat AND that seat is a human seat the viewer owns
//     (never for a bot/sitting_out/left seat, never for another player's turn).

import type {
  Snapshot,
  SeatView,
  PotView,
  HandResultView,
  LegalAction,
  Street as DtoStreet,
} from "@/types";
import type { RoomRow, SeatRow } from "./repo/rooms";
import type { HandRow, HandPlayerRow, HandResultRow } from "./repo/hands";
import { legalActions } from "./engine/betting";
import { buildHandState } from "./orchestrator";

export interface SnapshotInput {
  room: RoomRow;
  seats: SeatRow[];
  hand: HandRow | null;
  handPlayers: HandPlayerRow[];
  result: HandResultRow | null;
  /** The seat_index the viewer occupies, or null if not seated. */
  viewerSeatIndex: number | null;
  /**
   * The user_id of the viewer (null for anonymous/not-seated). Used with the
   * seat rows to confirm the viewer actually owns the acting seat before
   * attaching legalActions.
   */
  viewerUserId: string | null;
}

function toPotViews(sidePots: unknown): PotView[] {
  if (!Array.isArray(sidePots)) return [];
  return sidePots
    .map((p) => {
      const obj = p as {
        amount?: number;
        eligible_seat_indexes?: number[];
        eligibleSeats?: number[];
      };
      return {
        amount: Number(obj.amount ?? 0),
        eligible_seat_indexes: obj.eligible_seat_indexes ?? obj.eligibleSeats ?? [],
      };
    })
    .filter((p) => p.amount > 0);
}

function toResultView(result: HandResultRow | null): HandResultView | null {
  if (!result) return null;
  const winners = Array.isArray(result.winners)
    ? (result.winners as HandResultView["winners"])
    : [];
  return {
    board: result.board ?? [],
    winners,
    was_showdown: result.was_showdown,
    revealed_seats: result.revealed_seats ?? [],
  };
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { room, seats, hand, handPlayers, result, viewerSeatIndex } = input;

  const playerBySeat = new Map<number, HandPlayerRow>();
  for (const hp of handPlayers) playerBySeat.set(hp.seat_index, hp);

  const resultView = toResultView(result);
  const isComplete = hand?.street === "complete";
  const revealed = new Set(
    isComplete && result?.was_showdown ? result.revealed_seats ?? [] : [],
  );

  const seatViews: SeatView[] = seats.map((s) => {
    const hp = playerBySeat.get(s.seat_index);
    const isOwn = viewerSeatIndex !== null && s.seat_index === viewerSeatIndex;
    const isRevealed = revealed.has(s.seat_index);

    let hole_cards: string[] | undefined;
    if (hp?.hole_cards && (isOwn || isRevealed)) {
      hole_cards = hp.hole_cards;
    }

    const view: SeatView = {
      seat_index: s.seat_index,
      is_bot: s.is_bot,
      bot_name: s.bot_name,
      display_name: s.is_bot ? s.bot_name : isOwn ? "You" : null,
      stack: s.stack,
      status: s.status,
      hand_status: hp?.status ?? null,
      committed_this_street: hp?.committed_this_street ?? 0,
      total_committed: hp?.total_committed ?? 0,
      has_acted_this_street: hp?.has_acted_this_street ?? false,
    };
    if (hole_cards) view.hole_cards = hole_cards;
    return view;
  });

  // legalActions: only for the viewer's own HUMAN seat on its turn, mid-hand.
  let legal: LegalAction[] | undefined;
  if (
    hand &&
    hand.to_act_seat !== null &&
    viewerSeatIndex !== null &&
    hand.to_act_seat === viewerSeatIndex &&
    hand.street !== "complete" &&
    hand.street !== "showdown"
  ) {
    const actingSeat = seats.find((s) => s.seat_index === viewerSeatIndex);
    const ownsHumanSeat =
      actingSeat !== undefined &&
      !actingSeat.is_bot &&
      actingSeat.user_id !== null &&
      actingSeat.user_id === input.viewerUserId;
    if (ownsHumanSeat) {
      const state = buildHandState(room, seats, hand, handPlayers);
      legal = legalActions(state, viewerSeatIndex);
    }
  }

  const handView: Snapshot["hand"] = hand
    ? {
        hand_no: hand.hand_no,
        dealer_seat: hand.dealer_seat,
        street: hand.street as DtoStreet,
        board: hand.board ?? [],
        pot: handPlayers.reduce((sum, hp) => sum + Number(hp.total_committed), 0),
        side_pots: toPotViews(hand.side_pots),
        to_act_seat: hand.to_act_seat,
        current_bet: hand.current_bet,
        min_raise: hand.min_raise,
        act_deadline: hand.act_deadline,
        action_seq: hand.action_seq,
      }
    : null;

  const snapshot: Snapshot = {
    room: {
      code: room.code,
      mode: room.mode,
      status: room.status,
      small_blind: room.small_blind,
      big_blind: room.big_blind,
      max_seats: room.max_seats,
    },
    hand: handView,
    seats: seatViews,
    viewer_seat_index: viewerSeatIndex,
    fingerprint: hand
      ? {
          street: hand.street as DtoStreet,
          to_act_seat: hand.to_act_seat,
          action_seq: hand.action_seq,
        }
      : null,
  };
  if (legal) snapshot.legal_actions = legal;
  if (resultView && isComplete) snapshot.result = resultView;

  return snapshot;
}
