// PlayShell: the Mini App state machine (CLIENT-ONLY). On mount it initializes
// the Telegram SDK and authenticates (POST /api/auth), then routes between the
// Lobby and an active Table.
//
// Realtime ordering rule (design.md / FEAT-004): when entering a room it
// subscribes to the room:{code} Broadcast channel FIRST, THEN fetches the
// initial snapshot via GET /state. Each broadcast event re-fetches the viewer's
// snapshot. When Realtime is unavailable, or it is the viewer's turn, it falls
// back to ~2s polling of GET /state.
//
// Recovery: the api wrapper handles 401 (silent re-auth + retry once). On 409
// (incl. stale_fingerprint) this shell re-fetches /state and re-renders from
// fresh legalActions — it never auto-replays the action body.
//
// This module imports NO server-only code. Identity is proven server-side.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LobbyRoom, Snapshot } from "@/types";
import { initTelegram } from "@/lib/client/telegram";
import { api, ApiError, type AuthUser } from "@/lib/client/api";
import {
  isRealtimeConfigured,
  subscribeToRoom,
  type RoomSubscription,
} from "@/lib/client/supabaseBrowser";
import type { ActionKind } from "./Controls";
import Lobby, { type CreateRoomRequest } from "./Lobby";
import Table from "./Table";
import BalanceBadge from "./BalanceBadge";
import styles from "./PlayShell.module.css";

type Phase = "booting" | "auth_failed" | "lobby" | "in_room";

const POLL_INTERVAL_MS = 2000;

