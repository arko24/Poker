// POST /api/rooms/[code]/advance — tick: resolve timeouts, run bots, progress
// the hand. Fingerprint-guarded inside the loop. Requires a Bearer session.
// Node runtime.

import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { runLoop } from "@/lib/server/orchestrator";
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
    await runLoop(code);
    const snapshot = await buildViewerSnapshot(code, session.user_id);
    return json({ snapshot });
  } catch (err) {
    return mapError(err);
  }
}
