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

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    return json({ error: "server_misconfigured" }, 500);
  }

  // --- DEV BYPASS (OFF by default) ---------------------------------------
  // When ALLOW_DEV_AUTH="true" AND the client sends the sentinel dev initData,
  // skip Telegram HMAC validation and sign in as a fixed dev user. This lets
  // you test the whole game in a plain browser WITHOUT Telegram. It is gated
  // behind an env flag so it is impossible to use in production unless you
  // explicitly opt in. NEVER set ALLOW_DEV_AUTH in a real public deployment.
  const devAuthAllowed = process.env.ALLOW_DEV_AUTH === "true";
  const isDevInitData = parsed.data.initData.startsWith("dev:");
  if (devAuthAllowed && isDevInitData) {
    // Allow an optional numeric id after "dev:" so you can simulate multiple
    // players in different browser tabs, e.g. "dev:2", "dev:3". Defaults to 1.
    const suffix = parsed.data.initData.slice("dev:".length).trim();
    const n = Number(suffix);
    const devId = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    const telegramId = 900000000 + devId;
    try {
      const user = await upsertUser({
        telegram_id: telegramId,
        username: `dev_${devId}`,
        first_name: `Dev ${devId}`,
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
  // --- END DEV BYPASS -----------------------------------------------------

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
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