export default function PlayShell() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const [openRooms, setOpenRooms] = useState<LobbyRoom[]>([]);
  const [refreshingRooms, setRefreshingRooms] = useState(false);

  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // Mutable refs for the polling/subscription lifecycle.
  const subRef = useRef<RoomSubscription | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomCodeRef = useRef<string | null>(null);

  const clearPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const teardownRoom = useCallback(() => {
    clearPolling();
    if (subRef.current) {
      subRef.current.unsubscribe();
      subRef.current = null;
    }
    roomCodeRef.current = null;
  }, [clearPolling]);

  // --- snapshot fetch (shared by initial load, broadcast, and polling) -----
  const refreshSnapshot = useCallback(async (code: string) => {
    try {
      const { snapshot: next } = await api.getState(code);
      // Ignore stale fetches after leaving the room.
      if (roomCodeRef.current === code) setSnapshot(next);
    } catch (err) {
      if (err instanceof ApiError && err.isAuthExhausted) {
        setPhase("auth_failed");
      }
      // Other errors: keep the last snapshot; the next poll/event retries.
    }
  }, []);

  const startPolling = useCallback(
    (code: string) => {
      clearPolling();
      pollRef.current = setInterval(() => {
        void refreshSnapshot(code);
      }, POLL_INTERVAL_MS);
    },
    [clearPolling, refreshSnapshot],
  );

  // Enter a room: subscribe to Realtime FIRST, THEN fetch the initial snapshot.
  const enterRoom = useCallback(
    async (code: string, initial?: Snapshot) => {
      teardownRoom();
      roomCodeRef.current = code;
      setRoomCode(code);
      if (initial) setSnapshot(initial);
      setPhase("in_room");

      let realtimeOk = false;
      if (isRealtimeConfigured()) {
        try {
          // Subscribe BEFORE fetching the initial snapshot (ordering rule).
          subRef.current = await subscribeToRoom(code, () => {
            void refreshSnapshot(code);
          });
          realtimeOk = true;
        } catch {
          realtimeOk = false; // fall back to polling
        }
      }

      // Initial snapshot AFTER the subscription is live.
      await refreshSnapshot(code);

      // Poll when Realtime is unavailable (also a safe backstop on your turn).
      if (!realtimeOk) startPolling(code);
    },
    [teardownRoom, refreshSnapshot, startPolling],
  );

  // Keep a light poll running while it's the viewer's turn even with Realtime
  // (so bot-drive-on-read / timeouts progress), per design.md fallback note.
  useEffect(() => {
    const code = roomCodeRef.current;
    if (!code || !snapshot) return;
    const hand = snapshot.hand;
    const myTurn =
      hand &&
      snapshot.viewer_seat_index !== null &&
      hand.to_act_seat === snapshot.viewer_seat_index;
    const handLive = hand !== null && hand.street !== "complete";
    if (handLive && myTurn && !pollRef.current) {
      startPolling(code);
    }
  }, [snapshot, startPolling]);

  // --- lobby actions -------------------------------------------------------
  const loadRooms = useCallback(async () => {
    setRefreshingRooms(true);
    try {
      setOpenRooms(await api.listRooms());
    } catch (err) {
      if (err instanceof ApiError && err.isAuthExhausted) setPhase("auth_failed");
    } finally {
      setRefreshingRooms(false);
    }
  }, []);

  // --- boot: init Telegram + authenticate --------------------------------
  const boot = useCallback(async () => {
    setError(null);
    setPhase("booting");
    initTelegram();
    try {
      const result = await api.auth();
      setUser(result.user);
      setPhase("lobby");
      void loadRooms();
    } catch {
      setPhase("auth_failed");
    }
  }, [loadRooms]);

  useEffect(() => {
    void boot();
    return () => teardownRoom();
  }, [boot, teardownRoom]);

  const handleCreateRoom = useCallback(
    async (req: CreateRoomRequest) => {
      setBusy(true);
      setError(null);
      try {
        const { code } = await api.createRoom({
          mode: req.mode,
          smallBlind: req.smallBlind,
          bigBlind: req.bigBlind,
          maxSeats: req.maxSeats,
          botCount: req.botCount,
        });
        const { snapshot: joined } = await api.joinRoom(code, req.buyIn);
        await enterRoom(code, joined);
        // For single-player, start the first hand immediately.
        if (req.mode === "single") {
          const { snapshot: started } = await api.startHand(code);
          setSnapshot(started);
        }
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [enterRoom],
  );

  const handleJoinRoom = useCallback(
    async (code: string, buyIn: number) => {
      setBusy(true);
      setError(null);
      try {
        const { snapshot: joined } = await api.joinRoom(code, buyIn);
        await enterRoom(code, joined);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [enterRoom],
  );

  const handleClaim = useCallback(async () => {
    setClaiming(true);
    try {
      const { coin_balance } = await api.claimTopup();
      setUser((u) => (u ? { ...u, coin_balance } : u));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setClaiming(false);
    }
  }, []);

  // --- table actions -------------------------------------------------------
  const handleStart = useCallback(async () => {
    if (!roomCode) return;
    setBusy(true);
    setError(null);
    try {
      const { snapshot: started } = await api.startHand(roomCode);
      setSnapshot(started);
    } catch (err) {
      // On any conflict, re-fetch fresh state and re-decide (no replay).
      setError(describeError(err));
      await refreshSnapshot(roomCode);
    } finally {
      setBusy(false);
    }
  }, [roomCode, refreshSnapshot]);

  const handleLeave = useCallback(async () => {
    if (!roomCode) return;
    setBusy(true);
    try {
      const { coin_balance } = await api.leaveRoom(roomCode);
      setUser((u) => (u ? { ...u, coin_balance } : u));
    } catch {
      // Leave is idempotent server-side; ignore and return to the lobby.
    } finally {
      teardownRoom();
      setSnapshot(null);
      setRoomCode(null);
      setPhase("lobby");
      setBusy(false);
      void loadRooms();
    }
  }, [roomCode, teardownRoom, loadRooms]);

  const handleAction = useCallback(
    async (action: ActionKind, amount?: number) => {
      if (!roomCode || !snapshot || !snapshot.fingerprint) return;
      setBusy(true);
      setError(null);
      try {
        const { snapshot: next } = await api.submitAction(roomCode, {
          action,
          amount,
          fingerprint: snapshot.fingerprint,
        });
        setSnapshot(next);
      } catch (err) {
        // 409 (incl. stale_fingerprint): NEVER auto-replay. Re-fetch /state and
        // re-decide from the fresh legalActions (design.md Finding 9).
        if (err instanceof ApiError && err.isConflict) {
          await refreshSnapshot(roomCode);
        } else {
          setError(describeError(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [roomCode, snapshot, refreshSnapshot],
  );

  // --- render --------------------------------------------------------------
  if (phase === "booting") {
    return (
      <div className={styles.center}>
        <p>Loading…</p>
      </div>
    );
  }

  if (phase === "auth_failed") {
    return (
      <div className={styles.center}>
        <p className={styles.error}>
          Could not verify your Telegram session. Please reopen this game from
          the Telegram bot.
        </p>
        <button type="button" className={styles.button} onClick={() => void boot()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.header}>
        <h1 className={styles.title}>Hold&apos;em Mini</h1>
        {user ? (
          <BalanceBadge
            balance={user.coin_balance}
            onClaim={handleClaim}
            claiming={claiming}
          />
        ) : null}
      </div>

      <div className={styles.body}>
        {phase === "in_room" && snapshot ? (
          <Table
            snapshot={snapshot}
            busy={busy}
            onStart={handleStart}
            onLeave={handleLeave}
            onAction={handleAction}
          />
        ) : (
          <Lobby
            coinBalance={user?.coin_balance ?? 0}
            openRooms={openRooms}
            refreshingRooms={refreshingRooms}
            busy={busy}
            error={error}
            onRefreshRooms={() => void loadRooms()}
            onCreateRoom={(req) => void handleCreateRoom(req)}
            onJoinRoom={(code, buyIn) => void handleJoinRoom(code, buyIn)}
          />
        )}
      </div>
    </div>
  );
}

/** Map an ApiError code to a short, friendly message. */
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "insufficient_balance":
        return "Not enough coins for that buy-in.";
      case "buy_in_out_of_bounds":
        return "Buy-in is outside the table's allowed range.";
      case "already_seated":
        return "You are already seated at this table.";
      case "room_full":
        return "That table is full.";
      case "room_closed":
      case "room_not_found":
        return "That table is not available.";
      case "topup_not_eligible":
        return "Daily top-up isn't available yet.";
      case "not_enough_players":
        return "Not enough players to start a hand.";
      case "stale_fingerprint":
        return "The hand moved on — refreshed to the latest state.";
      default:
        return err.isAuthExhausted
          ? "Session expired. Please reopen from Telegram."
          : "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
