// Short HMAC-signed session tokens issued by POST /api/auth after initData
// validation and verified on every other authenticated endpoint. Keyed by
// SESSION_SECRET (server-only). TTL is 24h, matching the initData freshness
// window (design.md "Session TTL & refresh", Finding 12).
//
// Token format: base64url(payloadJson) + "." + base64url(hmacSha256(payload)).
// The payload carries {telegram_id, user_id, iat, exp}. Verification is
// constant-time and length-guarded so a malformed token yields a clean failure
// (-> 401), never a thrown 500.

import { createHmac, timingSafeEqual } from "crypto";

export interface SessionPayload {
  telegram_id: number;
  user_id: string;
  iat: number; // issued-at, epoch seconds
  exp: number; // expiry, epoch seconds
}

export const SESSION_TTL_SECS = 24 * 60 * 60; // 24h

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadPart: string, secret: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(payloadPart).digest());
}

/**
 * Issue a signed session token for a user. `now` (epoch ms) is injectable for
 * tests; defaults to Date.now().
 */
export function issueSession(
  input: { telegram_id: number; user_id: string },
  secret: string,
  now: number = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const payload: SessionPayload = {
    telegram_id: input.telegram_id,
    user_id: input.user_id,
    iat,
    exp: iat + SESSION_TTL_SECS,
  };
  const payloadPart = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(payloadPart, secret);
  return `${payloadPart}.${sig}`;
}

export interface VerifyResult {
  ok: boolean;
  payload?: SessionPayload;
  reason?: "malformed" | "bad_signature" | "expired";
}

/**
 * Verify a session token: shape, HMAC signature (constant-time), and expiry.
 * Never throws; returns {ok:false, reason} on any failure so the caller maps to
 * 401 {error:'session_expired'}.
 */
export function verifySession(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): VerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  const expectedSig = sign(payloadPart, secret);
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: SessionPayload;
  try {
    const json = b64urlDecode(payloadPart).toString("utf8");
    const parsed = JSON.parse(json) as SessionPayload;
    if (
      typeof parsed.telegram_id !== "number" ||
      typeof parsed.user_id !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return { ok: false, reason: "malformed" };
    }
    payload = parsed;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const nowSecs = Math.floor(now / 1000);
  if (nowSecs >= payload.exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}
