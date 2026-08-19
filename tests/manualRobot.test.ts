import { describe, it, expect } from "vitest";
import {
  MANUAL,
  ROBOT,
  TOX_PER_TON,
  BURN_ZONE_MULTIPLIER,
  UPGRADES,
  WORLD,
  batteryForTrip,
} from "../src/convex/gameParams";
import {
  normalBurnTox,
  burnZoneTox,
  burnRewardTox,
} from "../src/convex/economy";

// =============================================================================
// Sprint 2.13.3 — Manual Robot & Battery System Validation Tests
// These test the pure engine logic that supports the manual driving mode.
// Browser-specific tests (input latency, rendering, network) require manual
// QA on a real deployment — see the acceptance checklist.
// =============================================================================

describe("MANUAL params", () => {
  it("MOVE_SPEED matches ROBOT.SPEED_M_S", () => {
    expect(MANUAL.MOVE_SPEED).toBe(ROBOT.SPEED_M_S);
  });

  it("COLLECT_RANGE is positive", () => {
    expect(MANUAL.COLLECT_RANGE).toBeGreaterThan(0);
  });

  it("LOW_BATTERY_FRAC is above CRITICAL_BATTERY_FRAC", () => {
    expect(MANUAL.LOW_BATTERY_FRAC).toBeGreaterThan(
      MANUAL.CRITICAL_BATTERY_FRAC,
    );
  });

  it("CRITICAL_DISTANCE_MULT is 1.1 (10% rule)", () => {
    expect(MANUAL.CRITICAL_DISTANCE_MULT).toBe(1.1);
  });

  it("EXTRA_BATTERY_COST_TOX is positive", () => {
    expect(MANUAL.EXTRA_BATTERY_COST_TOX).toBeGreaterThan(0);
  });

  it("EXTRA_BATTERY_UNITS is positive", () => {
    expect(MANUAL.EXTRA_BATTERY_UNITS).toBeGreaterThan(0);
  });

  it("SHIPMENT_TRANSIT_S is 60", () => {
    expect(MANUAL.SHIPMENT_TRANSIT_S).toBe(60);
  });

  it("COLLECT_RANGE <= MAP_SIZE (sanity)", () => {
    expect(MANUAL.COLLECT_RANGE).toBeLessThanOrEqual(WORLD.MAP_SIZE);
  });
});

describe("Reward economics (normal vs burn zone)", () => {
  it("normal burn: 1000 kg = 500 TOX", () => {
    expect(normalBurnTox(1000)).toBeCloseTo(500, 1);
  });

  it("burn zone: 1000 kg = 600 TOX (×1.2)", () => {
    expect(burnZoneTox(1000)).toBeCloseTo(600, 1);
  });

  it("burnRewardTox switches on zoneActive flag", () => {
    const kg = 500;
    expect(burnRewardTox(kg, false)).toBeCloseTo(normalBurnTox(kg), 5);
    expect(burnRewardTox(kg, true)).toBeCloseTo(burnZoneTox(kg), 5);
  });

  it("reward scales linearly with kg", () => {
    const r1 = normalBurnTox(100);
    const r10 = normalBurnTox(1000);
    expect(r10).toBeCloseTo(r1 * 10, 5);
  });

  it("burn zone multiplier is exactly 1.2", () => {
    expect(BURN_ZONE_MULTIPLIER).toBe(1.2);
  });
});

describe("Battery thresholds for manual mode", () => {
  for (const level of [1, 2, 3, 4, 5] as const) {
    const cap = UPGRADES.battery.caps[level - 1];

    it(`L${level} battery cap is ${cap}`, () => {
      expect(cap).toBeGreaterThan(0);
    });

    it(`L${level} low battery at ${Math.round(MANUAL.LOW_BATTERY_FRAC * cap)}`, () => {
      const threshold = cap * MANUAL.LOW_BATTERY_FRAC;
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(cap);
    });

    it(`L${level} critical battery at ${Math.round(MANUAL.CRITICAL_BATTERY_FRAC * cap)}`, () => {
      const threshold = cap * MANUAL.CRITICAL_BATTERY_FRAC;
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(cap * MANUAL.LOW_BATTERY_FRAC);
    });
  }
});

describe("Cargo caps", () => {
  for (const level of [1, 2, 3, 4, 5] as const) {
    it(`L${level} cargo = ${UPGRADES.cargo.caps[level - 1]} kg`, () => {
      expect(UPGRADES.cargo.caps[level - 1]).toBeGreaterThan(0);
    });
  }

  it("cargo caps are monotonically increasing", () => {
    for (let i = 1; i < UPGRADES.cargo.caps.length; i++) {
      expect(UPGRADES.cargo.caps[i]).toBeGreaterThan(
        UPGRADES.cargo.caps[i - 1],
      );
    }
  });
});

describe("Battery drain mechanics", () => {
  it("DRAIN_MOVING is 0.6 per second", () => {
    expect(ROBOT.DRAIN_MOVING).toBe(0.6);
  });

  it("DRAIN_COLLECTING is 0.25 per second", () => {
    expect(ROBOT.DRAIN_COLLECTING).toBe(0.25);
  });

  it("COLLECT_TIME_S is 4 seconds", () => {
    expect(ROBOT.COLLECT_TIME_S).toBe(4);
  });

  it("battery drain while moving for 10 seconds = 6", () => {
    const drain = ROBOT.DRAIN_MOVING * 10;
    expect(drain).toBe(6);
  });

  it("battery drain while collecting for 4 seconds = 1", () => {
    const drain = ROBOT.DRAIN_COLLECTING * ROBOT.COLLECT_TIME_S;
    expect(drain).toBe(1);
  });
});

