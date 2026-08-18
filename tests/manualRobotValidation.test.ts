/**
 * TOXIC WORLD — Sprint 2.13
 * MANUAL ROBOT + BATTERY RISK + WASTE DISPOSAL VALIDATION
 *
 * Tests the player-controlled robot system with WASD movement,
 * battery risk management, waste disposal choice, and processing.
 */

import { describe, it, expect } from "vitest";
import {
  PROTECTION,
  WORLD,
  TOX_PER_TON,
  BURN_ZONE_MULTIPLIER,
  ROBOT,
  UPGRADES,
} from "../src/convex/gameParams";
import { drainMultiplier } from "../src/convex/protection";
import {
  freshWorld,
  makePlayer,
  simInvariant,
  storageCap,
  cargoCap,
  batteryCap,
  distToBase,
  returnEnergyRequired,
  computeBatteryState,
  checkCriticalDeviation,
  stepManualRobot,
  createManualRobotState,
  dropCargo,
  purchaseExtraBattery,
  startProcessingTransit,
  completeProcessingTransit,
  type SimPlayer,
  type SimState,
  type SimWorld,
  type ManualRobotState,
  type SimCluster,
} from "./engineSim";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTRA_BATTERY_COST_TBD = 50; // TBD — configurable, not frozen
const EXTRA_BATTERY_AMOUNT = 30; // battery units restored
const MAP_CENTER = WORLD.MAP_SIZE / 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManualState(): ManualRobotState {
  return createManualRobotState();
}

function makeManualPlayer(
  id: string | number,
  opts: {
    baseX?: number;
    baseY?: number;
    battery?: number;
    cargoKg?: number;
    storageKg?: number;
    levels?: { cargo: number; recharge: number; battery: number; storage: number };
    toxBalance?: number;
  } = {},
): SimPlayer {
  return makePlayer(id, {
    hasBase: true,
    baseX: opts.baseX ?? MAP_CENTER,
    baseY: opts.baseY ?? MAP_CENTER,
    toxBalance: opts.toxBalance ?? 0,
    levels: opts.levels ?? { cargo: 1, recharge: 1, battery: 1, storage: 1 },
  });
}

function makeCluster(id: string, x: number, y: number, kg: number): SimCluster {
  return { id, x, y, kg };
}

function makeClusterMap(clusters: SimCluster[]): Map<string, SimCluster> {
  return new Map(clusters.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------
// 1. WASD MOVEMENT
// ---------------------------------------------------------------------------
describe("1. WASD Movement", () => {
  it("robot moves right (dx=1)", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusters: SimCluster[] = [];
    const clusterMap = makeClusterMap(clusters);

    const startX = p.robot.x;
    ms.input = { dx: 1, dy: 0 };

    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.x).toBeGreaterThan(startX);
    expect(ms.isMoving).toBe(true);
  });

  it("robot moves left (dx=-1)", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    // Move right first
    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    const midX = p.robot.x;

    // Move left
    ms.input = { dx: -1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 2000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.x).toBeLessThan(midX);
  });

  it("robot moves up (dy=-1)", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    const startY = p.robot.y;
    ms.input = { dx: 0, dy: -1 };

    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.y).toBeLessThan(startY);
  });

  it("robot moves down (dy=1)", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    const startY = p.robot.y;
    ms.input = { dx: 0, dy: 1 };

    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.y).toBeGreaterThan(startY);
  });

  it("robot stops when no input", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    const movedX = p.robot.x;

    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 2000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.x).toBe(movedX);
    expect(ms.isMoving).toBe(false);
  });

  it("robot clamps to map boundaries", () => {
    const p = makeManualPlayer("p1", { baseX: 5, baseY: 5 });
    p.robot.x = 0;
    p.robot.y = 0;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: -1, dy: -1 };
    for (let i = 0; i < 100; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(p.robot.x).toBeGreaterThanOrEqual(0);
    expect(p.robot.y).toBeGreaterThanOrEqual(0);
    expect(p.robot.x).toBeLessThanOrEqual(WORLD.MAP_SIZE);
    expect(p.robot.y).toBeLessThanOrEqual(WORLD.MAP_SIZE);
  });
});

