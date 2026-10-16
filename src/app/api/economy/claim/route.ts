// POST /api/economy/claim — atomic daily top-up when the caller is low on coins.
// Requires a Bearer session. Node runtime.

import { json, unauthorized, mapError } from "@/lib/server/http";
import { authenticate } from "@/lib/server/http";
import { claimTopup } from "@/lib/server/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const session = authenticate(req);
  if (!session) return unauthorized();

  try {
    const balance = await claimTopup(session.user_id);
    return json({ coin_balance: balance });
  } catch (err) {
    return mapError(err);
  }
}
