import { HandState, SeatState, Street } from "@/lib/server/engine/handState";

export interface SeatInit {
  seat_index: number;
  stack: number;
  committed_this_street?: number;
  total_committed?: number;
  status?: SeatState["status"];
  has_acted_this_street?: boolean;
  is_button?: boolean;
}

export interface HandStateInit {
  street?: Street;
  board?: string[];
  deck?: string[];
  seats: SeatInit[];
  button_seat: number;
  small_blind?: number;
  big_blind?: number;
  current_bet?: number;
  min_raise?: number;
  last_aggressor_seat?: number | null;
  to_act_seat?: number | null;
  action_seq?: number;
  turn_timeout_secs?: number;
}

export function makeState(init: HandStateInit): HandState {
  const big_blind = init.big_blind ?? 20;
  const seats: SeatState[] = init.seats.map((s) => ({
    seat_index: s.seat_index,
    stack: s.stack,
    committed_this_street: s.committed_this_street ?? 0,
    total_committed: s.total_committed ?? s.committed_this_street ?? 0,
    status: s.status ?? "in",
    has_acted_this_street: s.has_acted_this_street ?? false,
    is_button: s.is_button ?? s.seat_index === init.button_seat,
  }));
  return {
    street: init.street ?? "preflop",
    board: init.board ?? [],
    deck: init.deck ?? [],
    seats,
    button_seat: init.button_seat,
    small_blind: init.small_blind ?? 10,
    big_blind,
    current_bet: init.current_bet ?? 0,
    min_raise: init.min_raise ?? big_blind,
    last_aggressor_seat: init.last_aggressor_seat ?? null,
    to_act_seat: init.to_act_seat ?? null,
    action_seq: init.action_seq ?? 0,
    act_deadline: null,
    turn_timeout_secs: init.turn_timeout_secs ?? 30,
  };
}
