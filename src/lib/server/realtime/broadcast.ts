// Server-side Realtime broadcast publisher. Publishes a tiny "state_updated"
// event on the per-room channel room:{code}; clients react by fetching their own
// redacted snapshot via GET /state. The payload carries ONLY {version, street,
// to_act_seat} so no card/deck data ever crosses the channel (design.md
// "Supabase Realtime Channel Structure").
//
// Broadcast failures are non-fatal: state is already persisted and clients have
// the polling fallback, so we log a warning and never throw to the caller.

import { supabaseAdmin } from "../supabaseAdmin";

export interface BroadcastPayload {
  version: number; // the hand's action_seq after the mutation
  street: string;
  to_act_seat: number | null;
}

export async function broadcastState(
  code: string,
  payload: BroadcastPayload,
): Promise<void> {
  try {
    const db = supabaseAdmin();
    const channel = db.channel(`room:${code}`, {
      config: { broadcast: { ack: false } },
    });
    await channel.send({
      type: "broadcast",
      event: "state_updated",
      payload,
    });
    await db.removeChannel(channel);
  } catch (err) {
    // Non-fatal: clients poll GET /state as a fallback.
    console.warn(
      `broadcastState failed for room ${code}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
