import { describe, it, expect } from "vitest";
import { decide, estimateEquity, BotView } from "@/lib/server/engine/bot";
import { LegalAction } from "@/lib/server/engine/betting";

const SEED = 12345;

describe("estimateEquity", () => {
  it("is deterministic under a fixed seed", () => {
    const a = estimateEquity(["As", "Ah"], ["Kd", "7c", "2s"], 1, SEED);
    const b = estimateEquity(["As", "Ah"], ["Kd", "7c", "2s"], 1, SEED);
    expect(a).toBe(b);
  });

  it("rates a made set far above a weak holding on the same board", () => {
    const board = ["Ad", "7c", "2s"];
    const strong = estimateEquity(["As", "Ah"], board, 1, SEED); // trip aces
    const weak = estimateEquity(["3d", "4h"], board, 1, SEED);
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(0.8);
  });
});

describe("decide", () => {
  it("raises on a very strong made hand when facing no bet", () => {
    const view: BotView = {
      holeCards: ["As", "Ah"],
      board: ["Ad", "Kc", "2s"], // trip aces
      pot: 100,
      toCall: 0,
      stack: 1000,
      activeOpponents: 1,
      legalActions: [
        { type: "fold" },
        { type: "check" },
        { type: "bet", min: 20, max: 1000 },
        { type: "allin", amount: 1000 },
      ] satisfies LegalAction[],
    };
    const action = decide(view, SEED);
    expect(action.type).toBe("bet");
  });

  it("folds a weak hand facing a large bet it is not priced into", () => {
    const view: BotView = {
      holeCards: ["2c", "7d"], // junk
      board: ["Ad", "Kc", "Qs"],
      pot: 100,
      toCall: 300, // pot odds ~0.75, way above junk equity
      stack: 1000,
      activeOpponents: 1,
      legalActions: [
        { type: "fold" },
        { type: "call", amount: 300 },
        { type: "raise", min: 600, max: 1000 },
        { type: "allin", amount: 1000 },
      ] satisfies LegalAction[],
    };
    const action = decide(view, SEED);
    expect(action.type).toBe("fold");
  });

  it("calls when the price is right relative to equity", () => {
    const view: BotView = {
      holeCards: ["Ah", "Kh"], // strong draw / overcards on a flush board
      board: ["Qh", "7h", "2c"], // flush draw + overcards -> decent equity
      pot: 400,
      toCall: 50, // pot odds ~0.11 -> easy call
      stack: 1000,
      activeOpponents: 1,
      legalActions: [
        { type: "fold" },
        { type: "call", amount: 50 },
        { type: "raise", min: 100, max: 1000 },
        { type: "allin", amount: 1000 },
      ] satisfies LegalAction[],
    };
    const action = decide(view, SEED);
    expect(["call", "raise"]).toContain(action.type);
  });

  it("checks a mediocre hand when there is no bet to call", () => {
    const view: BotView = {
      holeCards: ["9c", "4d"],
      board: ["Ad", "Kc", "Qs"],
      pot: 100,
      toCall: 0,
      stack: 1000,
      activeOpponents: 1,
      legalActions: [
        { type: "fold" },
        { type: "check" },
        { type: "bet", min: 20, max: 1000 },
        { type: "allin", amount: 1000 },
      ] satisfies LegalAction[],
    };
    const action = decide(view, SEED);
    expect(action.type).toBe("check");
  });

  it("is deterministic: same view + seed -> same action", () => {
    const view: BotView = {
      holeCards: ["Ah", "Kh"],
      board: ["Qh", "7h", "2c"],
      pot: 400,
      toCall: 50,
      stack: 1000,
      activeOpponents: 1,
      legalActions: [
        { type: "fold" },
        { type: "call", amount: 50 },
        { type: "raise", min: 100, max: 1000 },
        { type: "allin", amount: 1000 },
      ],
    };
    expect(decide(view, SEED)).toEqual(decide(view, SEED));
  });
});
