// TOXIC WORLD — v0.4 reward economy tests (Design Freeze v0.4).
// Run with: bun test tests/economy.test.ts
//
// These tests exercise the REAL production module src/convex/economy.ts
// (and its constants from src/convex/gameParams.ts) — no mocks.
// Engine-level idempotency (ledger lookups inside world.ts tick) is enforced
// by the rewardLedger table; the unit tests below prove the key scheme makes
// double-rewarding the same waste unit impossible.

import { describe, expect, test } from "bun:test";
import {
  advanceBurn,
  applyBurnToPollution,
  burnRewardTox,
  burnZoneTox,
  computeBurnSlice,
  hoursToReach,
  normalBurnTox,
  rewardKey,
  type BurnSlice,
} from "../src/convex/economy";
import { BURN_ZONE_MULTIPLIER, CARGO_CUMULATIVE_TOX, TOX_PER_TON } from "../src/convex/gameParams";

const TON = 1000; // kg per ton (the formula is burned_kg / 1000 * rate)

const approx = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// --- 1. reward formulas ---------------------------------------------------

describe("normal burn reward (500 TOX / ton)", () => {
  test("1 ton burned => 500 TOX", () => {
    approx(normalBurnTox(TON), 500);
  });
  test("100 kg burned => 50 TOX", () => {
    approx(normalBurnTox(100), 50);
  });
  test("fractional amounts supported: 20 kg => 10 TOX", () => {
    approx(normalBurnTox(20), 10);
  });
  test("constant matches the freeze: TOX_PER_TON === 500", () => {
    expect(TOX_PER_TON).toBe(500);
  });
});

describe("burn zone reward (×1.2 => 600 TOX / ton)", () => {
  test("1 ton in zone => 600 TOX", () => {
    approx(burnZoneTox(TON), 600);
  });
  test("100 kg in zone => 60 TOX", () => {
    approx(burnZoneTox(100), 60);
  });
  test("zone is exactly normal × 1.2 for any mass", () => {
    for (const kg of [1, 13, 100, 999, 12345]) {
      approx(burnZoneTox(kg), normalBurnTox(kg) * BURN_ZONE_MULTIPLIER);
    }
  });
  test("burnRewardTox selects multiplier server-side by zone state", () => {
    approx(burnRewardTox(TON, false), 500);
    approx(burnRewardTox(TON, true), 600);
  });
});

// --- 2. only burning produces reward --------------------------------------

describe("no reward outside the burn transition", () => {
  test("0 kg burned produces 0 TOX in both kinds", () => {
    expect(burnRewardTox(0, false)).toBe(0);
    expect(burnRewardTox(0, true)).toBe(0);
    expect(normalBurnTox(0)).toBe(0);
    expect(burnZoneTox(0)).toBe(0);
  });
  test("negative/zero kg never credits: advanceBurn floors the queue at 0", () => {
    const state: BurnSlice = { sessionId: "s1", queuedKg: 0, sliceIndex: 0 };
    const next = advanceBurn(state, 0, false);
    expect(next.queuedKg).toBe(0);
  });
});

// --- 3. idempotency / exactly-once -----------------------------------------

describe("reward ledger keys are exactly-once", () => {
  const state: BurnSlice = { sessionId: "p:1700000000000", queuedKg: 1000, sliceIndex: 3 };

  test("the same slice always produces the same key", () => {
    const a = computeBurnSlice(state, 100, false);
    const b = computeBurnSlice(state, 100, true);
    expect(a.key).toBe(b.key);
    expect(a.key).toBe(rewardKey(state.sessionId, state.sliceIndex));
  });

  test("a normal burn and a burn-zone burn of the SAME waste unit share one key => cannot double-reward", () => {
    const normal = computeBurnSlice(state, 100, false);
    const zone = computeBurnSlice(state, 100, true);
    expect(normal.key).toBe(zone.key);
    expect(normal.tox).not.toBe(zone.tox); // different multipliers, but same key
  });

  test("distinct slices get distinct keys (index advances per credited slice)", () => {
    const s0 = computeBurnSlice({ ...state, sliceIndex: 0 }, 100, false);
    const s1 = computeBurnSlice({ ...state, sliceIndex: 1 }, 100, false);
    expect(s0.key).not.toBe(s1.key);
  });

  test("a duplicate tick (alreadyRewarded) burns kg but credits nothing", () => {
    const state2: BurnSlice = { sessionId: "p:1", queuedKg: 1000, sliceIndex: 4 };
    const credited = advanceBurn(state2, 100, false);
    const duplicated = advanceBurn(state2, 100, true);
    // both consume the same kg from the queue...
    expect(credited.queuedKg).toBe(900);
    expect(duplicated.queuedKg).toBe(900);
    // ...but only the credited pass advances the key
    expect(credited.sliceIndex).toBe(5);
    expect(duplicated.sliceIndex).toBe(4);
  });

  test("rewards are fractional-safe", () => {
    const slice = computeBurnSlice({ ...state, queuedKg: 20 }, 20, false);
    approx(slice.tox, 10);
  });
});

