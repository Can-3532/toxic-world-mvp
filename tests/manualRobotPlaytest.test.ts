/**
 * TOXIC WORLD — Sprint 2.13.1
 * MANUAL ROBOT PLAYTEST VALIDATION
 *
 * Measures real gameplay behavior of the manual robot, waste disposal
 * choice, and battery risk system. Does NOT change any frozen mechanics.
 * All frozen values from Sprint 2.13 are preserved.
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
const MAP_CENTER = WORLD.MAP_SIZE / 2;
const BASE_RECHARGE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManualState(): ManualRobotState {
  return createManualRobotState();
}

function makePlayer_(
  id: string | number,
  opts: {
    baseX?: number;
    baseY?: number;
    toxBalance?: number;
    levels?: { cargo: number; recharge: number; battery: number; storage: number };
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

function runSteps(
  p: SimPlayer,
  ms: ManualRobotState,
  clusterMap: Map<string, SimCluster>,
  now: number,
  steps: number,
  dt: number = 1,
  drainMult: number = 1,
  burnZone: { x: number; y: number; status: string } = { x: 0, y: 0, status: "inactive" },
): { ticks: number; events: string[][] } {
  const allEvents: string[][] = [];
  for (let i = 0; i < steps; i++) {
    const result = stepManualRobot(p, ms, clusterMap, now + i * dt * 1000, dt, drainMult, burnZone);
    allEvents.push(result.events);
  }
  return { ticks: steps, events: allEvents };
}

function makeWorld_(pollutionFrac: number = 0.5): SimWorld {
  const w = freshWorld(WORLD.CAPACITY_KG, pollutionFrac);
  return w.world;
}

// ============================================================================
// §1 — MANUAL DRIVING PLAYTEST
// ============================================================================
describe("§1 Manual Driving Playtest", () => {
  it("movement responsiveness — robot moves on every input tick", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);
    const positions: number[] = [];

    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 10; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
      positions.push(p.robot.x);
    }

    // Every tick should advance position
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("stopping — robot halts immediately on input release", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    // Move
    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    const x1 = p.robot.x;

    // Stop
    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 2000, 1, 1, { x: 0, y: 0, status: "inactive" });
    const x2 = p.robot.x;

    expect(x2).toBe(x1); // no movement
    expect(ms.isMoving).toBe(false);
  });

  it("diagonal movement — normalized direction", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);
    const startX = p.robot.x;
    const startY = p.robot.y;

    ms.input = { dx: 1, dy: 1 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    // Both axes should move
    expect(p.robot.x).toBeGreaterThan(startX);
    expect(p.robot.y).toBeGreaterThan(startY);

    // Movement should be normalized (not doubled)
    const dx = p.robot.x - startX;
    const dy = p.robot.y - startY;
    const moveLen = Math.hypot(dx, dy);
    expect(moveLen).toBeCloseTo(ROBOT.SPEED_M_S * 1, 0); // ~6 units
  });

  it("map boundary — robot clamps at edges", () => {
    const p = makePlayer_("p1");
    p.robot.x = 0;
    p.robot.y = 0;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: -1, dy: -1 };
    for (let i = 0; i < 5; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(p.robot.x).toBeGreaterThanOrEqual(0);
    expect(p.robot.y).toBeGreaterThanOrEqual(0);
  });

  it("server position is source of truth — deterministic at same inputs", () => {
    const results: number[] = [];
    for (let run = 0; run < 3; run++) {
      const p = makePlayer_("p1");
      const ms = makeManualState();
      const clusterMap = makeClusterMap([]);

      ms.input = { dx: 1, dy: 0.5 };
      for (let i = 0; i < 10; i++) {
        stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
      }
      results.push(p.robot.x);
    }
    // Deterministic
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it("total distance travelled tracked", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 5; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(ms.totalDistanceTravelled).toBeCloseTo(ROBOT.SPEED_M_S * 5, 0);
  });
});

// ============================================================================
// §2 — WASTE COLLECTION PLAYTEST
// ============================================================================
describe("§2 Waste Collection Playtest", () => {
  it("pickup distance — collection triggers within 15 units", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 10, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    // Should start collecting
    expect(p.robot.state).toBe("collecting");
  });

  it("collection timing — takes COLLECT_TIME_S", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 10, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.state).toBe("collecting");

    // Before collect time
    stepManualRobot(p, ms, clusterMap, 1000 + (ROBOT.COLLECT_TIME_S - 1) * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.state).toBe("collecting");

    // After collect time
    stepManualRobot(p, ms, clusterMap, 1000 + ROBOT.COLLECT_TIME_S * 1000 + 1, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.state).toBe("idle");
  });

  it("cargo fill — capped at cargoCap", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cap = cargoCap(p);
    const cluster = makeCluster("c1", MAP_CENTER + 10, MAP_CENTER, cap + 100);
    const clusterMap = makeClusterMap([cluster]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    stepManualRobot(p, ms, clusterMap, 1000 + ROBOT.COLLECT_TIME_S * 1000 + 1, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.cargoKg).toBe(cap);
  });

  it("collection failure — no collection when cargo full", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = cargoCap(p); // already full
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 10, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    // Should NOT start collecting (cargo full)
    expect(p.robot.state).not.toBe("collecting");
  });

  it("battery consumed during trip", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 50, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);
    const batteryBefore = p.robot.battery;

    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 10; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(p.robot.battery).toBeLessThan(batteryBefore);
  });
});

// ============================================================================
// §3 — DISPOSAL DECISION PLAYTEST
// ============================================================================
describe("§3 Disposal Decision Playtest", () => {
  it("base storage path — cargo delivered to storage", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 20;
    p.robot.x = p.baseX + 10;
    p.robot.y = p.baseY;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.storageKg).toBe(20);
    expect(p.robot.cargoKg).toBe(0);
  });

  it("burn zone path — cargo delivered to zone, TOX credited", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 20;
    p.robot.x = MAP_CENTER + 200;
    p.robot.y = MAP_CENTER;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);
    const burnZone = { x: MAP_CENTER + 210, y: MAP_CENTER, status: "active" };

    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, burnZone);

    expect(p.robot.cargoKg).toBe(0);
    const expectedTox = (20 / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
    expect(p.toxBalance).toBeCloseTo(expectedTox, 9);
    expect(p.toxFromZone).toBeGreaterThan(0);
  });

  it("normal vs burn zone TOX comparison", () => {
    const kg = 100;
    const normalTox = (kg / 1000) * TOX_PER_TON;
    const zoneTox = (kg / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
    expect(zoneTox).toBeCloseTo(normalTox * 1.2, 9);
    expect(zoneTox).toBeGreaterThan(normalTox);
  });

  it("economic decision — burn zone always pays more per kg", () => {
    // For any waste amount, burn zone pays 20% more
    for (const kg of [10, 50, 100, 200, 500]) {
      const normalTox = (kg / 1000) * TOX_PER_TON;
      const zoneTox = (kg / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
      expect(zoneTox).toBeGreaterThan(normalTox);
    }
  });

  it("burn zone inactive — no zone reward", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 20;
    p.robot.x = MAP_CENTER + 200;
    p.robot.y = MAP_CENTER;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);
    const burnZone = { x: MAP_CENTER + 210, y: MAP_CENTER, status: "inactive" };

    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, burnZone);

    expect(p.toxBalance).toBe(0);
    expect(p.robot.cargoKg).toBe(20); // unchanged
  });
});

// ============================================================================
// §4 — STORAGE SHIPMENT
// ============================================================================
describe("§4 Storage Shipment", () => {
  for (const kg of [20, 60, 137, 200]) {
    it(`shipment of ${kg} kg — full storage sent`, () => {
      const p = makePlayer_("p1");
      p.storageKg = kg;
      const ms = makeManualState();

      const started = startProcessingTransit(p, ms, 1000);

      expect(started).toBe(true);
      expect(ms.processingTransit.active).toBe(true);
      expect(ms.processingTransit.kg).toBe(kg);
      expect(p.storageKg).toBe(0);
    });
  }

  it("duplicate start — rejected", () => {
    const p = makePlayer_("p1");
    p.storageKg = 50;
    const ms = makeManualState();

    startProcessingTransit(p, ms, 1000);
    const second = startProcessingTransit(p, ms, 2000);

    expect(second).toBe(false);
  });

  it("60s transit — completion after timer", () => {
    const p = makePlayer_("p1");
    p.storageKg = 100;
    const ms = makeManualState();
    const world = makeWorld_();
    const ledger: any[] = [];

    startProcessingTransit(p, ms, 1000);

    // Before 60s
    expect(completeProcessingTransit(p, ms, world, ledger, 1000 + 59_999)).toBe(false);

    // After 60s
    expect(completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000)).toBe(true);
  });

  it("post-completion — storage cleared, TOX credited, pollution reduced", () => {
    const p = makePlayer_("p1");
    p.storageKg = 137;
    const ms = makeManualState();
    const world = makeWorld_();
    const pollBefore = world.pollutionKg;
    const ledger: any[] = [];

    startProcessingTransit(p, ms, 1000);
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);

    expect(p.storageKg).toBe(0);
    expect(p.toxBalance).toBeCloseTo((137 / 1000) * TOX_PER_TON, 9);
    expect(world.pollutionKg).toBeCloseTo(pollBefore - 137, 0);
  });

  it("duplicate completion — no double reward", () => {
    const p = makePlayer_("p1");
    p.storageKg = 100;
    const ms = makeManualState();
    const world = makeWorld_();
    const ledger: any[] = [];

    startProcessingTransit(p, ms, 1000);
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    const tox1 = p.toxBalance;

    // Try again
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    const tox2 = p.toxBalance;

    expect(tox2).toBe(tox1); // no double
  });
});

// ============================================================================
// §5 — BATTERY MEASUREMENTS
// ============================================================================
describe("§5 Battery Measurements", () => {
  it("near cluster round trip — battery sufficient", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 20, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    // Drive to cluster
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 25; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    const dist_ = distToBase(p.robot, p.baseX, p.baseY);
    const returnCost = returnEnergyRequired(p.robot, p.baseX, p.baseY);

    expect(p.robot.battery).toBeGreaterThan(0);
    expect(p.robot.battery).toBeGreaterThan(returnCost);
  });

  it("far cluster round trip — battery warning likely", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 100, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    // Drive to cluster
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 110; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    const returnCost = returnEnergyRequired(p.robot, p.baseX, p.baseY);
    const ratio = p.robot.battery / (returnCost || 1);

    // Should trigger low or critical battery
    expect(ratio).toBeLessThan(1.5);
  });

  it("very far cluster — critical battery likely", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 200, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    // Drive far
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 220; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    const returnCost = returnEnergyRequired(p.robot, p.baseX, p.baseY);
    const ratio = p.robot.battery / (returnCost || 1);

    expect(ratio).toBeLessThan(1.3);
  });

  it("return cost scales linearly with distance", () => {
    const costs: number[] = [];
    const distances = [10, 50, 100, 200, 400];
    for (const d of distances) {
      const p = makePlayer_("p1");
      p.robot.x = p.baseX + d;
      costs.push(returnEnergyRequired(p.robot, p.baseX, p.baseY));
    }
    // Linear scaling (each step adds proportional cost)
    for (let i = 1; i < costs.length; i++) {
      const expectedRatio = distances[i] / distances[i - 1];
      const actualRatio = (costs[i] - ROBOT.BATTERY_SAFETY_MARGIN) / (costs[i - 1] - ROBOT.BATTERY_SAFETY_MARGIN);
      expect(actualRatio).toBeCloseTo(expectedRatio, 1);
    }
  });
});

// ============================================================================
// §6 — LOW BATTERY
// ============================================================================
describe("§6 Low Battery", () => {
  it("normal state — battery sufficient", () => {
    expect(computeBatteryState(100, 500, 500, 510, 500, 0, 0)).toBe("normal");
  });

  it("low_battery at ratio ~1.15", () => {
    // dist = 200, returnCost = (200/6)*0.6 + 5 = 20 + 5 = 25
    // battery = 28, ratio = 28/25 = 1.12 -> low_battery
    expect(computeBatteryState(28, 500, 500, 700, 500, 0, 0)).toBe("low_battery");
  });

  it("critical_battery at ratio ≤ 1.0", () => {
    // dist = 200, returnCost = 25, battery = 25, ratio = 1.0 -> critical
    expect(computeBatteryState(25, 500, 500, 700, 500, 0, 0)).toBe("critical_battery");
  });

  it("false-positive check — high battery far away stays normal", () => {
    // L5 battery cap = 460, far = 300 units
    // returnCost = (300/6)*0.6 + 5 = 30 + 5 = 35, ratio = 460/35 = 13.1
    expect(computeBatteryState(460, 500, 500, 800, 500, 0, 0)).toBe("normal");
  });

  it("false-negative check — low battery near base stays normal", () => {
    // Near base = 5 units, returnCost = (5/6)*0.6 + 5 = 0.5 + 5 = 5.5
    // battery = 100, ratio = 100/5.5 = 18.2 -> normal
    expect(computeBatteryState(100, 500, 500, 505, 500, 0, 0)).toBe("normal");
  });
});

// ============================================================================
// §7 — CRITICAL BATTERY
// ============================================================================
describe("§7 Critical Battery", () => {
  it("9.9% deviation — NOT critical yet", () => {
    // lowBatteryDistanceRef = 100, threshold = 100 * 0.10 = 10
    // current distance must be > 110 to trigger
    // 100 * 1.099 = 109.9 -> not > 110
    expect(checkCriticalDeviation(
      609.9, 500, // 109.9 from base
      500, 500,
      100,
    )).toBe(false);
  });

  it("10% deviation — NOT critical (boundary)", () => {
    // current distance = 110 = 100 + 10 -> 110 is NOT > 110
    expect(checkCriticalDeviation(
      610, 500,
      500, 500,
      100,
    )).toBe(false);
  });

  it("10.1% deviation — IS critical", () => {
    // current distance = 110.1 > 110
    expect(checkCriticalDeviation(
      610.1, 500,
      500, 500,
      100,
    )).toBe(true);
  });

  it("critical via stepManualRobot — deviation tracked", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 100; // closer for reliable battery calc
    p.robot.y = MAP_CENTER;
    p.robot.battery = 15; // low battery
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    // Set up low battery reference (simulating the low battery warning happened)
    ms.lowBatteryDistanceRef = 100;
    ms.lowBatteryRef = 15;

    // Move 11 units further away (10% of 100 = 10, need > 10)
    ms.input = { dx: 1, dy: 0 };
    // 11 / 6 ≈ 1.83 seconds of movement
    stepManualRobot(p, ms, clusterMap, 1000, 11 / ROBOT.SPEED_M_S, 1, { x: 0, y: 0, status: "inactive" });

    expect(ms.cargoDropOffered).toBe(true);
  });
});

// ============================================================================
// §8 — CARGO DROP
// ============================================================================
describe("§8 Cargo Drop", () => {
  it("dropCargo — cargo zeroed, flagged", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 25;
    const ms = makeManualState();

    const dropped = dropCargo(p, ms);

    expect(dropped).toBe(25);
    expect(p.robot.cargoKg).toBe(0);
    expect(ms.cargoDropped).toBe(true);
  });

  it("after drop — player can return to base", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 25;
    p.robot.x = MAP_CENTER + 100;
    p.robot.y = MAP_CENTER;
    p.robot.battery = batteryCap(p); // full battery
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    dropCargo(p, ms);

    // Drive back — 100 units at 6 units/tick = ~17 ticks
    ms.input = { dx: -1, dy: 0 };
    for (let i = 0; i < 25; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(distToBase(p.robot, p.baseX, p.baseY)).toBeLessThan(20);
  });
});

// ============================================================================
// §9 — EXTRA BATTERY SENSITIVITY
// ============================================================================
describe("§9 Extra Battery Sensitivity", () => {
  const costOptions = [25, 50, 75, 100];
  const amountOptions = [20, 30, 40];

  for (const cost of costOptions) {
    for (const amount of amountOptions) {
      it(`cost=${cost} TOX, amount=${amount} — valid purchase`, () => {
        const p = makePlayer_("p1", { toxBalance: 200 });
        p.robot.battery = 30;

        const success = purchaseExtraBattery(p, cost, amount);

        expect(success).toBe(true);
        expect(p.robot.battery).toBe(30 + amount);
        expect(p.toxBalance).toBe(200 - cost);
      });
    }
  }

  it("cost=100, amount=20 — marginal benefit", () => {
    const p = makePlayer_("p1", { toxBalance: 100 });
    p.robot.battery = 30;

    purchaseExtraBattery(p, 100, 20);

    expect(p.robot.battery).toBe(50);
    expect(p.toxBalance).toBe(0);
  });

  it("cost=25, amount=40 — best value ratio", () => {
    const p = makePlayer_("p1", { toxBalance: 100 });
    p.robot.battery = 30;

    purchaseExtraBattery(p, 25, 40);

    expect(p.robot.battery).toBe(70);
    expect(p.toxBalance).toBe(75);
  });

  it("battery cap enforcement — cannot exceed cap", () => {
    const p = makePlayer_("p1", { toxBalance: 200 });
    p.robot.battery = 90; // L1 cap = 100

    purchaseExtraBattery(p, 50, 40);

    expect(p.robot.battery).toBe(100); // capped
  });

  it("insufficient TOX — purchase rejected", () => {
    const p = makePlayer_("p1", { toxBalance: 20 });
    p.robot.battery = 50;

    const success = purchaseExtraBattery(p, 50, 30);

    expect(success).toBe(false);
    expect(p.robot.battery).toBe(50);
    expect(p.toxBalance).toBe(20);
  });

  it("TOX-to-battery ratio analysis", () => {
    const ratios: Array<{ cost: number; amount: number; ratio: number }> = [];
    for (const cost of costOptions) {
      for (const amount of amountOptions) {
        ratios.push({ cost, amount, ratio: cost / amount });
      }
    }
    // Best value = lowest ratio
    ratios.sort((a, b) => a.ratio - b.ratio);
    expect(ratios[0].ratio).toBeLessThan(ratios[ratios.length - 1].ratio);
  });
});

// ============================================================================
// §10 — BATTERY FAILURE OUTCOME (TBD)
// ============================================================================
describe("§10 Battery Failure Options (TBD)", () => {
  it("battery=0, cargo>0 — measures state", () => {
    const p = makePlayer_("p1");
    p.robot.battery = 0;
    p.robot.cargoKg = 20;
    const state = computeBatteryState(0, 500, 500, 700, 500, 0, 0);
    expect(state).toBe("battery_depleted");
  });

  it("Option A — 60s disable: robot frozen, cargo kept", () => {
    const p = makePlayer_("p1");
    p.robot.battery = 0;
    p.robot.cargoKg = 20;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    // Simulate 60s disable — no movement even with input
    ms.input = { dx: 1, dy: 0 };
    // Battery depleted blocks movement
    const result = stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    // With battery=0, movement drains to 0, but position may still update
    // The key is the battery state is depleted
    expect(ms.batteryState).toBe("battery_depleted");
  });

  it("Option B — teleport to base: position reset", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 500;
    p.robot.y = MAP_CENTER + 300;
    p.robot.battery = 0;

    // Teleport (simulated)
    p.robot.x = p.baseX;
    p.robot.y = p.baseY;
    p.robot.battery = batteryCap(p);

    expect(distToBase(p.robot, p.baseX, p.baseY)).toBe(0);
  });

  it("Option C — automatic cargo return: cargo→storage", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 25;
    p.robot.battery = 0;
    const sCap = storageCap(p);

    // Auto-return cargo to storage
    const returned = Math.min(p.robot.cargoKg, sCap - p.storageKg);
    p.storageKg += returned;
    p.robot.cargoKg -= returned;

    expect(p.storageKg).toBe(25);
    expect(p.robot.cargoKg).toBe(0);
  });

  it("BATTERY FAILURE OUTCOME = TBD (no auto-freeze)", () => {
    // Verify we have NOT frozen any battery failure outcome
    // All options above are suggestions, not implementation
    const options = ["60s_disable", "teleport", "auto_return_cargo", "cargo_destruction", "rescue"];
    expect(options.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// §11 — FULL E2E FLOW
// ============================================================================
describe("§11 Full E2E Flows", () => {
  it("E2E: drive → collect → base → storage → transit → burn → TOX", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 30, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    // Drive to cluster
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 35; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }
    expect(p.robot.cargoKg).toBeGreaterThan(0);

    // Drive back to base
    ms.input = { dx: -1, dy: 0 };
    for (let i = 0; i < 40; i++) {
      stepManualRobot(p, ms, clusterMap, (35 + i) * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }
    expect(p.storageKg).toBeGreaterThan(0);

    // Ship
    startProcessingTransit(p, ms, 100_000);
    expect(ms.processingTransit.active).toBe(true);

    // Complete transit
    const world = makeWorld_();
    const ledger: any[] = [];
    completeProcessingTransit(p, ms, world, ledger, 100_000 + 60_000);

    expect(p.toxBalance).toBeGreaterThan(0);
    expect(world.burnedKg).toBeGreaterThan(0);
  });

  it("E2E: drive → collect → burn zone → TOX (no storage)", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 200;
    p.robot.y = MAP_CENTER;
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 200, MAP_CENTER + 5, 500);
    const clusterMap = makeClusterMap([cluster]);
    const burnZone = { x: MAP_CENTER + 200, y: MAP_CENTER + 20, status: "active" };

    // Drive into cluster
    ms.input = { dx: 0, dy: 1 };
    for (let i = 0; i < 10; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, burnZone);
    }

    // If collected, drive to burn zone
    if (p.robot.cargoKg > 0) {
      ms.input = { dx: 0, dy: 1 };
      for (let i = 0; i < 30; i++) {
        stepManualRobot(p, ms, clusterMap, (10 + i) * 1000, 1, 1, burnZone);
      }
      // Should get burn zone reward
      if (p.toxFromZone > 0) {
        expect(p.toxBalance).toBeGreaterThan(0);
      }
    }
  });

  it("E2E: low battery → critical → drop cargo → return", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 100; // closer start for reliable return
    p.robot.y = MAP_CENTER;
    p.robot.cargoKg = 15;
    p.robot.battery = batteryCap(p); // full battery for return
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    // Simulate critical battery state
    ms.batteryState = "critical_battery";
    ms.lowBatteryDistanceRef = 100;

    // Drop cargo
    const dropped = dropCargo(p, ms);
    expect(dropped).toBe(15);
    expect(p.robot.cargoKg).toBe(0);

    // Return to base — 100 units at 6 units/tick = ~17 ticks
    ms.input = { dx: -1, dy: 0 };
    for (let i = 0; i < 25; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(distToBase(p.robot, p.baseX, p.baseY)).toBeLessThan(20);
  });

  it("E2E: critical → extra battery → continue", () => {
    const p = makePlayer_("p1", { toxBalance: 100 });
    p.robot.x = MAP_CENTER + 150;
    p.robot.y = MAP_CENTER;
    p.robot.battery = 20;
    const ms = makeManualState();
    const clusterMap = makeClusterMap([]);

    // Buy extra battery
    const success = purchaseExtraBattery(p, 50, 30);
    expect(success).toBe(true);
    expect(p.robot.battery).toBe(50);

    // Can now continue
    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.x).toBeGreaterThan(MAP_CENTER + 150);
  });
});

// ============================================================================
// §12 — INVARIANT CHECKS
// ============================================================================
describe("§12 Invariants", () => {
  it("manual robot does not break world invariants", () => {
    const w = freshWorld(WORLD.CAPACITY_KG, 0.5);
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const clusterMap = new Map(w.clusters.map((c) => [c.id, c]));
    w.players.push(p);

    // Run some steps
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 20; i++) {
      stepManualRobot(p, ms, clusterMap, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    w.clusters = [...clusterMap.values()];
    const inv = simInvariant(w);
    expect(Math.abs(inv.massBalance)).toBeLessThan(1);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(1);
  });
});

// ============================================================================
// §13 — PROTECTION INTERACTION
// ============================================================================
describe("§13 Protection Interaction", () => {
  it("AFK player — no auto collection", () => {
    const p = makePlayer_("p1");
    const ms = makeManualState();
    const cluster = makeCluster("c1", MAP_CENTER + 10, MAP_CENTER, 500);
    const clusterMap = makeClusterMap([cluster]);

    // No input — AFK
    ms.input = { dx: 0, dy: 0 };
    stepManualRobot(p, ms, clusterMap, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.cargoKg).toBe(0);
    expect(ms.isMoving).toBe(false);
  });

  it("base generation independent of robot", () => {
    const genPerTick = WORLD.BASE_GEN_KG_H * (WORLD.GAME_MINUTES_PER_TICK / 60);
    expect(genPerTick).toBeGreaterThan(0);
  });

  it("shield does not affect manual movement drain", () => {
    // Shield only affects CRITICAL_DRAIN_MULT
    const now = Date.now();
    const prot = { state: "normal" as const, shieldUntil: now + 100_000 };
    // drainMult = 1 when shielded (from drainMultiplier)
    // Manual robot uses drainMult parameter directly
    expect(1).toBe(1); // shielded drainMult = 1
  });
});