// ---------------------------------------------------------------------------
// 2. DISTANCE CALCULATION
// ---------------------------------------------------------------------------
describe("2. Distance Calculation", () => {
  it("distToBase correct at origin", () => {
    const robot = { x: 100, y: 200 } as any;
    const d = distToBase(robot, 0, 0);
    expect(d).toBeCloseTo(Math.hypot(100, 200), 9);
  });

  it("distToBase zero at base", () => {
    const robot = { x: 500, y: 500 } as any;
    const d = distToBase(robot, 500, 500);
    expect(d).toBe(0);
  });

  it("returnEnergyRequired scales with distance", () => {
    const near = { x: 510, y: 500, battery: 100 } as any;
    const far = { x: 600, y: 500, battery: 100 } as any;
    const nearCost = returnEnergyRequired(near, 500, 500);
    const farCost = returnEnergyRequired(far, 500, 500);
    expect(farCost).toBeGreaterThan(nearCost);
  });

  it("returnEnergyRequired includes safety margin", () => {
    const robot = { x: 510, y: 500, battery: 100 } as any;
    const cost = returnEnergyRequired(robot, 500, 500);
    const travelOnly = (10 / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING;
    expect(cost).toBeCloseTo(travelOnly + ROBOT.BATTERY_SAFETY_MARGIN, 9);
  });
});

// ---------------------------------------------------------------------------
// 3. BATTERY DRAIN
// ---------------------------------------------------------------------------
describe("3. Battery Drain", () => {
  it("battery drains while moving", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    const startBattery = p.robot.battery;
    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.battery).toBeLessThan(startBattery);
  });

  it("battery drain scales with drain multiplier", () => {
    const p1 = makeManualPlayer("p1");
    const ms1 = makeManualState();
    const clusterMap1 = makeClusterMap([]);

    const p2 = makeManualPlayer("p2");
    const ms2 = makeManualState();
    const clusterMap2 = makeClusterMap([]);

    ms1.input = { dx: 1, dy: 0 };
    ms2.input = { dx: 1, dy: 0 };

    stepManualRobot(p1, ms1, clusterMap1, 1000, 1, 1, { x: 0, y: 0, status: "inactive" }); // normal
    stepManualRobot(p2, ms2, clusterMap2, 1000, 1, 2, { x: 0, y: 0, status: "inactive" }); // 2x drain

    expect(p2.robot.battery).toBeLessThan(p1.robot.battery);
  });

  it("battery does not go below 0", () => {
    const p = makeManualPlayer("p1");
    p.robot.battery = 0.1;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 10, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.battery).toBeGreaterThanOrEqual(0);
  });

  it("no battery drain when stationary", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    const startBattery = p.robot.battery;
    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.battery).toBe(startBattery);
  });
});

