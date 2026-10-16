// GET /api/rooms/[code]/state — authoritative snapshot (initial load + polling
// fallback). PURE READ on a human turn; drives the fingerprint-guarded advance
// loop ONLY when to_act_seat is a bot (or a human whose deadline has passed).
// Requires a Bearer session. Node runtime. Cache-Control: no-store.

import { json, unauthorized, mapError, authenticate } from "@/lib/server/http";
import { loadRoomState, runLoop, shouldDriveOnRead } from "@/lib/server/orchestrator";
import { buildViewerSnapshot } from "@/lib/server/viewerSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  req: Request,
  ctx: { params: { code: string } },
): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();

  const code = ctx.params.code;
  try {
    const loaded = await loadRoomState(code);
    if (!loaded) return json({ error: "not_found", code: "room_not_found" }, 404, NO_STORE);

    // Drive the guarded advance only on a bot turn (or a passed human deadline).
    // On a human's turn this is a pure read and no mutation occurs.
    if (shouldDriveOnRead(loaded)) {
      await runLoop(code);
    }

    const snapshot = await buildViewerSnapshot(code, session.user_id);
    return json({ snapshot }, 200, NO_STORE);
  } catch (err) {
    return mapError(err);
  }
}