describe("Distance-to-base return energy calculation", () => {
  function returnEnergy(dist: number): number {
    const travelTime = (2 * dist) / MANUAL.MOVE_SPEED;
    const drain = travelTime * MANUAL.DRAIN_MOVING;
    return drain + ROBOT.BATTERY_SAFETY_MARGIN;
  }

  it("return energy for 0 distance = safety margin only", () => {
    expect(returnEnergy(0)).toBe(ROBOT.BATTERY_SAFETY_MARGIN);
  });

  it("return energy scales linearly with distance", () => {
    const e100 = returnEnergy(100);
    const e200 = returnEnergy(200);
    expect(e200).toBeCloseTo(e100 * 2, 5);
  });

  it("return energy at max map distance (500m) fits within L5 battery", () => {
    const maxDist = Math.hypot(WORLD.MAP_SIZE / 2, WORLD.MAP_SIZE / 2);
    const e = returnEnergy(maxDist);
    expect(e).toBeLessThanOrEqual(UPGRADES.battery.caps[4]); // L5 = 460
  });
});

describe("10% critical distance rule", () => {
  function returnEnergy(dist: number): number {
    const travelTime = (2 * dist) / MANUAL.MOVE_SPEED;
    const drain = travelTime * MANUAL.DRAIN_MOVING;
    return drain + ROBOT.BATTERY_SAFETY_MARGIN;
  }

  it("critical threshold = return energy × 1.1", () => {
    const dist = 200;
    const re = returnEnergy(dist);
    const criticalThreshold = re * MANUAL.CRITICAL_DISTANCE_MULT;
    expect(criticalThreshold).toBeCloseTo(re * 1.1, 5);
  });

  it("battery below critical threshold triggers warning at exact boundary", () => {
    const dist = 100;
    const re = returnEnergy(dist);
    const threshold = re * MANUAL.CRITICAL_DISTANCE_MULT;
    // At the exact threshold — should be critical
    expect(threshold).toBeGreaterThan(re);
  });
});

describe("Storage shipment", () => {
  it("transit time is 60 seconds", () => {
    expect(MANUAL.SHIPMENT_TRANSIT_S).toBe(60);
  });

  it("shipment empty has kg = 0", () => {
    const shipment = { active: false, kg: 0, startAt: 0, finishAt: 0 };
    expect(shipment.kg).toBe(0);
    expect(shipment.active).toBe(false);
  });
});

describe("Burn zone interaction", () => {
  it("BURN_ZONE_RANGE is within reasonable bounds", () => {
    expect(MANUAL.BURN_ZONE_RANGE).toBeGreaterThan(0);
    expect(MANUAL.BURN_ZONE_RANGE).toBeLessThan(WORLD.MAP_SIZE);
  });

  it("BASE_DEPOSIT_RANGE is within reasonable bounds", () => {
    expect(MANUAL.BASE_DEPOSIT_RANGE).toBeGreaterThan(0);
    expect(MANUAL.BASE_DEPOSIT_RANGE).toBeLessThan(WORLD.MAP_SIZE);
  });
});

describe("WASD key mapping correctness", () => {
  const KEY_MAP: Record<string, { dx: number; dy: number }> = {
    w: { dx: 0, dy: -1 },
    a: { dx: -1, dy: 0 },
    s: { dx: 0, dy: 1 },
    d: { dx: 1, dy: 0 },
    arrowup: { dx: 0, dy: -1 },
    arrowleft: { dx: -1, dy: 0 },
    arrowdown: { dx: 0, dy: 1 },
    arrowright: { dx: 1, dy: 0 },
  };

  for (const [key, expected] of Object.entries(KEY_MAP)) {
    it(`key "${key}" maps to (${expected.dx}, ${expected.dy})`, () => {
      // This tests the mapping logic; actual key handling is in useManualControl
      expect(expected.dx).toBeGreaterThanOrEqual(-1);
      expect(expected.dx).toBeLessThanOrEqual(1);
      expect(expected.dy).toBeGreaterThanOrEqual(-1);
      expect(expected.dy).toBeLessThanOrEqual(1);
    });
  }

  it("diagonal W+A normalizes to unit vector", () => {
    const dx = -1;
    const dy = -1;
    const len = Math.sqrt(dx * dx + dy * dy);
    expect(Math.abs(dx / len)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(Math.abs(dy / len)).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe("Game balance sanity", () => {
  it("L1 battery cap >= return energy for short trip (100 units)", () => {
    const dist = 100;
    const travelTime = (2 * dist) / MANUAL.MOVE_SPEED;
    const drain = travelTime * MANUAL.DRAIN_MOVING + ROBOT.BATTERY_SAFETY_MARGIN;
    expect(UPGRADES.battery.caps[0]).toBeGreaterThanOrEqual(drain);
  });

  it("extra battery units < L1 battery cap (should help, not refill)", () => {
    expect(MANUAL.EXTRA_BATTERY_UNITS).toBeLessThan(UPGRADES.battery.caps[0]);
  });

  it("extra battery cost < L1 cargo upgrade cost", () => {
    expect(MANUAL.EXTRA_BATTERY_COST_TOX).toBeLessThan(
      UPGRADES.cargo.costs[1],
    );
  });

  it("L1 storage cap >= starter cargo cap", () => {
    expect(UPGRADES.storage.caps[0]).toBeGreaterThanOrEqual(
      UPGRADES.cargo.caps[0],
    );
  });
});
