// Lobby: pick single-player (vs bots) or multiplayer, create a room with blinds
// / seats / buy-in (clamped to [min_buy_in, min(max_buy_in, coin_balance)]), or
// join an existing multiplayer room by code or from the open-rooms list.
//
// There is NO payment/deposit/withdrawal/cash-out control here — the buy-in is
// drawn from the viewer's play-money balance and returned on leave. The client
// clamp is a convenience; the server re-validates every bound authoritatively
// (design.md Input Validation / Finding 10).

"use client";

import { useState } from "react";
import type { LobbyRoom } from "@/types";
import styles from "./Lobby.module.css";

/** min/max buy-in defaults mirror the server (20*bb .. 200*bb). */
const MIN_BUYIN_BB = 20;
const MAX_BUYIN_BB = 200;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface CreateRoomRequest {
  mode: "single" | "multi";
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  botCount?: number;
  buyIn: number;
}

interface LobbyProps {
  coinBalance: number;
  openRooms: LobbyRoom[];
  refreshingRooms?: boolean;
  busy?: boolean;
  error?: string | null;
  onRefreshRooms: () => void;
  /** Create a room, then the parent joins it with the given buy-in. */
  onCreateRoom: (req: CreateRoomRequest) => void;
  /** Join an existing room by code with the given buy-in. */
  onJoinRoom: (code: string, buyIn: number) => void;
}

const BLIND_PRESETS: { label: string; sb: number; bb: number }[] = [
  { label: "5 / 10", sb: 5, bb: 10 },
  { label: "10 / 20", sb: 10, bb: 20 },
  { label: "25 / 50", sb: 25, bb: 50 },
  { label: "50 / 100", sb: 50, bb: 100 },
];

export default function Lobby({
  coinBalance,
  openRooms,
  refreshingRooms = false,
  busy = false,
  error = null,
  onRefreshRooms,
  onCreateRoom,
  onJoinRoom,
}: LobbyProps) {
  const [mode, setMode] = useState<"single" | "multi">("single");
  const [presetIndex, setPresetIndex] = useState(1); // 10/20 default
  const [maxSeats, setMaxSeats] = useState(2);
  const [botCount, setBotCount] = useState(1);

  const preset = BLIND_PRESETS[presetIndex];
  const minBuyIn = MIN_BUYIN_BB * preset.bb;
  const maxBuyInRaw = MAX_BUYIN_BB * preset.bb;
  // Client clamp: never show an unreachable max (design.md Finding 10).
  const maxBuyIn = Math.min(maxBuyInRaw, coinBalance);
  const canAffordMin = coinBalance >= minBuyIn;

  const [buyIn, setBuyIn] = useState(minBuyIn);
  const [joinCode, setJoinCode] = useState("");
  const [joinBuyIn, setJoinBuyIn] = useState<string>("");

  // Keep buy-in within the current clamp as blinds/balance change.
  const effectiveBuyIn = clamp(buyIn, minBuyIn, Math.max(minBuyIn, maxBuyIn));

  const handleCreate = () => {
    onCreateRoom({
      mode,
      smallBlind: preset.sb,
      bigBlind: preset.bb,
      maxSeats,
      botCount: mode === "single" ? botCount : undefined,
      buyIn: effectiveBuyIn,
    });
  };

  const handleJoinByCode = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    const amount = Number.parseInt(joinBuyIn, 10);
    onJoinRoom(code, Number.isFinite(amount) ? amount : minBuyIn);
  };

  return (
    <div className={styles.lobby}>
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>New table</h2>

        <div className={styles.row}>
          <label className={styles.field}>
            Mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "single" | "multi")}
            >
              <option value="single">Single-player (vs bots)</option>
              <option value="multi">Multiplayer (online)</option>
            </select>
          </label>

          <label className={styles.field}>
            Blinds
            <select
              value={presetIndex}
              onChange={(e) => {
                const idx = Number(e.target.value);
                setPresetIndex(idx);
                setBuyIn(MIN_BUYIN_BB * BLIND_PRESETS[idx].bb);
              }}
            >
              {BLIND_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            Seats
            <select
              value={maxSeats}
              onChange={(e) => {
                const n = Number(e.target.value);
                setMaxSeats(n);
                if (botCount > n - 1) setBotCount(n - 1);
              }}
            >
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          {mode === "single" ? (
            <label className={styles.field}>
              Bots
              <select
                value={botCount}
                onChange={(e) => setBotCount(Number(e.target.value))}
              >
                {Array.from({ length: Math.max(1, maxSeats - 1) }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null}
        </div>

        <label className={styles.field}>
          Buy-in: {effectiveBuyIn.toLocaleString()}
          <input
            type="range"
            min={minBuyIn}
            max={Math.max(minBuyIn, maxBuyIn)}
            step={preset.bb}
            value={effectiveBuyIn}
            disabled={!canAffordMin}
            onChange={(e) => setBuyIn(Number(e.target.value))}
          />
        </label>
        <div className={styles.hint}>
          Allowed {minBuyIn.toLocaleString()}–{maxBuyInRaw.toLocaleString()} ·
          your balance {coinBalance.toLocaleString()}
        </div>

        <button
          type="button"
          className={styles.button}
          onClick={handleCreate}
          disabled={busy || !canAffordMin}
        >
          {canAffordMin
            ? mode === "single"
              ? "Start vs bots"
              : "Create table"
            : "Not enough coins for min buy-in"}
        </button>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Join by code</h2>
        <div className={styles.row}>
          <label className={styles.field}>
            Room code
            <input
              type="text"
              value={joinCode}
              maxLength={6}
              placeholder="ABC123"
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            />
          </label>
          <label className={styles.field}>
            Buy-in
            <input
              type="number"
              value={joinBuyIn}
              placeholder={`${minBuyIn}`}
              onChange={(e) => setJoinBuyIn(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={handleJoinByCode}
          disabled={busy || joinCode.trim().length === 0}
        >
          Join
        </button>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Open tables</h2>
        <button
          type="button"
          className={styles.button}
          onClick={onRefreshRooms}
          disabled={refreshingRooms}
        >
          {refreshingRooms ? "Refreshing…" : "Refresh list"}
        </button>
        {openRooms.length === 0 ? (
          <div className={styles.empty}>No open tables right now.</div>
        ) : (
          <ul className={styles.roomList}>
            {openRooms.map((room) => (
              <li key={room.code} className={styles.roomItem}>
                <span className={styles.roomMeta}>
                  <span className={styles.roomCode}>{room.code}</span>
                  <span>
                    {room.seats}/{room.max_seats} seats · {room.small_blind}/
                    {room.big_blind}
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() =>
                    onJoinRoom(room.code, MIN_BUYIN_BB * room.big_blind)
                  }
                  disabled={busy || coinBalance < MIN_BUYIN_BB * room.big_blind}
                >
                  Join
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
