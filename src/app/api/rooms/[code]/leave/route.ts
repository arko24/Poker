// POST /api/rooms/[code]/leave — leave a room and reconcile the stack.
// Requires a Bearer session. Node runtime.

import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { leaveRoom } from "@/lib/server/repo/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: { code: string } },
): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();

  try {
    const balance = await leaveRoom({
      code: ctx.params.code,
      userId: session.user_id,
    });
    return json({ coin_balance: balance });
  } catch (err) {
    return mapError(err);
  }
}
