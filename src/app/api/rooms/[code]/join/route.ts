// POST /api/rooms/[code]/join — join a room and buy in from balance.
// Requires a Bearer session. Node runtime.

import { z } from "zod";
import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { getRoomByCode, firstFreeSeatIndex, joinRoom } from "@/lib/server/repo/rooms";
import { buildViewerSnapshot } from "@/lib/server/viewerSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ buyIn: z.number().int().positive() });

export async function POST(
  req: Request,
  ctx: { params: { code: string } },
): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_body" }, 422);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_body", code: "validation" }, 422);

  const code = ctx.params.code;
  try {
    const room = await getRoomByCode(code);
    if (!room) return json({ error: "not_found", code: "room_not_found" }, 404);
    if (room.status === "closed") return json({ error: "conflict", code: "room_closed" }, 409);

    const seatIndex = await firstFreeSeatIndex(room);
    if (seatIndex === null) return json({ error: "conflict", code: "room_full" }, 409);

    const assigned = await joinRoom({
      code,
      userId: session.user_id,
      buyIn: parsed.data.buyIn,
      seatIndex,
    });

    const snapshot = await buildViewerSnapshot(code, session.user_id);
    return json({ seatIndex: assigned, snapshot });
  } catch (err) {
    return mapError(err);
  }
}
