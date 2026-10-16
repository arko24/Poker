// POST /api/cron/tick — scheduler-only liveness tick. Authenticated by a
// CRON_SECRET header (NOT a user session). Advances every in_hand room whose
// current hand's act_deadline has passed. Node runtime.
//
// Called by the external GitHub Actions scheduler (design.md Finding 1), not
// Vercel Cron. A missing/wrong secret -> 401. Per-room failures are non-fatal:
// other rooms are still processed.

import { json } from "@/lib/server/http";
import { supabaseAdmin } from "@/lib/server/supabaseAdmin";
import { runLoop } from "@/lib/server/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const presented =
    req.headers.get("x-cron-secret") ??
    (() => {
      const auth = req.headers.get("authorization") ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      return m ? m[1] : null;
    })();

  if (!secret || presented !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = supabaseAdmin();
  // Rooms currently in a hand with an expired deadline.
  const { data, error } = await db
    .from("rooms")
    .select("code, current_hand_id, hands!rooms_current_hand_fk(act_deadline)")
    .eq("status", "in_hand");

  if (error) {
    console.error("cron/tick query failed:", error.message);
    return json({ advanced: 0 });
  }

  type Row = {
    code: string;
    current_hand_id: string | null;
    hands: { act_deadline: string | null } | { act_deadline: string | null }[] | null;
  };

  const now = Date.now();
  let advanced = 0;
  for (const r of (data as Row[]) ?? []) {
    const handRel = Array.isArray(r.hands) ? r.hands[0] : r.hands;
    const deadline = handRel?.act_deadline ?? null;
    if (!r.current_hand_id || deadline === null) continue;
    if (Date.parse(deadline) >= now) continue;
    try {
      await runLoop(r.code);
      advanced++;
    } catch (err) {
      console.error(
        `cron/tick advance failed for room ${r.code}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return json({ advanced });
}
