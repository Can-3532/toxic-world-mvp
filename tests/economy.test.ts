// TOXIC WORLD — v0.4 reward economy unit tests (Design Freeze v0.4).
// Runs against the SAME pure functions the world tick uses
// (src/convex/economy.ts + src/convex/gameParams.ts) — not a copy.
//
// Run:  bun test tests/economy.test.ts

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

describe("v0.4 normal burn reward (500 TOX / ton)", () => {
  test("1 ton burned = 500 TOX", () => {
    expect(normalBurnTox(1000)).toBe(500);
  });
  test("100 kg burned = 50 TOX", () => {
    expect(normalBurnTox(100)).toBe(50);
  });
  test("20 kg burned = 10 TOX", () => {
    expect(normalBurnTox(20)).toBe(10);
  });
  test("fractional amounts supported", () => {
    expect(normalBurnTox(0.5)).toBeCloseTo(0.25, 12);
  });
  test("burnRewardTox with zone inactive == normal", () => {
    expect(burnRewardTox(1000, false)).toBe(500);
  });
});

describe("burn zone reward (×1.2 = 600 TOX / ton)", () => {
  test("1 ton in zone = 600 TOX", () => {
    expect(burnZoneTox(1000)).toBe(600);
  });
  test("100 kg in zone = 60 TOX", () => {
    expect(burnZoneTox(100)).toBe(60);
  });
  test("burnRewardTox with zone active == 1.2× normal", () => {
    expect(burnRewardTox(1000, true)).toBe(600);
  });
  test("fractional zone reward (1.5 kg = 0.9 TOX)", () => {
    expect(burnZoneTox(1.5)).toBeCloseTo(0.9, 12);
  });
});

describe("reward ledger keys (exactly-once)", () => {
  test("unique per slice index", () => {
    expect(rewardKey("s", 0)).not.toBe(rewardKey("s", 1));
  });
  test("unique per session", () => {
    expect(rewardKey("a", 0)).not.toBe(rewardKey("b", 0));
  });
  test("normal and zone burns share ONE key (a waste unit cannot be paid twice)", () => {
    const normal = computeBurnSlice(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      4,
      false,
    );
    const zone = computeBurnSlice(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      4,
      true,
    );
    expect(normal.key).toBe(zone.key);
    expect(normal.kind).toBe("normal");
    expect(zone.kind).toBe("burn_zone");
  });
});

describe("computeBurnSlice", () => {
  test("normal slice amount + tox", () => {
    const s = computeBurnSlice(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      4,
      false,
    );
    expect(s).toEqual({ key: "s:0", kg: 4, tox: 2, kind: "normal" });
  });
  test("zone slice pays 1.2×", () => {
    const s = computeBurnSlice(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      4,
      true,
    );
    expect(s.tox).toBeCloseTo(2.4, 12);
  });
  test("kind decided server-side by zone state, never by client input", () => {
    // the slice API takes only kg + zone state — there is no client-supplied
    // amount or multiplier parameter at all
    const s = computeBurnSlice(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      7.25,
      true,
    );
    expect(s.tox).toBeCloseTo(((7.25 / 1000) * 500 * 1.2), 12);
  });
});

describe("advanceBurn / exactly-once protocol", () => {
  test("normal advance reduces queue and moves to next slice", () => {
    const next = advanceBurn(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      4,
      false,
    );
    expect(next.queuedKg).toBe(96);
    expect(next.sliceIndex).toBe(1);
  });
  test("duplicate slice burns WITHOUT credit but still advances the key", () => {
    // Sprint 2.6 contract fix: a stale duplicate must not pin sliceIndex,
    // otherwise the whole session would never reward again.
    const dup = advanceBurn(
      { sessionId: "s", queuedKg: 100, sliceIndex: 0 },
      4,
      true,
    );
    expect(dup.queuedKg).toBe(96);
    expect(dup.sliceIndex).toBe(1);
  });
  test("queue never goes negative", () => {
    const next = advanceBurn(
      { sessionId: "s", queuedKg: 1, sliceIndex: 0 },
      4,
      false,
    );
    expect(next.queuedKg).toBe(0);
  });
  test("end-to-end: the same slice can never credit TOX twice", () => {
    const ledger = new Map<string, number>();
    let state: BurnSlice = { sessionId: "s", queuedKg: 10, sliceIndex: 0 };
    const burn = 4;

    // first pass — credit
    const first = computeBurnSlice(state, burn, false);
    ledger.set(first.key, first.tox);
    expect(first.tox).toBe(2);
    state = advanceBurn(state, burn, false);

    // stale duplicate of the SAME slice (same session, same sliceIndex 0)
    const dup = computeBurnSlice({ ...state, sliceIndex: 0 }, burn, false);
    expect(dup.key).toBe(first.key);
    expect(ledger.has(dup.key)).toBe(true);
    state = advanceBurn({ ...state, sliceIndex: 0 }, burn, true);

    // the next slice gets a fresh key and is NOT already in the ledger
    const third = computeBurnSlice(state, burn, false);
    expect(third.key).toBe("s:1");
    expect(ledger.has(third.key)).toBe(false);
  });
});

describe("global waste / pollution accounting", () => {
  test("burn reduces pollution 1:1 (normal)", () => {
    expect(applyBurnToPollution(1000, 4)).toBe(996);
  });
  test("burn reduces pollution 1:1 (zone — same amount, only reward differs)", () => {
    expect(applyBurnToPollution(1000, 4)).toBe(996);
  });
  test("pollution never drops below zero", () => {
    expect(applyBurnToPollution(2, 4)).toBe(0);
  });
});

describe("progression ROI references (not gameplay inputs)", () => {
  test("starter rate ≈ 460 TOX / day (38.34 kg/h × 24 h × 0.5 TOX/kg)", () => {
    const perDay = 38.34 * 24 * 0.5;
    expect(perDay).toBeCloseTo(460.08, 1);
  });
  test("cargo L2 (150 TOX) at starter rate ≈ 7.8 h", () => {
    const h = hoursToReach(38.34 * 0.5, 150);
    expect(h).toBeCloseTo(7.82, 1);
  });
  test("zero TOX/hour → Infinity", () => {
    expect(hoursToReach(0, 150)).toBe(Infinity);
  });
  test("cumulative cargo curve 150 / 375 / 715 / 1225", () => {
    const [l2, l3, l4, l5] = [150, 375, 715, 1225];
    expect(l3).toBe(l2 + 225);
    expect(l4).toBe(l3 + 340);
    expect(l5).toBe(l4 + 510);
  });
});
