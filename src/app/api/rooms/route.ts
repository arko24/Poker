// GET /api/rooms  — lobby: list open multiplayer rooms.
// POST /api/rooms — create a room (single-player seats bots; multi is open).
// Both require a Bearer session. Node runtime.

import { z } from "zod";
import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { createRoom, listOpenMultiRooms } from "@/lib/server/repo/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();
  try {
    const rooms = await listOpenMultiRooms();
    return json(rooms);
  } catch (err) {
    return mapError(err);
  }
}

const createSchema = z
  .object({
    mode: z.enum(["single", "multi"]),
    smallBlind: z.number().int().positive(),
    bigBlind: z.number().int().positive(),
    maxSeats: z.number().int().min(2).max(6),
    botCount: z.number().int().min(1).max(5).optional(),
  })
  .refine((v) => v.bigBlind > v.smallBlind, {
    message: "bigBlind must exceed smallBlind",
  })
  .refine((v) => v.mode !== "single" || (v.botCount ?? 0) >= 1, {
    message: "single-player requires at least one bot",
  });

export async function POST(req: Request): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_body" }, 422);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid_body", code: "validation" }, 422);
  }
  const v = parsed.data;
  // A single-player table must leave room for the human (seat 0) + bots.
  if (v.mode === "single" && (v.botCount ?? 0) + 1 > v.maxSeats) {
    return json({ error: "invalid_body", code: "too_many_bots" }, 422);
  }

  try {
    const room = await createRoom({
      mode: v.mode,
      smallBlind: v.smallBlind,
      bigBlind: v.bigBlind,
      maxSeats: v.maxSeats,
      createdBy: session.user_id,
      botCount: v.mode === "single" ? v.botCount : undefined,
    });
    return json({ code: room.code });
  } catch (err) {
    return mapError(err);
  }
}
