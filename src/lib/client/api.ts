// Typed fetch helpers to the /api/* endpoints (CLIENT-ONLY). Every call carries
// the Bearer session token. This module imports NO server-only code (no
// supabaseAdmin/auth/engine/orchestrator) and holds no secrets.
//
// Recovery discipline (design.md Finding 9 / FEAT-003 error model):
//   - 401  -> silently POST /api/auth with freshly read initData and retry the
//             original request ONCE. If it still fails, surface a reopen prompt.
//   - 409  -> surface to the caller WITHOUT auto-replaying the body. The caller
//             re-fetches GET /state and re-decides from fresh legalActions.
//             (stale_fingerprint is never replayed.)

import type { LobbyRoom, Snapshot } from "@/types";
import { getInitData } from "./telegram";

/** Authenticated user summary returned by POST /api/auth. */
export interface AuthUser {
  id: string;
  telegram_id: number;
  coin_balance: number;
}

export interface AuthResult {
  session: string;
  user: AuthUser;
}

/** A structured API error the UI can branch on. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message?: string) {
    super(message ?? code ?? `http_${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** 409 conflict — caller must re-fetch /state and re-decide, never replay. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** Stale fingerprint — the hand moved on; re-GET /state and re-decide. */
  get isStaleFingerprint(): boolean {
    return this.status === 409 && this.code === "stale_fingerprint";
  }

  /** Re-auth exhausted — the client should prompt to reopen from Telegram. */
  get isAuthExhausted(): boolean {
    return this.status === 401;
  }
}

// --- session storage (in-memory; the session is short-lived, 24h) ----------

let currentSession: string | null = null;

export function setSession(session: string | null): void {
  currentSession = session;
}

export function getSession(): string | null {
  return currentSession;
}

// --- low-level request with 401 re-auth-retry-once -------------------------

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Internal: set when this call IS the re-auth, to avoid recursion. */
  _isReauth?: boolean;
  /** Internal: set after a single retry so we never loop. */
  _retried?: boolean;
}

async function parseError(res: Response): Promise<ApiError> {
  let code: string | null = null;
  try {
    const data = (await res.json()) as { error?: string; code?: string };
    code = data.code ?? data.error ?? null;
  } catch {
    // no JSON body
  }
  return new ApiError(res.status, code);
}

/**
 * Perform POST /api/auth with freshly read initData. Updates the in-memory
 * session on success. Used both for the initial auth and the silent 401 retry.
 */
export async function authenticate(): Promise<AuthResult> {
  const initData = getInitData();
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  if (!res.ok) {
    throw await parseError(res);
  }
  const result = (await res.json()) as AuthResult;
  setSession(result.session);
  return result;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (!opts._isReauth && currentSession) {
    headers["authorization"] = `Bearer ${currentSession}`;
  }

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

  if (res.ok) {
    // 204 or empty body tolerated.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  // 401 -> silent re-auth + retry ONCE (never for the auth call itself).
  if (res.status === 401 && !opts._isReauth && !opts._retried) {
    try {
      await authenticate();
    } catch {
      // Re-auth failed -> surface a 401 so the UI prompts to reopen.
      throw new ApiError(401, "auth_failed");
    }
    return request<T>(path, { ...opts, _retried: true });
  }

  // 409 and everything else surface to the caller (NO auto-replay on 409).
  throw await parseError(res);
}

// --- typed endpoint helpers -------------------------------------------------

export interface CreateRoomInput {
  mode: "single" | "multi";
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  botCount?: number;
}

export const api = {
  /** POST /api/auth — initial authentication. */
  auth: authenticate,

  /** POST /api/economy/claim — daily top-up when low. */
  claimTopup(): Promise<{ coin_balance: number }> {
    return request("/api/economy/claim", { method: "POST" });
  },

  /** GET /api/rooms — list open multiplayer rooms for the lobby. */
  listRooms(): Promise<LobbyRoom[]> {
    return request("/api/rooms");
  },

  /** POST /api/rooms — create a single- or multi-player room. */
  createRoom(input: CreateRoomInput): Promise<{ code: string }> {
    return request("/api/rooms", { method: "POST", body: input });
  },

  /** POST /api/rooms/[code]/join — join + buy-in. */
  joinRoom(
    code: string,
    buyIn: number,
  ): Promise<{ seatIndex: number; snapshot: Snapshot }> {
    return request(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: { buyIn },
    });
  },

  /** POST /api/rooms/[code]/leave — reconcile stack to balance. */
  leaveRoom(code: string): Promise<{ coin_balance: number }> {
    return request(`/api/rooms/${encodeURIComponent(code)}/leave`, {
      method: "POST",
    });
  },

  /** POST /api/rooms/[code]/start — start a hand (runs bots to first human). */
  startHand(code: string): Promise<{ snapshot: Snapshot }> {
    return request(`/api/rooms/${encodeURIComponent(code)}/start`, {
      method: "POST",
    });
  },

  /** POST /api/rooms/[code]/action — submit an action with a fingerprint. */
  submitAction(
    code: string,
    body: {
      action: "fold" | "check" | "call" | "bet" | "raise" | "allin";
      amount?: number;
      fingerprint: { street: string; to_act_seat: number | null; action_seq: number };
    },
  ): Promise<{ snapshot: Snapshot }> {
    return request(`/api/rooms/${encodeURIComponent(code)}/action`, {
      method: "POST",
      body,
    });
  },

  /** POST /api/rooms/[code]/advance — tick/advance the hand. */
  advance(code: string): Promise<{ snapshot: Snapshot }> {
    return request(`/api/rooms/${encodeURIComponent(code)}/advance`, {
      method: "POST",
    });
  },

  /** GET /api/rooms/[code]/state — authoritative per-viewer snapshot. */
  getState(code: string): Promise<{ snapshot: Snapshot }> {
    return request(`/api/rooms/${encodeURIComponent(code)}/state`);
  },
};