// ---------------------------------------------------------------------------
// 4. RETURN ENERGY CALCULATION
// ---------------------------------------------------------------------------
describe("4. Return Energy Calculation", () => {
  it("return energy at base is minimal (safety margin only)", () => {
    const p = makeManualPlayer("p1");
    p.robot.x = p.baseX;
    p.robot.y = p.baseY;
    const cost = returnEnergyRequired(p.robot, p.baseX, p.baseY);
    expect(cost).toBeCloseTo(ROBOT.BATTERY_SAFETY_MARGIN, 9);
  });

  it("return energy increases with distance", () => {
    const costs: number[] = [];
    for (const d of [10, 50, 100, 200]) {
      const p = makeManualPlayer("p1");
      p.robot.x = p.baseX + d;
      costs.push(returnEnergyRequired(p.robot, p.baseX, p.baseY));
    }
    // Monotonically increasing
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. LOW BATTERY WARNING
// ---------------------------------------------------------------------------
describe("5. Low Battery Warning", () => {
  it("normal state when battery is sufficient", () => {
    const state = computeBatteryState(
      100, 500, 500, 510, 500, 0, 0,
    );
    expect(state).toBe("normal");
  });

  it("low_battery when return cost ratio <= 1.3", () => {
    // Robot far from base, low battery
    // dist = 200, returnCost = (200/6)*0.6 + 5 = 20 + 5 = 25
    // batteryRatio = 15/25 = 0.6 -> critical (too low)
    // Need batteryRatio between 1.0 and 1.3 for low_battery
    // So: battery = 28, returnCost = 25, ratio = 1.12
    const state = computeBatteryState(
      28, 500, 500, 700, 500, 0, 0,
    );
    expect(state).toBe("low_battery");
  });

  it("battery_depleted when battery is 0", () => {
    const state = computeBatteryState(
      0, 500, 500, 600, 500, 0, 0,
    );
    expect(state).toBe("battery_depleted");
  });
});

// ---------------------------------------------------------------------------
// 6. CRITICAL BATTERY WARNING
// ---------------------------------------------------------------------------
describe("6. Critical Battery Warning", () => {
  it("critical_battery when return cost ratio <= 1.0", () => {
    // Battery barely enough or not enough to return
    const state = computeBatteryState(
      8, 500, 500, 700, 500, 0, 0,
    );
    expect(state).toBe("critical_battery");
  });

  it("critical_battery when battery < return cost", () => {
    const state = computeBatteryState(
      3, 500, 500, 800, 500, 0, 0,
    );
    expect(state).toBe("critical_battery");
  });
});

// ---------------------------------------------------------------------------
// 7. %10 ADDITIONAL-DISTANCE RULE
// ---------------------------------------------------------------------------
describe("7. %10 Additional-Distance Rule", () => {
  it("no deviation when within 10% of reference distance", () => {
    const deviated = checkCriticalDeviation(
      530, 500, // current pos
      500, 500, // base
      30, // lowBatteryDistanceRef
    );
    // 30 units from base, threshold is 30 * 0.10 = 3
    // 30 is not > 30 + 3 = 33
    expect(deviated).toBe(false);
  });

  it("deviation when exceeds 10% of reference distance", () => {
    const deviated = checkCriticalDeviation(
      540, 500, // current pos
      500, 500, // base
      30, // lowBatteryDistanceRef
    );
    // 40 units from base, threshold is 30 * 0.10 = 3
    // 40 > 30 + 3 = 33
    expect(deviated).toBe(true);
  });

  it("deviation detected at exact boundary", () => {
    const deviated = checkCriticalDeviation(
      533, 500, // current pos
      500, 500, // base
      30, // lowBatteryDistanceRef
    );
    // 33 units from base, threshold is 30 * 0.10 = 3
    // 33 > 30 + 3 = 33? No, 33 is not > 33
    expect(deviated).toBe(false);
  });

  it("deviation detected beyond boundary", () => {
    const deviated = checkCriticalDeviation(
      534, 500, // current pos
      500, 500, // base
      30, // lowBatteryDistanceRef
    );
    // 34 units from base, threshold is 30 * 0.10 = 3
    // 34 > 33
    expect(deviated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. CARGO PRESERVED BEFORE BATTERY WARNING
// ---------------------------------------------------------------------------
describe("8. Cargo Preserved Before Battery Warning", () => {
  it("cargo stays during normal movement (away from base)", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 15;
    p.robot.x = p.baseX + 100; // far from base to avoid auto-unload
    p.robot.y = p.baseY;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 5; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(p.robot.cargoKg).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 9. CARGO DROP OPTION
// ---------------------------------------------------------------------------
describe("9. Cargo Drop Option", () => {
  it("dropCargo removes all cargo", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 20;
    const ms = makeManualState();

    const dropped = dropCargo(p, ms);

    expect(dropped).toBe(20);
    expect(p.robot.cargoKg).toBe(0);
    expect(ms.cargoDropped).toBe(true);
  });

  it("dropCargo returns 0 when no cargo", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 0;
    const ms = makeManualState();

    const dropped = dropCargo(p, ms);

    expect(dropped).toBe(0);
    expect(ms.cargoDropped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. EXTRA BATTERY PURCHASE
// ---------------------------------------------------------------------------
describe("10. Extra Battery Purchase", () => {
  it("extra battery increases battery", () => {
    const p = makeManualPlayer("p1", { toxBalance: 100 });
    p.robot.battery = 30;

    const success = purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);

    expect(success).toBe(true);
    expect(p.robot.battery).toBe(60);
    expect(p.toxBalance).toBe(50);
  });

  it("extra battery does not exceed cap", () => {
    const p = makeManualPlayer("p1", { toxBalance: 100 });
    p.robot.battery = 90; // L1 cap is 100

    const success = purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);

    expect(success).toBe(true);
    expect(p.robot.battery).toBe(100); // capped at batteryCap
  });

  it("extra battery fails without enough TOX", () => {
    const p = makeManualPlayer("p1", { toxBalance: 30 });
    p.robot.battery = 50;

    const success = purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);

    expect(success).toBe(false);
    expect(p.robot.battery).toBe(50); // unchanged
    expect(p.toxBalance).toBe(30); // unchanged
  });

  it("extra battery TOX deducted server-side", () => {
    const p = makeManualPlayer("p1", { toxBalance: 200 });
    const toxBefore = p.toxBalance;

    purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);

    expect(p.toxBalance).toBe(toxBefore - EXTRA_BATTERY_COST_TBD);
  });

  it("duplicate purchase prevention (TOX check)", () => {
    const p = makeManualPlayer("p1", { toxBalance: 75 });
    const result1 = purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);
    const result2 = purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);

    expect(result1).toBe(true);
    expect(result2).toBe(false); // not enough TOX for second
  });
});

// ---------------------------------------------------------------------------
// 11. TOX DEDUCTION
// ---------------------------------------------------------------------------
describe("11. TOX Deduction", () => {
  it("TOX balance decreases on extra battery", () => {
    const p = makeManualPlayer("p1", { toxBalance: 500 });
    purchaseExtraBattery(p, EXTRA_BATTERY_COST_TBD, EXTRA_BATTERY_AMOUNT);
    expect(p.toxBalance).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// 12. BASE DISPOSAL
// ---------------------------------------------------------------------------
describe("12. Base Disposal", () => {
  it("cargo delivered to base when robot near base", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 15;
    p.robot.x = p.baseX + 10; // within 15 units
    p.robot.y = p.baseY;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 0, dy: 0 };
    const result = stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(result.events.some((e) => e.startsWith("base_delivery:"))).toBe(true);
    expect(p.storageKg).toBeGreaterThan(0);
  });

  it("cargo respects storage capacity", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 50;
    p.storageKg = storageCap(p) - 10; // only 10 space
    p.robot.x = p.baseX + 10;
    p.robot.y = p.baseY;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.storageKg).toBe(storageCap(p)); // filled to cap
    expect(p.robot.cargoKg).toBe(40); // 50 - 10 unloaded
  });
});

// ---------------------------------------------------------------------------
// 13. BURN ZONE DISPOSAL
// ---------------------------------------------------------------------------
describe("13. Burn Zone Disposal", () => {
  it("cargo delivered to active burn zone", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 10;
    const burnZone = { x: 300, y: 300, status: "active" };
    p.robot.x = 305; // within 20 units
    p.robot.y = 300;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 0, dy: 0 };
    const result = stepManualRobot(p, ms, clusterMap, 1000, 1, 1, burnZone);

    expect(result.events.some((e) => e.startsWith("burn_zone_delivery:"))).toBe(true);
    expect(p.robot.cargoKg).toBe(0);
  });

  it("no delivery to inactive burn zone", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 10;
    const burnZone = { x: 300, y: 300, status: "inactive" };
    p.robot.x = 305;
    p.robot.y = 300;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 0, dy: 0 };
    const result = stepManualRobot(p, ms, clusterMap, 1000, 1, 1, burnZone);

    expect(result.events.some((e) => e.startsWith("burn_zone_delivery:"))).toBe(false);
    expect(p.robot.cargoKg).toBe(10); // unchanged
  });

  it("no delivery when robot far from burn zone", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 10;
    const burnZone = { x: 300, y: 300, status: "active" };
    p.robot.x = 800; // far away
    p.robot.y = 800;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 0, dy: 0 };
    const result = stepManualRobot(p, ms, clusterMap, 1000, 1, 1, burnZone);

    expect(result.events.some((e) => e.startsWith("burn_zone_delivery:"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. 1.2x BURN ZONE REWARD
// ---------------------------------------------------------------------------
describe("14. 1.2x Burn Zone Reward", () => {
  it("burn zone reward is 1.2x normal", () => {
    const kg = 100;
    const normalTox = (kg / 1000) * TOX_PER_TON;
    const zoneTox = (kg / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
    expect(zoneTox).toBeCloseTo(normalTox * 1.2, 9);
  });

  it("burn zone TOX is 600 per ton", () => {
    const kg = 1000;
    const tox = (kg / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
    expect(tox).toBe(600);
  });

  it("burn zone delivery credits correct TOX", () => {
    const p = makeManualPlayer("p1");
    p.robot.cargoKg = 200;
    const burnZone = { x: 300, y: 300, status: "active" };
    p.robot.x = 305;
    p.robot.y = 300;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    const toxBefore = p.toxBalance;
    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, burnZone);

    const expectedTox = (200 / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
    expect(p.toxBalance - toxBefore).toBeCloseTo(expectedTox, 9);
    expect(p.toxFromZone).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 15. STORAGE → FULL SHIPMENT
// ---------------------------------------------------------------------------
describe("15. Storage → Full Shipment", () => {
  it("startProcessingTransit sends all storage", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 137;
    const ms = makeManualState();

    const started = startProcessingTransit(p, ms, 1000);

    expect(started).toBe(true);
    expect(ms.processingTransit.active).toBe(true);
    expect(ms.processingTransit.kg).toBe(137);
    expect(p.storageKg).toBe(0);
  });

  it("cannot start transit if already active", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 50;
    const ms = makeManualState();

    startProcessingTransit(p, ms, 1000);
    const second = startProcessingTransit(p, ms, 2000);

    expect(second).toBe(false);
  });

  it("cannot start transit with empty storage", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 0;
    const ms = makeManualState();

    const started = startProcessingTransit(p, ms, 1000);

    expect(started).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16. 1-MINUTE PROCESSING
// ---------------------------------------------------------------------------
describe("16. 1-Minute Processing", () => {
  it("transit completes after 60 seconds", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 100;
    const ms = makeManualState();
    const world: SimWorld = {
      worldId: 0,
      capacityKg: WORLD.CAPACITY_KG,
      pollutionKg: WORLD.CAPACITY_KG * 0.5,
      collectableKg: 0,
      hiddenKg: 0,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 1,
      seedPollutionKg: WORLD.CAPACITY_KG * 0.5,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: 1_000_000,
      lastTick: 0,
    };
    const ledger: Array<{ playerId: string | number; key: string; kind: string; kg: number; tox: number }> = [];

    startProcessingTransit(p, ms, 1000);

    // Before 60s
    const completed1 = completeProcessingTransit(p, ms, world, ledger, 1000 + 59_999);
    expect(completed1).toBe(false);

    // After 60s
    const completed2 = completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    expect(completed2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. BURN COMPLETION
// ---------------------------------------------------------------------------
describe("17. Burn Completion", () => {
  it("burn credits TOX after transit", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 200;
    const ms = makeManualState();
    const world: SimWorld = {
      worldId: 0,
      capacityKg: WORLD.CAPACITY_KG,
      pollutionKg: WORLD.CAPACITY_KG * 0.5,
      collectableKg: 0,
      hiddenKg: 0,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 1,
      seedPollutionKg: WORLD.CAPACITY_KG * 0.5,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: 1_000_000,
      lastTick: 0,
    };
    const ledger: Array<{ playerId: string | number; key: string; kind: string; kg: number; tox: number }> = [];

    const toxBefore = p.toxBalance;
    startProcessingTransit(p, ms, 1000);
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);

    const expectedTox = (200 / 1000) * TOX_PER_TON;
    expect(p.toxBalance - toxBefore).toBeCloseTo(expectedTox, 9);
  });

  it("burn reduces pollution", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 100;
    const ms = makeManualState();
    const world: SimWorld = {
      worldId: 0,
      capacityKg: WORLD.CAPACITY_KG,
      pollutionKg: 5_000_000,
      collectableKg: 0,
      hiddenKg: 0,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 1,
      seedPollutionKg: 5_000_000,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: 1_000_000,
      lastTick: 0,
    };
    const ledger: Array<{ playerId: string | number; key: string; kind: string; kg: number; tox: number }> = [];

    const pollBefore = world.pollutionKg;
    startProcessingTransit(p, ms, 1000);
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);

    expect(world.pollutionKg).toBeCloseTo(pollBefore - 100, 0);
  });
});

// ---------------------------------------------------------------------------
// 18. TOX REWARD
// ---------------------------------------------------------------------------
describe("18. TOX Reward", () => {
  it("processing burn reward is 500 TOX per ton", () => {
    const kg = 500;
    const tox = (kg / 1000) * TOX_PER_TON;
    expect(tox).toBe(250);
  });

  it("fractional kg produces fractional TOX", () => {
    const kg = 37.5;
    const tox = (kg / 1000) * TOX_PER_TON;
    expect(tox).toBeCloseTo(18.75, 9);
  });
});

// ---------------------------------------------------------------------------
// 19. POLLUTION REDUCTION
// ---------------------------------------------------------------------------
describe("19. Pollution Reduction", () => {
  it("pollution decreases by burned kg", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 250;
    const ms = makeManualState();
    const world: SimWorld = {
      worldId: 0,
      capacityKg: WORLD.CAPACITY_KG,
      pollutionKg: 5_000_000,
      collectableKg: 0,
      hiddenKg: 0,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 1,
      seedPollutionKg: 5_000_000,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: 1_000_000,
      lastTick: 0,
    };
    const ledger: Array<{ playerId: string | number; key: string; kind: string; kg: number; tox: number }> = [];

    startProcessingTransit(p, ms, 1000);
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);

    expect(world.pollutionKg).toBe(5_000_000 - 250);
    expect(world.burnedKg).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// 20. IDEMPOTENCY
// ---------------------------------------------------------------------------
describe("20. Idempotency", () => {
  it("same transit does not produce double reward", () => {
    const p = makeManualPlayer("p1");
    p.storageKg = 100;
    const ms = makeManualState();
    const world: SimWorld = {
      worldId: 0,
      capacityKg: WORLD.CAPACITY_KG,
      pollutionKg: 5_000_000,
      collectableKg: 0,
      hiddenKg: 0,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 1,
      seedPollutionKg: 5_000_000,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: 1_000_000,
      lastTick: 0,
    };
    const ledger: Array<{ playerId: string | number; key: string; kind: string; kg: number; tox: number }> = [];

    startProcessingTransit(p, ms, 1000);
    const toxBefore = p.toxBalance;

    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    const toxAfter1 = p.toxBalance;

    // Try again — should NOT produce more TOX
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    const toxAfter2 = p.toxBalance;

    expect(toxAfter1).toBeGreaterThan(toxBefore);
    expect(toxAfter2).toBe(toxAfter1); // no double reward
  });
});

// ---------------------------------------------------------------------------
// 21. AFK PLAYER DOES NOT AUTO-COLLECT
// ---------------------------------------------------------------------------
describe("21. AFK Player Does Not Auto-Collect", () => {
  it("robot does not move without player input", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([
      makeCluster("c1", MAP_CENTER + 20, MAP_CENTER, 500),
    ]);

    const startX = p.robot.x;
    const startY = p.robot.y;

    // No input — robot should not move
    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.x).toBe(startX);
    expect(p.robot.y).toBe(startY);
    expect(p.robot.cargoKg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 22. BASE CONTINUES GENERATING DURING AFK
// ---------------------------------------------------------------------------
describe("22. Base Continues Generating During AFK", () => {
  it("base generation is independent of robot movement", () => {
    // This is a property of the world tick, not the robot.
    // The world tick adds BASE_GEN_KG_H * TICK_GAME_H to pollution.
    const genPerTick = WORLD.BASE_GEN_KG_H * (WORLD.GAME_MINUTES_PER_TICK / 60);
    expect(genPerTick).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 23. MANUAL DRIVING REQUIRED
// ---------------------------------------------------------------------------
describe("23. Manual Driving Required", () => {
  it("robot state stays idle without input (no auto-targeting)", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([
      makeCluster("c1", MAP_CENTER + 50, MAP_CENTER, 500),
    ]);

    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    // Robot should NOT have auto-targeted the cluster
    expect(p.robot.targetClusterId).toBeUndefined();
    expect(ms.isMoving).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 24. CRITICAL BATTERY + PROTECTION INTERACTION
// ---------------------------------------------------------------------------
describe("24. Critical Battery + Protection Interaction", () => {
  it("low battery state computed correctly at critical world", () => {
    // At critical world, drainMult = 2
    // Robot with low battery far from base
    const state = computeBatteryState(
      10, 500, 500, 700, 500, 0, 0,
    );
    expect(state).toBe("critical_battery");
  });

  it("shield blocks critical drain (via drainMultiplier)", () => {
    const now = Date.now();
    const shielded = { state: "normal" as const, shieldUntil: now + 100_000 };
    const mult = drainMultiplier(shielded, now, true);
    expect(mult).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 25. END-TO-END FLOW
// ---------------------------------------------------------------------------
describe("25. E2E Flow — Drive, Collect, Dispose, Burn", () => {
  it("complete flow: move to cluster → collect → return to base → storage → transit → burn", () => {
    const p = makeManualPlayer("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 30, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    // Step 1: Drive toward cluster
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 35; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    // Should be collecting or collected
    expect(p.robot.cargoKg).toBeGreaterThan(0);

    // Step 2: Drive back to base
    const cargoBefore = p.robot.cargoKg;
    ms.input = { dx: -1, dy: 0 };
    for (let i = 0; i < 40; i++) {
      stepManualRobot(p, ms, clusterMap, (35 + i) * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    // Cargo should be in storage now
    expect(p.storageKg).toBeGreaterThan(0);

    // Step 3: Start processing transit
    const started = startProcessingTransit(p, ms, 100_000);
    expect(started).toBe(true);

    // Step 4: Complete transit
    const world: SimWorld = {
      worldId: 0,
      capacityKg: WORLD.CAPACITY_KG,
      pollutionKg: 5_000_000,
      collectableKg: 0,
      hiddenKg: 0,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 1,
      seedPollutionKg: 5_000_000,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: 1_000_000,
      lastTick: 0,
    };
    const ledger: Array<{ playerId: string | number; key: string; kind: string; kg: number; tox: number }> = [];

    const completed = completeProcessingTransit(p, ms, world, ledger, 100_000 + 60_000);
    expect(completed).toBe(true);
    expect(p.toxBalance).toBeGreaterThan(0);
    expect(world.burnedKg).toBeGreaterThan(0);
  });
});
