// POST /api/rooms/[code]/start — start a hand. Runs the bot/advance loop up to
// the first human turn (or hand completion) before returning the snapshot.
// Requires a Bearer session. Node runtime.

import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { startHand } from "@/lib/server/orchestrator";
import { buildViewerSnapshot } from "@/lib/server/viewerSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: { code: string } },
): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();

  const code = ctx.params.code;
  try {
    await startHand(code);
    const snapshot = await buildViewerSnapshot(code, session.user_id);
    return json({ snapshot });
  } catch (err) {
    return mapError(err);
  }
}
