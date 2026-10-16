// Typed wrappers over rooms + seats: creation, lobby listing, join/leave RPCs,
// and the room/seat reads the orchestrator and route handlers need.

import { supabaseAdmin } from "../supabaseAdmin";
import { randomBytes } from "crypto";

export type RoomMode = "single" | "multi";
export type RoomStatus = "waiting" | "in_hand" | "closed";
export type SeatStatus = "active" | "sitting_out" | "left";

export interface RoomRow {
  id: string;
  code: string;
  mode: RoomMode;
  status: RoomStatus;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  max_seats: number;
  last_dealer_seat: number | null;
  turn_timeout_secs: number;
  created_by: string | null;
  current_hand_id: string | null;
  created_at: string;
}

export interface SeatRow {
  id: string;
  room_id: string;
  user_id: string | null;
  seat_index: number;
  is_bot: boolean;
  bot_name: string | null;
  stack: number;
  status: SeatStatus;
  joined_at: string;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generate a 6-char base32 room code. */
function generateCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += BASE32[bytes[i] % BASE32.length];
  return out;
}

export async function getRoomByCode(code: string): Promise<RoomRow | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(`getRoomByCode failed: ${error.message}`);
  return (data as RoomRow) ?? null;
}

export async function getSeats(roomId: string): Promise<SeatRow[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("seats")
    .select("*")
    .eq("room_id", roomId)
    .order("seat_index", { ascending: true });
  if (error) throw new Error(`getSeats failed: ${error.message}`);
  return (data as SeatRow[]) ?? [];
}

/**
 * Create a room. For single-player mode the caller provides bot seats to insert
 * (bots sit at non-zero seat indexes; the human takes seat 0 on join). Returns
 * the new room's code.
 */
export async function createRoom(input: {
  mode: RoomMode;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  createdBy: string;
  botCount?: number;
  botBuyIn?: number;
}): Promise<RoomRow> {
  const db = supabaseAdmin();
  const minBuyIn = 20 * input.bigBlind;
  const maxBuyIn = 200 * input.bigBlind;

  // Retry a couple of times on the (astronomically unlikely) code collision.
  let room: RoomRow | null = null;
  for (let attempt = 0; attempt < 5 && !room; attempt++) {
    const code = generateCode();
    const { data, error } = await db
      .from("rooms")
      .insert({
        code,
        mode: input.mode,
        status: "waiting",
        small_blind: input.smallBlind,
        big_blind: input.bigBlind,
        min_buy_in: minBuyIn,
        max_buy_in: maxBuyIn,
        max_seats: input.maxSeats,
        created_by: input.createdBy,
      })
      .select("*")
      .maybeSingle();
    if (error) {
      // 23505 = unique_violation on code; retry with a new code.
      if (error.code === "23505") continue;
      throw new Error(`createRoom failed: ${error.message}`);
    }
    room = data as RoomRow;
  }
  if (!room) throw new Error("createRoom failed: could not allocate a code");

  // Single-player: seat the bots. Human takes seat 0 via join.
  if (input.mode === "single" && (input.botCount ?? 0) > 0) {
    const botBuyIn = input.botBuyIn ?? maxBuyIn;
    const seats = [] as Array<Partial<SeatRow>>;
    for (let i = 1; i <= (input.botCount ?? 0); i++) {
      seats.push({
        room_id: room.id,
        user_id: null,
        seat_index: i,
        is_bot: true,
        bot_name: `Bot ${i}`,
        stack: botBuyIn,
        status: "active",
      });
    }
    const { error } = await db.from("seats").insert(seats);
    if (error) throw new Error(`createRoom bot seats failed: ${error.message}`);
  }

  return room;
}

/** List open multiplayer rooms for the lobby, with a seat count. */
export async function listOpenMultiRooms(): Promise<
  Array<{
    code: string;
    mode: RoomMode;
    seats: number;
    max_seats: number;
    small_blind: number;
    big_blind: number;
  }>
> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("rooms")
    .select("code, mode, max_seats, small_blind, big_blind, seats(count)")
    .eq("mode", "multi")
    .in("status", ["waiting", "in_hand"]);
  if (error) throw new Error(`listOpenMultiRooms failed: ${error.message}`);
  type Row = {
    code: string;
    mode: RoomMode;
    max_seats: number;
    small_blind: number;
    big_blind: number;
    seats: { count: number }[] | null;
  };
  return ((data as Row[]) ?? []).map((r) => ({
    code: r.code,
    mode: r.mode,
    seats: r.seats?.[0]?.count ?? 0,
    max_seats: r.max_seats,
    small_blind: r.small_blind,
    big_blind: r.big_blind,
  }));
}

/** Find the first free seat index in [0, maxSeats). Returns null if full. */
export async function firstFreeSeatIndex(
  room: RoomRow,
): Promise<number | null> {
  const seats = await getSeats(room.id);
  const taken = new Set(
    seats.filter((s) => s.status !== "left").map((s) => s.seat_index),
  );
  for (let i = 0; i < room.max_seats; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

/**
 * Join a room via the idempotent join_room RPC. Resolves to the assigned seat
 * index. Throws with the RPC's short error code on failure (e.g.
 * 'already_seated', 'insufficient_balance', 'buy_in_out_of_bounds').
 */
export async function joinRoom(input: {
  code: string;
  userId: string;
  buyIn: number;
  seatIndex: number;
}): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("join_room", {
    p_room_code: input.code,
    p_user_id: input.userId,
    p_buy_in: input.buyIn,
    p_seat_index: input.seatIndex,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

/** Leave a room via the idempotent leave_room RPC. Resolves to the new balance. */
export async function leaveRoom(input: {
  code: string;
  userId: string;
}): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("leave_room", {
    p_room_code: input.code,
    p_user_id: input.userId,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}
