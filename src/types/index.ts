// Shared, client-safe DTO type stubs for the redacted snapshot sent to clients.
//
// These types describe exactly what the server is allowed to send to a browser.
// They never carry the full deck or another player's hole cards. The server-side
// snapshot mapper (added in a later feature) is responsible for producing values
// that conform to these shapes; the engine's full internal state is NOT exported
// to the client and must not be referenced from here.
//
// Card is a two-char string: rank (2-9,T,J,Q,K,A) + suit (s,h,d,c), e.g. "Ah".

export type Card = string;

export type RoomMode = "single" | "multi";
export type RoomStatus = "waiting" | "in_hand" | "closed";
export type SeatStatus = "active" | "sitting_out" | "left";
export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";
export type PlayerHandStatus = "in" | "folded" | "allin";

/**
 * Legal actions offered to the current human actor only. Populated in exactly one
 * viewer's snapshot (the seat whose turn it is, when that seat is a human the viewer
 * owns) and omitted everywhere else, so no client can read an opponent's bet bounds.
 * `min`/`max` on raise are raise-TO levels; on bet they are "to" levels from zero.
 */
export type LegalAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call"; amount: number }
  | { type: "bet"; min: number; max: number }
  | { type: "raise"; min: number; max: number }
  | { type: "allin"; amount: number };

/** The optimistic-concurrency token clients echo back with an action. */
export interface Fingerprint {
  street: Street;
  to_act_seat: number | null;
  action_seq: number;
}

/**
 * Per-seat view in a snapshot. `hole_cards` is present only for the viewer's own
 * seat, or for a revealed seat at a contested showdown (per the reveal rule); it is
 * absent otherwise. The full deck is never included anywhere in a snapshot.
 */
export interface SeatView {
  seat_index: number;
  is_bot: boolean;
  bot_name: string | null;
  /** Null for the empty/anonymized representation of another human seat. */
  display_name: string | null;
  stack: number;
  status: SeatStatus;
  /** Per-hand status when a hand is live; null when no hand is in progress. */
  hand_status: PlayerHandStatus | null;
  committed_this_street: number;
  total_committed: number;
  has_acted_this_street: boolean;
  /** Present only when this seat belongs to the viewer, or at a revealed showdown. */
  hole_cards?: Card[];
}

/** A single pot layer (main or side) for display. */
export interface PotView {
  amount: number;
  eligible_seat_indexes: number[];
}

/** Summary of a completed hand, mirrored from hand_results for the client. */
export interface HandResultView {
  board: Card[];
  winners: {
    seat_index: number;
    amount: number;
    pot_index: number;
    hand_rank?: number;
    best_five?: Card[];
  }[];
  was_showdown: boolean;
  revealed_seats: number[];
}

/**
 * The authoritative, per-viewer redacted snapshot returned by GET /state and
 * carried by action/join/start responses. `deck` is intentionally absent.
 */
export interface Snapshot {
  room: {
    code: string;
    mode: RoomMode;
    status: RoomStatus;
    small_blind: number;
    big_blind: number;
    max_seats: number;
  };
  /** Present only while a hand is live or just completed. */
  hand: {
    hand_no: number;
    dealer_seat: number;
    street: Street;
    board: Card[];
    pot: number;
    side_pots: PotView[];
    to_act_seat: number | null;
    current_bet: number;
    min_raise: number;
    act_deadline: string | null;
    action_seq: number;
  } | null;
  seats: SeatView[];
  /** The seat_index the viewer occupies in this room, or null if not seated. */
  viewer_seat_index: number | null;
  /** Only present when it is the viewer's own human turn. */
  legal_actions?: LegalAction[];
  /** Fingerprint the client echoes back when submitting the next action. */
  fingerprint: Fingerprint | null;
  /** Present once the current hand has completed. */
  result?: HandResultView | null;
}

/** Lobby listing entry for open multiplayer rooms. */
export interface LobbyRoom {
  code: string;
  mode: RoomMode;
  seats: number;
  max_seats: number;
  small_blind: number;
  big_blind: number;
}
