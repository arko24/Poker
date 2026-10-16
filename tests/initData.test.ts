import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { validateInitData } from "@/lib/server/auth/initData";

// Synthetic bot token + hand-computed hash, per Telegram's documented algorithm.
const BOT_TOKEN = "123456:TEST-synthetic-bot-token";

/** Build a valid initData query string for a given user + auth_date. */
function buildInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = pairs.join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) usp.set(k, v);
  usp.set("hash", hash);
  return usp.toString();
}

const freshAuthDate = (): string => String(Math.floor(Date.now() / 1000));
const USER_JSON = JSON.stringify({
  id: 42,
  username: "alice",
  first_name: "Alice",
});

describe("validateInitData", () => {
  it("accepts a correctly computed hash and returns the user", () => {
    const initData = buildInitData({
      auth_date: freshAuthDate(),
      query_id: "AAABBB",
      user: USER_JSON,
    });
    const res = validateInitData(initData, BOT_TOKEN);
    expect(res.ok).toBe(true);
    expect(res.user).toEqual({
      telegram_id: 42,
      username: "alice",
      first_name: "Alice",
    });
  });

  it("rejects a tampered hash (correct length/hex, wrong value) without throwing", () => {
    const initData = buildInitData({
      auth_date: freshAuthDate(),
      user: USER_JSON,
    });
    // Flip the last hex digit of the hash.
    const tampered = initData.replace(/hash=([0-9a-f]{63})([0-9a-f])/, (_m, head, last) => {
      const next = last === "0" ? "1" : "0";
      return `hash=${head}${next}`;
    });
    const res = validateInitData(tampered, BOT_TOKEN);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("hash_mismatch");
  });

  it("rejects a wrong-length hash with a clean 401, not a 500 (no throw)", () => {
    const res = validateInitData(
      `auth_date=${freshAuthDate()}&user=${encodeURIComponent(USER_JSON)}&hash=deadbeef`,
      BOT_TOKEN,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("malformed_hash");
  });

  it("rejects a non-hex hash of correct length", () => {
    const badHash = "z".repeat(64);
    const res = validateInitData(
      `auth_date=${freshAuthDate()}&user=${encodeURIComponent(USER_JSON)}&hash=${badHash}`,
      BOT_TOKEN,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("malformed_hash");
  });

  it("rejects a missing hash", () => {
    const res = validateInitData(
      `auth_date=${freshAuthDate()}&user=${encodeURIComponent(USER_JSON)}`,
      BOT_TOKEN,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing_hash");
  });

  it("rejects empty / missing initData", () => {
    expect(validateInitData("", BOT_TOKEN).reason).toBe("missing_init_data");
    // @ts-expect-error intentional bad input
    expect(validateInitData(undefined, BOT_TOKEN).reason).toBe("missing_init_data");
  });

  it("rejects an expired auth_date (older than the freshness window)", () => {
    const old = String(Math.floor(Date.now() / 1000) - 48 * 60 * 60); // 48h ago
    const initData = buildInitData({ auth_date: old, user: USER_JSON });
    const res = validateInitData(initData, BOT_TOKEN);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("rejects a valid hash computed for a different bot token", () => {
    const initData = buildInitData(
      { auth_date: freshAuthDate(), user: USER_JSON },
      "999999:OTHER-token",
    );
    const res = validateInitData(initData, BOT_TOKEN);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("hash_mismatch");
  });

  it("rejects a correct hash but missing user field", () => {
    const initData = buildInitData({ auth_date: freshAuthDate() });
    const res = validateInitData(initData, BOT_TOKEN);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing_user");
  });
});
