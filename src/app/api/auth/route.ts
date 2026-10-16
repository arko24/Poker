// POST /api/auth — validate Telegram initData, upsert the user, issue a session.
// No Bearer auth (this is the auth entry point). Node runtime (crypto + service
// client). Any initData failure returns 401, never a 500.

import { z } from "zod";
import { json, unauthorized, mapError } from "@/lib/server/http";
import { validateInitData } from "@/lib/server/auth/initData";
import { issueSession } from "@/lib/server/auth/session";
import { upsertUser } from "@/lib/server/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ initData: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return unauthorized("auth_failed");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return unauthorized("auth_failed");

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!botToken || !sessionSecret) {
    return json({ error: "server_misconfigured" }, 500);
  }

  const result = validateInitData(parsed.data.initData, botToken);
  if (!result.ok || !result.user) {
    return unauthorized("auth_failed");
  }

  try {
    const user = await upsertUser({
      telegram_id: result.user.telegram_id,
      username: result.user.username,
      first_name: result.user.first_name,
    });
    const session = issueSession(
      { telegram_id: user.telegram_id, user_id: user.id },
      sessionSecret,
    );
    return json({
      session,
      user: {
        id: user.id,
        telegram_id: user.telegram_id,
        coin_balance: user.coin_balance,
      },
    });
  } catch (err) {
    return mapError(err);
  }
}