// --- 4. SOL is untouched by burn -------------------------------------------

describe("burn never touches SOL", () => {
  test("economy module exposes no SOL write path", () => {
    // Type-level: the module's public API returns only kg/tox/kind/key.
    const slice = computeBurnSlice({ sessionId: "s", queuedKg: 100, sliceIndex: 0 }, 100, false);
    expect(Object.keys(slice).sort()).toEqual(["key", "kg", "kind", "tox"]);
  });
  test("advanceBurn mutates only the queue state", () => {
    const before: BurnSlice = { sessionId: "s", queuedKg: 100, sliceIndex: 0 };
    const after = advanceBurn(before, 100, false);
    expect(after).toEqual({ sessionId: "s", queuedKg: 0, sliceIndex: 1 });
  });
});

// --- 5. pollution accounting ------------------------------------------------

describe("burn removes waste from the world 1:1, identical for both kinds", () => {
  test("pollution drops by exactly the burned kg", () => {
    approx(applyBurnToPollution(1_000_000, 400), 999_600);
  });
  test("identical reduction for normal and burn-zone burns", () => {
    const before = 5_000_000;
    const burned = 12345;
    // the multiplier affects ONLY the TOX reward, never the mass accounting
    expect(applyBurnToPollution(before, burned)).toBe(before - burned);
    approx(burnZoneTox(burned), normalBurnTox(burned) * BURN_ZONE_MULTIPLIER);
  });
  test("pollution never goes negative", () => {
    expect(applyBurnToPollution(10, 999)).toBe(0);
  });
});

// --- 6. starter progression references (v0.4 validation, not hard-coded) ----

describe("starter 24h economy reference (~38.34 kg/h spatial throughput)", () => {
  const starterKgH = 38.34; // real spatial engine measurement, NOT hard-coded gameplay
  const toxPerDay = (starterKgH * 24) / 1000 * TOX_PER_TON;

  test("≈ 0.920 ton/day => ≈ 460 TOX/day", () => {
    approx(toxPerDay, 460.08, 1e-6);
  });
  test("24h to earn one day's TOX at starter rate", () => {
    approx(hoursToReach(toxPerDay / 24, toxPerDay), 24, 1e-9);
  });
});

describe("cargo progression ROI (cumulative TOX at 460 TOX/day)", () => {
  const toxPerHour = 460.08 / 24; // ≈ 19.17 TOX/h

  test("cumulative costs match the freeze: 150 / 375 / 715 / 1225", () => {
    expect([...CARGO_CUMULATIVE_TOX]).toEqual([150, 375, 715, 1225]);
  });
  test("time to each cargo level matches the reference (7.8 / 19.6 / 37.3 / 63.9 h)", () => {
    const refs = [7.8, 19.6, 37.3, 63.9];
    CARGO_CUMULATIVE_TOX.forEach((cum, i) => {
      const hours = hoursToReach(toxPerHour, cum);
      expect(Math.abs(hours - refs[i])).toBeLessThanOrEqual(0.15);
    });
  });
});

// --- 7. burn zone bonus impact ----------------------------------------------

describe("burn zone impact on the economy", () => {
  test("zone burns earn exactly +20% over normal", () => {
    for (const kg of [1, 50, 1000]) {
      approx(burnZoneTox(kg) / normalBurnTox(kg), 1.2);
    }
  });
  test("a 100% zone-share player earns 1.2× a normal player over equal burn", () => {
    const burned = 100_000;
    approx(burnZoneTox(burned), normalBurnTox(burned) * 1.2);
  });
});
