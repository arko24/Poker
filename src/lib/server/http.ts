// Shared HTTP helpers for the API route handlers (Node runtime): JSON responses,
// Bearer-session authentication, and mapping engine/RPC error codes to status
// codes. SERVER-ONLY.

import { NextResponse } from "next/server";
import { verifySession, SessionPayload } from "./auth/session";

export function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(body, { status, headers });
}

/** 401 helpers (distinct from 409 recovery paths; design.md Finding 9). */
export function unauthorized(error = "session_expired"): NextResponse {
  return json({ error }, 401);
}

export interface AuthedRequest {
  session: SessionPayload;
}

/**
 * Verify the Authorization: Bearer <session> header. Returns the session payload
 * or null (the caller returns 401). Never throws.
 */
export function authenticate(req: Request): SessionPayload | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const result = verifySession(m[1], secret);
  return result.ok && result.payload ? result.payload : null;
}

/**
 * Map an error thrown by the engine / repo / RPC layer to an HTTP response.
 * Recoverable validation/concurrency errors -> 409; not-found -> 404; everything
 * unexpected -> 500 (no internals leaked).
 */
export function mapError(err: unknown): NextResponse {
  const msg = err instanceof Error ? err.message : String(err);

  // 404 — not found.
  if (msg.includes("room_not_found")) return json({ error: "not_found", code: "room_not_found" }, 404);
  if (msg.includes("hand_not_found")) return json({ error: "not_found", code: "hand_not_found" }, 404);

  // 409 — recoverable (surface to caller; never auto-replayed for fingerprint).
  const conflictCodes = [
    "stale_fingerprint",
    "already_seated",
    "topup_not_eligible",
    "insufficient_balance",
    "buy_in_out_of_bounds",
    "seat_out_of_range",
    "room_closed",
    "not_your_turn",
    "illegal_action",
    "not_enough_players",
    "chip_conservation_violation",
    "room_full",
    "deck_exhausted",
  ];
  for (const code of conflictCodes) {
    if (msg.includes(code)) return json({ error: "conflict", code }, 409);
  }

  // Unexpected: 500, generic.
  console.error("unhandled route error:", msg);
  return json({ error: "internal_error" }, 500);
}
