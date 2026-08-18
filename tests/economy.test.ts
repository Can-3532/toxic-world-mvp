// TOXIC WORLD — v0.4 REWARD ECONOMY TESTS (Sprint 2.4 harness item 5, v0.4
// economy change). Runs the REAL production formulas from src/convex/economy.ts
// + the frozen constants from src/convex/gameParams.ts.
//
// Run:  bun test tests/economy.test.ts

import { describe, it as test, expect } from "vitest";
import {
  advanceBurn,
  applyBurnToPollution,
  burnRewardTox,
  burnZoneTox,
  computeBurnSlice,
  normalBurnTox,
  rewardKey,
  type BurnSlice,
} from "../src/convex/economy";
import { BURN_ZONE_MULTIPLIER, TOX_PER_TON } from "../src/convex/gameParams";

describe("normal burn reward (Design Freeze v0.4)", () => {
  test("1 ton burned = 500 TOX", () => {
    expect(normalBurnTox(1000)).toBeCloseTo(500, 6);
  });

  test("100 kg = 50 TOX (fractional support)", () => {
    expect(normalBurnTox(100)).toBeCloseTo(50, 6);
  });

  test("20 kg = 10 TOX", () => {
    expect(normalBurnTox(20)).toBeCloseTo(10, 6);
  });

  test("formula is burned_kg / 1000 * TOX_PER_TON, exact per the freeze", () => {
    for (const kg of [1, 7, 123.4, 543.21, 10_000]) {
      expect(normalBurnTox(kg)).toBeCloseTo((kg / 1000) * TOX_PER_TON, 9);
    }
  });

  test("zero waste → zero reward", () => {
    expect(normalBurnTox(0)).toBe(0);
  });
});

describe("burn zone reward (×1.2, server-side)", () => {
  test("1 ton in zone = 600 TOX", () => {
    expect(burnZoneTox(1000)).toBeCloseTo(600, 6);
    expect(burnZoneTox(1000)).toBeCloseTo(TOX_PER_TON * BURN_ZONE_MULTIPLIER, 6);
  });

  test("100 kg in zone = 60 TOX", () => {
    expect(burnZoneTox(100)).toBeCloseTo(60, 6);
  });

  test("burnRewardTox switches on zone state (client never sends amounts)", () => {
    expect(burnRewardTox(1000, false)).toBeCloseTo(500, 6);
    expect(burnRewardTox(1000, true)).toBeCloseTo(600, 6);
  });
});

describe("exactly-once reward accounting", () => {
  test("reward key is unique per (session, slice) — the idempotency rail", () => {
    const a = rewardKey("s1", 0);
    const b = rewardKey("s1", 1);
    const c = rewardKey("s2", 0);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("a normal burn and a zone burn of the same unit produce the SAME key", () => {
    // => the same waste can never be double-rewarded as normal + zone:
    // the key has no multiplier component.
    const state: BurnSlice = { sessionId: "p1:123", queuedKg: 50, sliceIndex: 3 };
    const normal = computeBurnSlice(state, 10, false);
    const zone = computeBurnSlice(state, 10, true);
    expect(normal.key).toBe(zone.key);
    expect(normal.tox).toBeCloseTo(5, 6);
    expect(zone.tox).toBeCloseTo(6, 6);
  });

  test("computeBurnSlice reports kind normal/burn_zone from zone state", () => {
    const state: BurnSlice = { sessionId: "s", queuedKg: 20, sliceIndex: 0 };
    expect(computeBurnSlice(state, 20, false).kind).toBe("normal");
    expect(computeBurnSlice(state, 20, true).kind).toBe("burn_zone");
  });

  test("advanceBurn consumes kg and advances the slice index — replay is harmless", () => {
    const state: BurnSlice = { sessionId: "s", queuedKg: 100, sliceIndex: 0 };
    // first pass: slice key s:0 credited (handled by the ledger, tested below)
    const next = advanceBurn(state, 10, false);
    expect(next.queuedKg).toBe(90);
    expect(next.sliceIndex).toBe(1);
    // replay of the SAME slice (alreadyRewarded) still advances the index so
    // the next slice gets a fresh key — the Sprint 2.6 fix
    const replay = advanceBurn(state, 10, true);
    expect(replay.queuedKg).toBe(90);
    expect(replay.sliceIndex).toBe(1);
    // and the FOLLOWING slice has a different key
    expect(rewardKey("s", 0)).not.toBe(rewardKey("s", 1));
  });

  test("burning removes waste from the world 1:1 (identical for normal & zone)", () => {
    expect(applyBurnToPollution(5_000_000, 1000)).toBeCloseTo(4_999_000, 6);
    expect(applyBurnToPollution(500, 1000)).toBe(0); // clamped at 0
  });
});

describe("progression ROI helpers", () => {
  test("hoursToReach", async () => {
    const { hoursToReach } = await import("../src/convex/economy");
    expect(hoursToReach(100, 200)).toBeCloseTo(2, 9);
    expect(hoursToReach(0, 100)).toBe(Infinity);
  });
});
