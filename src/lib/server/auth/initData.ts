// Telegram initData HMAC-SHA256 validation, executed server-side with Node
// crypto. Pure given its inputs (reads no DB); the bot token is passed in (the
// route handler reads it from process.env.TELEGRAM_BOT_TOKEN).
//
// Security note (design.md "initData Validation", Finding 4): crypto.timingSafeEqual
// throws a RangeError on buffers of unequal length. A malformed client sending a
// hash of any other length would otherwise surface as a 500. We length/format-guard
// the provided hash (64-char lowercase hex) BEFORE touching timingSafeEqual, so a
// tampered/missing/wrong-length/non-hex hash yields a clean rejection (-> 401), not a 500.

import { createHmac, timingSafeEqual } from "crypto";

export interface TelegramUser {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
}

export interface InitDataResult {
  ok: boolean;
  user?: TelegramUser;
  /** Short machine-readable reason; never includes secrets or the token. */
  reason?:
    | "missing_init_data"
    | "missing_hash"
    | "malformed_hash"
    | "hash_mismatch"
    | "expired"
    | "missing_user"
    | "malformed_user";
}

const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_AGE_SECS = 24 * 60 * 60; // 24h freshness window

/**
 * Validate a Telegram WebApp `initData` query string against the bot token.
 * Returns {ok:false, reason} for every failure path WITHOUT throwing, so the
 * caller maps any failure to 401. Returns {ok:true, user} on success.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSecs?: number; now?: number } = {},
): InitDataResult {
  if (typeof initData !== "string" || initData.length === 0) {
    return { ok: false, reason: "missing_init_data" };
  }

  const params = new URLSearchParams(initData);
  const providedHash = params.get("hash");
  if (!providedHash) {
    return { ok: false, reason: "missing_hash" };
  }

  // Length/format guard BEFORE timingSafeEqual: a Telegram hash is exactly a
  // 64-char lowercase hex string. Reject anything else as a clean 401.
  if (!HASH_RE.test(providedHash)) {
    return { ok: false, reason: "malformed_hash" };
  }

  // Build the data_check_string: every pair except `hash`, sorted by key,
  // joined "key=value" with newlines.
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  // calculated_hash = HMAC_SHA256(key=secret_key, message=data_check_string)
  const calculated = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();

  const provided = Buffer.from(providedHash, "hex");
  // Both are 32 bytes (providedHash is guaranteed 64 hex chars by the guard,
  // calculated is a sha256 digest), so timingSafeEqual cannot throw here.
  if (provided.length !== calculated.length) {
    return { ok: false, reason: "malformed_hash" };
  }
  if (!timingSafeEqual(provided, calculated)) {
    return { ok: false, reason: "hash_mismatch" };
  }

  // Freshness: reject stale auth_date to limit replay.
  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (Number.isFinite(authDate)) {
    const nowSecs = Math.floor((opts.now ?? Date.now()) / 1000);
    const maxAge = opts.maxAgeSecs ?? DEFAULT_MAX_AGE_SECS;
    if (nowSecs - authDate > maxAge) {
      return { ok: false, reason: "expired" };
    }
  }

  // Parse the user JSON.
  const userRaw = params.get("user");
  if (!userRaw) {
    return { ok: false, reason: "missing_user" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "malformed_user" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== "number"
  ) {
    return { ok: false, reason: "malformed_user" };
  }
  const u = parsed as { id: number; username?: string; first_name?: string };

  return {
    ok: true,
    user: {
      telegram_id: u.id,
      username: typeof u.username === "string" ? u.username : null,
      first_name: typeof u.first_name === "string" ? u.first_name : null,
    },
  };
}
