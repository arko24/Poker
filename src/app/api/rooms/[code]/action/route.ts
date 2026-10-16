// POST /api/rooms/[code]/action — submit a player action. Zod-validated body +
// fingerprint + server-side legality re-check. Requires a Bearer session.
// Node runtime.

import { z } from "zod";
import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { getRoomByCode, getSeats } from "@/lib/server/repo/rooms";
import { applyHumanAction } from "@/lib/server/orchestrator";
import type { Action } from "@/lib/server/engine/betting";
import { buildViewerSnapshot } from "@/lib/server/viewerSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fingerprintSchema = z.object({
  street: z.enum([
    "preflop",
    "flop",
    "turn",
    "river",
    "showdown",
    "complete",
  ]),
  to_act_seat: z.number().int().nullable(),
  action_seq: z.number().int(),
});

const bodySchema = z.object({
  action: z.enum(["fold", "check", "call", "bet", "raise", "allin"]),
  amount: z.number().int().nonnegative().optional(),
  fingerprint: fingerprintSchema,
});

function toEngineAction(
  type: z.infer<typeof bodySchema>["action"],
  amount: number | undefined,
): Action {
  switch (type) {
    case "fold":
      return { type: "fold" };
    case "check":
      return { type: "check" };
    case "call":
      return { type: "call" };
    case "allin":
      return { type: "allin" };
    case "bet":
      if (amount === undefined) throw new Error("illegal_action");
      return { type: "bet", amount };
    case "raise":
      if (amount === undefined) throw new Error("illegal_action");
      return { type: "raise", to: amount };
  }
}

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

    // Resolve the caller's seat.
    const seats = await getSeats(room.id);
    const seat = seats.find(
      (s) => s.user_id === session.user_id && s.status !== "left",
    );
    if (!seat) return json({ error: "conflict", code: "not_seated" }, 409);

    const action = toEngineAction(parsed.data.action, parsed.data.amount);

    await applyHumanAction({
      code,
      userSeatIndex: seat.seat_index,
      action,
      fingerprint: parsed.data.fingerprint,
    });

    const snapshot = await buildViewerSnapshot(code, session.user_id);
    return json({ snapshot });
  } catch (err) {
    return mapError(err);
  }
}
