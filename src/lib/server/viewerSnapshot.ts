// Convenience: load a room's full state and build the per-viewer redacted
// snapshot for a given user. SERVER-ONLY. Used by every route that returns a
// snapshot (join/leave/start/action/advance/state).

import type { Snapshot } from "@/types";
import { loadRoomState } from "./orchestrator";
import { getHandResult } from "./repo/hands";
import { buildSnapshot } from "./snapshot";

export async function buildViewerSnapshot(
  code: string,
  viewerUserId: string | null,
): Promise<Snapshot | null> {
  const loaded = await loadRoomState(code);
  if (!loaded) return null;

  const { room, seats, hand, handPlayers } = loaded;

  const viewerSeat =
    viewerUserId === null
      ? null
      : seats.find((s) => s.user_id === viewerUserId && s.status !== "left") ??
        null;
  const viewerSeatIndex = viewerSeat ? viewerSeat.seat_index : null;

  const result = hand ? await getHandResult(hand.id) : null;

  return buildSnapshot({
    room,
    seats,
    hand,
    handPlayers,
    result,
    viewerSeatIndex,
    viewerUserId,
  });
}
