// Typed wrappers over hands + hand_players + hand_results reads and the
// start_hand / apply_action / complete_hand transactional RPCs from 0002_rpc.sql.
//
// The orchestrator computes the next HandState in TypeScript (pure engine) and
// passes the persisted shape here as JSONB; these wrappers only marshal and call
// the RPCs atomically.

import { supabaseAdmin } from "../supabaseAdmin";
import type { Street } from "../engine/handState";

export interface HandRow {
  id: string;
  room_id: string;
  hand_no: number;
  dealer_seat: number;
  street: Street;
  board: string[];
  deck: string[];
  pot: number;
  side_pots: unknown;
  to_act_seat: number | null;
  current_bet: number;
  min_raise: number;
  last_aggressor_seat: number | null;
  action_seq: number;
  act_deadline: string | null;
  created_at: string;
}

export interface HandPlayerRow {
  id: string;
  hand_id: string;
  seat_index: number;
  hole_cards: string[] | null;
  committed_this_street: number;
  total_committed: number;
  status: "in" | "folded" | "allin";
  has_acted_this_street: boolean;
}

export interface HandResultRow {
  id: string;
  hand_id: string;
  board: string[];
  winners: unknown;
  was_showdown: boolean;
  revealed_seats: number[];
  created_at: string;
}

export async function getHandById(handId: string): Promise<HandRow | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("hands")
    .select("*")
    .eq("id", handId)
    .maybeSingle();
  if (error) throw new Error(`getHandById failed: ${error.message}`);
  return (data as HandRow) ?? null;
}

export async function getHandPlayers(handId: string): Promise<HandPlayerRow[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("hand_players")
    .select("*")
    .eq("hand_id", handId)
    .order("seat_index", { ascending: true });
  if (error) throw new Error(`getHandPlayers failed: ${error.message}`);
  return (data as HandPlayerRow[]) ?? [];
}

export async function getHandResult(
  handId: string,
): Promise<HandResultRow | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("hand_results")
    .select("*")
    .eq("hand_id", handId)
    .maybeSingle();
  if (error) throw new Error(`getHandResult failed: ${error.message}`);
  return (data as HandResultRow) ?? null;
}

/** Highest hand_no for a room (0 if none), to assign the next sequential one. */
export async function maxHandNo(roomId: string): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("hands")
    .select("hand_no")
    .eq("room_id", roomId)
    .order("hand_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`maxHandNo failed: ${error.message}`);
  return (data as { hand_no: number } | null)?.hand_no ?? 0;
}

// ---- Transactional RPC payload shapes (serialized to JSONB) -----------------

export interface HandPayload {
  hand_no?: number;
  dealer_seat?: number;
  street: string;
  board: string[];
  deck?: string[];
  pot: number;
  side_pots: unknown;
  to_act_seat: number | null;
  current_bet: number;
  min_raise: number;
  last_aggressor_seat: number | null;
  action_seq?: number;
  act_deadline: string | null;
  /** Blind-posting log entries, only used by start_hand. */
  actions?: Array<{
    seat_index: number;
    street: string;
    action_type: string;
    amount: number;
    seq: number;
  }>;
}

export interface PlayerPayload {
  seat_index: number;
  hole_cards?: string[] | null;
  committed_this_street: number;
  total_committed: number;
  status: string;
  has_acted_this_street: boolean;
  /** Authoritative stack set (chips moved out of stack into pot). */
  stack?: number;
}

export interface ActionLog {
  seat_index: number;
  street: string;
  action_type: string;
  amount: number;
}

export interface Payout {
  seat_index: number;
  amount: number;
}

export interface HandResultPayload {
  board: string[];
  winners: unknown;
  was_showdown: boolean;
  revealed_seats: number[];
}

/** start_hand RPC: two-step insert under the deferred circular FK. */
export async function startHand(input: {
  roomId: string;
  hand: HandPayload;
  players: PlayerPayload[];
}): Promise<string> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("start_hand", {
    p_room_id: input.roomId,
    p_hand: input.hand,
    p_players: input.players,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/** apply_action RPC: fingerprint-guarded compare-and-increment. Returns new seq. */
export async function applyActionRpc(input: {
  handId: string;
  fp: { street: Street; to_act_seat: number | null; action_seq: number };
  hand: HandPayload;
  players: PlayerPayload[];
  log: ActionLog;
}): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("apply_action", {
    p_hand_id: input.handId,
    p_fp_street: input.fp.street,
    p_fp_to_act: input.fp.to_act_seat,
    p_fp_action_seq: input.fp.action_seq,
    p_hand: input.hand,
    p_players: input.players,
    p_log: input.log,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

/** complete_hand RPC: fingerprint-guarded showdown/fold-out persistence. */
export async function completeHandRpc(input: {
  handId: string;
  fp: { street: Street; to_act_seat: number | null; action_seq: number };
  hand: HandPayload;
  payouts: Payout[];
  result: HandResultPayload;
}): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.rpc("complete_hand", {
    p_hand_id: input.handId,
    p_fp_street: input.fp.street,
    p_fp_to_act: input.fp.to_act_seat,
    p_fp_action_seq: input.fp.action_seq,
    p_hand: input.hand,
    p_payouts: input.payouts,
    p_result: input.result,
  });
  if (error) throw new Error(error.message);
}
