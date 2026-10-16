// Anon Supabase Realtime client (CLIENT-ONLY). This client is used EXCLUSIVELY
// to subscribe to the room:{code} Broadcast channel so a seated client learns
// when to re-fetch its own redacted snapshot. It never reads game tables and
// never mutates anything — all state changes go through the server route
// handlers using the service-role key (see design.md "RLS decision").
//
// The event payload carries only {version, street, to_act_seat}; on each event
// the caller re-fetches GET /state for its per-viewer snapshot.

import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";

/** Minimal shape of the Broadcast event payload the server publishes. */
export interface StateUpdatedEvent {
  version?: number;
  street?: string;
  to_act_seat?: number | null;
}

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return client;
}

/** True when the public Supabase env is configured (Realtime is available). */
export function isRealtimeConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export interface RoomSubscription {
  /** Unsubscribe and remove the channel. Safe to call more than once. */
  unsubscribe: () => void;
}

/**
 * Subscribe to the room:{code} Broadcast channel. Resolves ONLY once the
 * channel reaches the SUBSCRIBED state, so callers can subscribe to Realtime
 * BEFORE fetching the initial snapshot (design.md / FEAT-004 ordering rule).
 *
 * Rejects if the client is not configured or the subscription errors/times out,
 * letting the caller fall back to polling GET /state.
 */
export function subscribeToRoom(
  code: string,
  onStateUpdated: (event: StateUpdatedEvent) => void,
): Promise<RoomSubscription> {
  return new Promise((resolve, reject) => {
    const supabase = getClient();
    if (!supabase) {
      reject(new Error("realtime_not_configured"));
      return;
    }

    let settled = false;
    const channel: RealtimeChannel = supabase.channel(`room:${code}`, {
      config: { broadcast: { self: false } },
    });

    const cleanup = () => {
      try {
        supabase.removeChannel(channel);
      } catch {
        // ignore teardown errors
      }
    };

    channel
      .on("broadcast", { event: "state_updated" }, (message) => {
        onStateUpdated((message.payload ?? {}) as StateUpdatedEvent);
      })
      .subscribe((status) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          resolve({ unsubscribe: cleanup });
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          settled = true;
          cleanup();
          reject(new Error(`realtime_${status.toLowerCase()}`));
        }
      });
  });
}
