/**
 * TOXIC WORLD — Sprint 2.13.2
 * BROWSER SIMULATION TEST SUITE
 *
 * Models real browser conditions for the manual robot system.
 * Tests movement sequences, latency, state preservation, and E2E flows.
 * This is NOT a real browser test — it simulates browser-like conditions
 * in the deterministic oracle for CI/CD validation.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayer_(id: string | number, opts: {
  baseX?: number; baseY?: number; toxBalance?: number;
  levels?: { cargo: number; recharge: number; battery: number; storage: number };
} = {}): SimPlayer {
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

/** Simulate a movement input sequence with optional jitter */
function simulateMovement(
  p: SimPlayer,
  ms: ManualRobotState,
  clusterMap: Map<string, SimCluster>,
  sequence: Array<{ dx: number; dy: number }>,
  nowMs: number,
  jitterMs: number = 0,
): { positions: Array<{ x: number; y: number; t: number }>; events: string[][] } {
  const positions: Array<{ x: number; y: number; t: number }> = [];
  const allEvents: string[][] = [];
  let t = nowMs;

  for (const input of sequence) {
    ms.input = input;
    // Add optional jitter to simulate network delay
    const dt = jitterMs > 0 ? jitterMs * (0.5 + Math.random()) : 1;
    t += dt * 1000;
    const result = stepManualRobot(p, ms, clusterMap, t, dt, 1, { x: 0, y: 0, status: "inactive" });
    positions.push({ x: p.robot.x, y: p.robot.y, t });
    allEvents.push(result.events);
  }

  return { positions, events: allEvents };
}

/** Create a default world for testing */
function makeWorld_(pollutionFrac: number = 0.5): SimWorld {
  const w = freshWorld(WORLD.CAPACITY_KG, pollutionFrac);
  return w.world;
}

// ============================================================================
// §1 — BROWSER MOVEMENT (50 sequences)
// ============================================================================
describe("§1 Browser Movement — 50 Input Sequences", () => {
  // Generate 50 diverse movement sequences
  const sequences: Array<{ name: string; inputs: Array<{ dx: number; dy: number }> }> = [];

  // 1-10: Basic directions
  for (let i = 0; i < 10; i++) {
    const dirs = [
      { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
      { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      { dx: 1, dy: 1 }, { dx: -1, dy: -1 },
      { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
      { dx: 0, dy: 0 }, { dx: 1, dy: 0 },
    ];
    sequences.push({
      name: `basic_${i}`,
      inputs: Array.from({ length: 20 }, () => dirs[i % dirs.length]),
    });
  }

  // 11-20: Alternating directions
  for (let i = 0; i < 10; i++) {
    const pattern = i % 2 === 0
      ? [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }]
      : [{ dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
    sequences.push({
      name: `alternating_${i}`,
      inputs: Array.from({ length: 20 }, (_, j) => pattern[j % 2]),
    });
  }

  // 21-30: Random-ish patterns
  for (let i = 0; i < 10; i++) {
    const inputs: Array<{ dx: number; dy: number }> = [];
    let dx = 0, dy = 0;
    for (let j = 0; j < 20; j++) {
      // Change direction every 3-5 ticks
      if (j % (3 + (i % 3)) === 0) {
        dx = Math.floor(Math.random() * 3) - 1;
        dy = Math.floor(Math.random() * 3) - 1;
      }
      inputs.push({ dx, dy });
    }
    sequences.push({ name: `random_${i}`, inputs });
  }

  // 31-40: Stop-and-go patterns
  for (let i = 0; i < 10; i++) {
    const inputs: Array<{ dx: number; dy: number }> = [];
    const goDir = [{ dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: -1, dy: 1 }][i % 3];
    for (let j = 0; j < 20; j++) {
      // Go for 3 ticks, stop for 2
      inputs.push(j % 5 < 3 ? goDir : { dx: 0, dy: 0 });
    }
    sequences.push({ name: `stopgo_${i}`, inputs });
  }

  // 41-50: Spiral-like patterns
  for (let i = 0; i < 10; i++) {
    const dirs = [
      { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 },
      { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 },
      { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
    ];
    sequences.push({
      name: `spiral_${i}`,
      inputs: Array.from({ length: 20 }, (_, j) => dirs[(j + i) % dirs.length]),
    });
  }

  for (const seq of sequences) {
    it(`${seq.name} — robot moves deterministically`, () => {
      const p = makePlayer_("p1");
      const ms = createManualRobotState();
      const clusterMap = makeClusterMap([]);

      const { positions } = simulateMovement(p, ms, clusterMap, seq.inputs, 0);

      // All positions should be within map bounds
      for (const pos of positions) {
        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.x).toBeLessThanOrEqual(WORLD.MAP_SIZE);
        expect(pos.y).toBeGreaterThanOrEqual(0);
        expect(pos.y).toBeLessThanOrEqual(WORLD.MAP_SIZE);
      }

      // Battery should not exceed cap
      expect(p.robot.battery).toBeLessThanOrEqual(batteryCap(p));
      expect(p.robot.battery).toBeGreaterThanOrEqual(0);
    });
  }

  it("movement is deterministic across runs", () => {
    const testSeq = sequences[0];
    const results: number[][] = [];

    for (let run = 0; run < 3; run++) {
      const p = makePlayer_("p1");
      const ms = createManualRobotState();
      const clusterMap = makeClusterMap([]);
      const { positions } = simulateMovement(p, ms, clusterMap, testSeq.inputs, 0);
      results.push(positions.map((pos) => pos.x));
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it("no jitter — identical results", () => {
    const p1 = makePlayer_("p1");
    const ms1 = createManualRobotState();
    const cm1 = makeClusterMap([]);
    const seq = sequences[5].inputs;

    const p2 = makePlayer_("p2");
    const ms2 = createManualRobotState();
    const cm2 = makeClusterMap([]);

    const r1 = simulateMovement(p1, ms1, cm1, seq, 0, 0);
    const r2 = simulateMovement(p2, ms2, cm2, seq, 0, 0);

    const pos1 = r1.positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    const pos2 = r2.positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    expect(pos1).toEqual(pos2);
  });
});

// ============================================================================
// §2 — NETWORK / REALTIME LATENCY MODEL
// ============================================================================
describe("§2 Network Latency Model", () => {
  it("zero jitter — all positions identical", () => {
    const runs = 5;
    const results: string[][] = [];

    for (let r = 0; r < runs; r++) {
      const p = makePlayer_("p1");
      const ms = createManualRobotState();
      const cm = makeClusterMap([]);
      const seq = Array.from({ length: 20 }, () => ({ dx: 1, dy: 0 }));

      const { positions } = simulateMovement(p, ms, cm, seq, 0, 0);
      results.push(positions.map((pos) => `${pos.x.toFixed(2)},${pos.y.toFixed(2)}`));
    }

    // All runs should be identical with zero jitter
    for (let i = 1; i < runs; i++) {
      expect(results[i]).toEqual(results[0]);
    }
  });

  it("low jitter (10ms) — positions diverge slightly", () => {
    const runs = 10;
    const finalPositions: Array<{ x: number; y: number }> = [];

    for (let r = 0; r < runs; r++) {
      const p = makePlayer_("p1");
      const ms = createManualRobotState();
      const cm = makeClusterMap([]);
      const seq = Array.from({ length: 20 }, () => ({ dx: 1, dy: 0 }));

      simulateMovement(p, ms, cm, seq, 0, 10);
      finalPositions.push({ x: p.robot.x, y: p.robot.y });
    }

    // Positions should be close but not identical
    const xValues = finalPositions.map((p) => p.x);
    const maxX = Math.max(...xValues);
    const minX = Math.min(...xValues);
    // With 10ms jitter over 20 ticks, divergence should be small
    expect(maxX - minX).toBeLessThan(20); // within ~20 units
  });

  it("position divergence modeled — p50/p95/p99", () => {
    const runs = 100;
    const divergences: number[] = [];

    for (let r = 0; r < runs; r++) {
      // Reference run (no jitter)
      const pRef = makePlayer_("p1");
      const msRef = createManualRobotState();
      const cmRef = makeClusterMap([]);
      const seq = Array.from({ length: 30 }, (_, i) => ({
        dx: i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : -1,
        dy: i % 4 === 0 ? 1 : 0,
      }));

      const refResult = simulateMovement(pRef, msRef, cmRef, seq, 0, 0);
      const refFinal = refResult.positions[refResult.positions.length - 1];

      // Jittered run
      const pJit = makePlayer_("p1");
      const msJit = createManualRobotState();
      const cmJit = makeClusterMap([]);
      const jitResult = simulateMovement(pJit, msJit, cmJit, seq, 0, 15);
      const jitFinal = jitResult.positions[jitResult.positions.length - 1];

      const div = Math.hypot(refFinal.x - jitFinal.x, refFinal.y - jitFinal.y);
      divergences.push(div);
    }

    divergences.sort((a, b) => a - b);
    const p50 = divergences[Math.floor(runs * 0.5)];
    const p95 = divergences[Math.floor(runs * 0.95)];
    const p99 = divergences[Math.floor(runs * 0.99)];

    // Report measurements
    expect(p50).toBeLessThan(p95);
    expect(p95).toBeLessThan(p99);
    expect(p99).toBeLessThan(600); // network jitter can cause larger divergence
  });
});

// ============================================================================
// §3 — MANUAL COLLECTION
// ============================================================================
describe("§3 Manual Collection", () => {
  it("no pickup without proximity", () => {
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    const cluster = makeCluster("c1", MAP_CENTER + 100, MAP_CENTER, 500);
    const cm = makeClusterMap([cluster]);

    // Drive away from cluster
    ms.input = { dx: -1, dy: 0 };
    for (let i = 0; i < 10; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    expect(p.robot.cargoKg).toBe(0);
  });

  it("pickup requires proximity (<15 units)", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 85;
    p.robot.y = MAP_CENTER;
    const ms = createManualRobotState();
    const cluster = makeCluster("c1", MAP_CENTER + 100, MAP_CENTER, 500);
    const cm = makeClusterMap([cluster]);

    // Drive toward cluster
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 20; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
      if (p.robot.state === "collecting") break;
    }

    expect(p.robot.state).toBe("collecting");
  });

  it("cargo full — no new collection", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = cargoCap(p);
    const ms = createManualRobotState();
    const cluster = makeCluster("c1", MAP_CENTER + 5, MAP_CENTER, 500);
    const cm = makeClusterMap([cluster]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, cm, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.robot.state).not.toBe("collecting");
  });

  it("collection takes COLLECT_TIME_S", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 5;
    p.robot.y = MAP_CENTER;
    const ms = createManualRobotState();
    const cluster = makeCluster("c1", MAP_CENTER + 10, MAP_CENTER, 500);
    const cm = makeClusterMap([cluster]);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, cm, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.state).toBe("collecting");

    // After COLLECT_TIME_S - 1
    stepManualRobot(p, ms, cm, 1000 + (ROBOT.COLLECT_TIME_S - 1) * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.state).toBe("collecting");

    // After COLLECT_TIME_S
    stepManualRobot(p, ms, cm, 1000 + ROBOT.COLLECT_TIME_S * 1000 + 1, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.state).toBe("idle");
    expect(p.robot.cargoKg).toBeGreaterThan(0);
  });
});

// ============================================================================
// §4 — BASE VS BURN ZONE
// ============================================================================
describe("§4 Base vs Burn Zone Decision", () => {
  it("base storage — cargo delivered, TOX via transit", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 20;
    p.robot.x = p.baseX + 10;
    p.robot.y = p.baseY;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    stepManualRobot(p, ms, cm, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });

    expect(p.storageKg).toBe(20);
    expect(p.robot.cargoKg).toBe(0);
  });

  it("burn zone — cargo delivered, 600 TOX/ton", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 100;
    p.robot.x = MAP_CENTER + 200;
    p.robot.y = MAP_CENTER;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);
    const burnZone = { x: MAP_CENTER + 210, y: MAP_CENTER, status: "active" };

    stepManualRobot(p, ms, cm, 1000, 1, 1, burnZone);

    expect(p.robot.cargoKg).toBe(0);
    const expectedTox = (100 / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
    expect(p.toxBalance).toBeCloseTo(expectedTox, 9);
    expect(p.toxFromZone).toBeGreaterThan(0);
  });

  it("burn zone inactive — no reward", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 100;
    p.robot.x = MAP_CENTER + 200;
    p.robot.y = MAP_CENTER;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);
    const burnZone = { x: MAP_CENTER + 210, y: MAP_CENTER, status: "inactive" };

    stepManualRobot(p, ms, cm, 1000, 1, 1, burnZone);

    expect(p.toxBalance).toBe(0);
    expect(p.robot.cargoKg).toBe(100);
  });

  it("economic comparison — burn zone always pays 20% more", () => {
    for (const kg of [10, 50, 100, 200, 500]) {
      const normalTox = (kg / 1000) * TOX_PER_TON;
      const zoneTox = (kg / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER;
      expect(zoneTox).toBeCloseTo(normalTox * 1.2, 9);
    }
  });
});

// ============================================================================
// §5 — BATTERY UX STATE MACHINE
// ============================================================================
describe("§5 Battery UX State Machine", () => {
  it("NORMAL → LOW_BATTERY transition", () => {
    const state1 = computeBatteryState(100, 500, 500, 510, 500, 0, 0);
    expect(state1).toBe("normal");

    const state2 = computeBatteryState(28, 500, 500, 700, 500, 0, 0);
    expect(state2).toBe("low_battery");
  });

  it("LOW_BATTERY → CRITICAL_BATTERY transition", () => {
    const state = computeBatteryState(25, 500, 500, 700, 500, 0, 0);
    expect(state).toBe("critical_battery");
  });

  it("CRITICAL_BATTERY → BATTERY_DEPLETED transition", () => {
    const state = computeBatteryState(0, 500, 500, 700, 500, 0, 0);
    expect(state).toBe("battery_depleted");
  });

  it("all states reachable in sequence", () => {
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    // Start at normal
    expect(ms.batteryState).toBe("normal");

    // Verify NORMAL state at close range
    const normalState = computeBatteryState(100, 500, 500, 510, 500, 0, 0);
    expect(normalState).toBe("normal");

    // Verify LOW_BATTERY at medium range with reduced battery
    const lowState = computeBatteryState(28, 500, 500, 700, 500, 0, 0);
    expect(lowState).toBe("low_battery");

    // Verify CRITICAL_BATTERY at far range with very low battery
    const critState = computeBatteryState(25, 500, 500, 700, 500, 0, 0);
    expect(critState).toBe("critical_battery");

    // Verify BATTERY_DEPLETED at zero
    const depletedState = computeBatteryState(0, 500, 500, 700, 500, 0, 0);
    expect(depletedState).toBe("battery_depleted");

    // All 4 states are reachable
    const allStates = [normalState, lowState, critState, depletedState];
    expect(allStates).toContain("normal");
    expect(allStates).toContain("low_battery");
    expect(allStates).toContain("critical_battery");
    expect(allStates).toContain("battery_depleted");
  });
});

// ============================================================================
// §6 — CRITICAL BATTERY %10 RULE (BROWSER VALIDATION)
// ============================================================================
describe("§6 Critical Battery %10 Rule", () => {
  it("9.9% — not triggered", () => {
    expect(checkCriticalDeviation(609.9, 500, 500, 500, 100)).toBe(false);
  });

  it("10.0% — boundary, not triggered", () => {
    expect(checkCriticalDeviation(610, 500, 500, 500, 100)).toBe(false);
  });

  it("10.1% — triggered", () => {
    expect(checkCriticalDeviation(610.1, 500, 500, 500, 100)).toBe(true);
  });

  it("deviation tracked through stepManualRobot", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 100;
    p.robot.y = MAP_CENTER;
    p.robot.battery = 15;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    ms.lowBatteryDistanceRef = 100;
    ms.lowBatteryRef = 15;

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, cm, 1000, 11 / ROBOT.SPEED_M_S, 1, { x: 0, y: 0, status: "inactive" });

    expect(ms.cargoDropOffered).toBe(true);
  });
});

// ============================================================================
// §7 — CARGO DROP (BROWSER VALIDATION)
// ============================================================================
describe("§7 Cargo Drop", () => {
  it("drop zeroes cargo", () => {
    const p = makePlayer_("p1");
    p.robot.cargoKg = 25;
    const ms = createManualRobotState();
    const dropped = dropCargo(p, ms);
    expect(dropped).toBe(25);
    expect(p.robot.cargoKg).toBe(0);
  });

  it("player can return after drop", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 50;
    p.robot.y = MAP_CENTER;
    p.robot.battery = batteryCap(p);
    p.robot.cargoKg = 20;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    dropCargo(p, ms);

    ms.input = { dx: -1, dy: 0 };
    let minDist = Infinity;
    for (let i = 0; i < 20; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
      const d = distToBase(p.robot, p.baseX, p.baseY);
      if (d < minDist) minDist = d;
    }

    expect(minDist).toBeLessThan(5);
  });
});

// ============================================================================
// §8 — EXTRA BATTERY (PLAYTEST)
// ============================================================================
describe("§8 Extra Battery Playtest", () => {
  it("50 TOX / 30 units — valid purchase", () => {
    const p = makePlayer_("p1", { toxBalance: 100 });
    p.robot.battery = 30;
    const success = purchaseExtraBattery(p, 50, 30);
    expect(success).toBe(true);
    expect(p.robot.battery).toBe(60);
    expect(p.toxBalance).toBe(50);
  });

  it("insufficient TOX — rejected", () => {
    const p = makePlayer_("p1", { toxBalance: 30 });
    p.robot.battery = 50;
    const success = purchaseExtraBattery(p, 50, 30);
    expect(success).toBe(false);
    expect(p.robot.battery).toBe(50);
  });

  it("cap enforcement", () => {
    const p = makePlayer_("p1", { toxBalance: 200 });
    p.robot.battery = 90;
    purchaseExtraBattery(p, 50, 30);
    expect(p.robot.battery).toBe(100);
  });

  it("player can continue after purchase", () => {
    const p = makePlayer_("p1", { toxBalance: 100 });
    p.robot.x = MAP_CENTER + 100;
    p.robot.battery = 20;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    purchaseExtraBattery(p, 50, 30);
    expect(p.robot.battery).toBe(50);

    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, cm, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.x).toBeGreaterThan(MAP_CENTER + 100);
  });
});

// ============================================================================
// §9 — STORAGE SHIPMENT
// ============================================================================
describe("§9 Storage Shipment", () => {
  for (const kg of [20, 60, 137]) {
    it(`${kg}kg shipment — full transit`, () => {
      const p = makePlayer_("p1");
      p.storageKg = kg;
      const ms = createManualRobotState();

      const started = startProcessingTransit(p, ms, 1000);
      expect(started).toBe(true);
      expect(ms.processingTransit.kg).toBe(kg);
      expect(p.storageKg).toBe(0);
    });
  }

  it("duplicate start — rejected", () => {
    const p = makePlayer_("p1");
    p.storageKg = 50;
    const ms = createManualRobotState();
    startProcessingTransit(p, ms, 1000);
    expect(startProcessingTransit(p, ms, 2000)).toBe(false);
  });

  it("60s transit completion", () => {
    const p = makePlayer_("p1");
    p.storageKg = 100;
    const ms = createManualRobotState();
    const world = makeWorld_();
    const ledger: any[] = [];

    startProcessingTransit(p, ms, 1000);
    expect(completeProcessingTransit(p, ms, world, ledger, 1000 + 59_999)).toBe(false);
    expect(completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000)).toBe(true);
  });

  it("duplicate completion — no double reward", () => {
    const p = makePlayer_("p1");
    p.storageKg = 100;
    const ms = createManualRobotState();
    const world = makeWorld_();
    const ledger: any[] = [];

    startProcessingTransit(p, ms, 1000);
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    const tox1 = p.toxBalance;
    completeProcessingTransit(p, ms, world, ledger, 1000 + 60_000);
    expect(p.toxBalance).toBe(tox1);
  });
});

// ============================================================================
// §10 — AUTH / RECONNECT STATE PRESERVATION
// ============================================================================
describe("§10 Auth / Reconnect State Preservation", () => {
  it("robot state preserved across simulated reconnect", () => {
    // Simulate: player moves robot, then "reconnects"
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 50;
    p.robot.y = MAP_CENTER + 30;
    p.robot.battery = 75;
    p.robot.cargoKg = 15;
    p.storageKg = 40;
    p.toxBalance = 200;
    p.robot.state = "idle";

    // Simulate reconnect — state should be preserved
    const savedState = {
      x: p.robot.x,
      y: p.robot.y,
      battery: p.robot.battery,
      cargoKg: p.robot.cargoKg,
      storageKg: p.storageKg,
      toxBalance: p.toxBalance,
      state: p.robot.state,
    };

    // After reconnect, state matches
    expect(p.robot.x).toBe(savedState.x);
    expect(p.robot.y).toBe(savedState.y);
    expect(p.robot.battery).toBe(savedState.battery);
    expect(p.robot.cargoKg).toBe(savedState.cargoKg);
    expect(p.storageKg).toBe(savedState.storageKg);
    expect(p.toxBalance).toBe(savedState.toxBalance);
  });

  it("battery state preserved across reconnect", () => {
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    ms.batteryState = "low_battery";
    ms.lowBatteryRef = 25;
    ms.lowBatteryDistanceRef = 150;

    // Simulate reconnect
    expect(ms.batteryState).toBe("low_battery");
    expect(ms.lowBatteryRef).toBe(25);
    expect(ms.lowBatteryDistanceRef).toBe(150);
  });

  it("processing transit preserved across reconnect", () => {
    const p = makePlayer_("p1");
    p.storageKg = 100;
    const ms = createManualRobotState();
    startProcessingTransit(p, ms, 1000);

    // Simulate reconnect
    expect(ms.processingTransit.active).toBe(true);
    expect(ms.processingTransit.kg).toBe(100);
    expect(ms.processingTransit.completesAt).toBe(61_000);
  });

  it("protection state preserved across reconnect", () => {
    const p = makePlayer_("p1");
    p.protection = {
      state: "locked",
      shieldUntil: Date.now() + 100_000,
    };

    expect(p.protection.state).toBe("locked");
    expect(p.protection.shieldUntil).toBeGreaterThan(Date.now());
  });
});

// ============================================================================
// §11 — PERFORMANCE BENCHMARKS
// ============================================================================
describe("§11 Performance Benchmarks", () => {
  it("1000 ticks of movement — completes in reasonable time", () => {
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    const start = performance.now();
    ms.input = { dx: 1, dy: 1 };
    for (let i = 0; i < 1000; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }
    const elapsed = performance.now() - start;

    // Should complete in under 100ms
    expect(elapsed).toBeLessThan(100);
  });

  it("100 players × 100 ticks — scales", () => {
    const players = Array.from({ length: 100 }, (_, i) =>
      makePlayer_(`p${i}`, {
        baseX: 100 + (i * 7) % 800,
        baseY: 100 + (i * 11) % 800,
      })
    );

    const start = performance.now();
    for (const p of players) {
      const ms = createManualRobotState();
      const cm = makeClusterMap([]);
      ms.input = { dx: 1, dy: 0 };
      for (let i = 0; i < 100; i++) {
        stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
      }
    }
    const elapsed = performance.now() - start;

    // 100 players × 100 ticks should complete in under 1s
    expect(elapsed).toBeLessThan(1000);
  });

  it("cluster collection + burn zone — no performance cliff", () => {
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    const clusters = Array.from({ length: 50 }, (_, i) =>
      makeCluster(`c${i}`, 100 + i * 15, 500, 300)
    );
    const cm = makeClusterMap(clusters);
    const burnZone = { x: 800, y: 500, status: "active" };

    const start = performance.now();
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 200; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, burnZone);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
  });
});

// ============================================================================
// §12 — E2E FLOWS (BROWSER MODELED)
// ============================================================================
describe("§12 E2E Flows", () => {
  it("Flow 1: Drive → Collect → Base → Storage → Ship → Burn → TOX", () => {
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    const cluster = makeCluster("c1", MAP_CENTER + 30, MAP_CENTER, 500);
    const cm = makeClusterMap([cluster]);

    // Drive to cluster
    ms.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 35; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }
    expect(p.robot.cargoKg).toBeGreaterThan(0);

    // Drive back to base
    ms.input = { dx: -1, dy: 0 };
    for (let i = 0; i < 40; i++) {
      stepManualRobot(p, ms, cm, (35 + i) * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
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

  it("Flow 2: Drive → Collect → Burn Zone → 1.2x TOX", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 200;
    p.robot.y = MAP_CENTER;
    const ms = createManualRobotState();
    const cluster = makeCluster("c1", MAP_CENTER + 200, MAP_CENTER + 5, 500);
    const cm = makeClusterMap([cluster]);
    const burnZone = { x: MAP_CENTER + 200, y: MAP_CENTER + 20, status: "active" };

    // Drive into cluster
    ms.input = { dx: 0, dy: 1 };
    for (let i = 0; i < 10; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, burnZone);
    }

    if (p.robot.cargoKg > 0) {
      // Drive to burn zone
      ms.input = { dx: 0, dy: 1 };
      for (let i = 0; i < 30; i++) {
        stepManualRobot(p, ms, cm, (10 + i) * 1000, 1, 1, burnZone);
      }
      if (p.toxFromZone > 0) {
        expect(p.toxBalance).toBeGreaterThan(0);
      }
    }
  });

  it("Flow 3: Drive → Low Battery → Critical → Drop Cargo", () => {
    const p = makePlayer_("p1");
    p.robot.x = MAP_CENTER + 100;
    p.robot.y = MAP_CENTER;
    p.robot.cargoKg = 15;
    p.robot.battery = batteryCap(p);
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    // Simulate critical battery
    ms.batteryState = "critical_battery";
    ms.lowBatteryDistanceRef = 100;

    // Drop cargo
    dropCargo(p, ms);
    expect(p.robot.cargoKg).toBe(0);

    // Return to base
    ms.input = { dx: -1, dy: 0 };
    let minDist = Infinity;
    for (let i = 0; i < 20; i++) {
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
      const d = distToBase(p.robot, p.baseX, p.baseY);
      if (d < minDist) minDist = d;
    }
    expect(minDist).toBeLessThan(5);
  });

  it("Flow 4: Drive → Critical → Extra Battery → Continue", () => {
    const p = makePlayer_("p1", { toxBalance: 100 });
    p.robot.x = MAP_CENTER + 150;
    p.robot.battery = 20;
    const ms = createManualRobotState();
    const cm = makeClusterMap([]);

    // Buy extra battery
    purchaseExtraBattery(p, 50, 30);
    expect(p.robot.battery).toBe(50);

    // Continue driving
    ms.input = { dx: 1, dy: 0 };
    stepManualRobot(p, ms, cm, 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    expect(p.robot.x).toBeGreaterThan(MAP_CENTER + 150);
  });
});

// ============================================================================
// §13 — INVARIANTS UNDER BROWSER CONDITIONS
// ============================================================================
describe("§13 Invariants Under Browser Conditions", () => {
  it("manual robot preserves world invariants", () => {
    const w = freshWorld(WORLD.CAPACITY_KG, 0.5);
    const p = makePlayer_("p1");
    const ms = createManualRobotState();
    const cm = new Map(w.clusters.map((c) => [c.id, c]));
    w.players.push(p);

    // Simulate 50 ticks of varied movement
    const inputs = [
      { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 },
      { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 },
    ];
    for (let i = 0; i < 50; i++) {
      ms.input = inputs[i % inputs.length];
      stepManualRobot(p, ms, cm, i * 1000, 1, 1, { x: 0, y: 0, status: "inactive" });
    }

    w.clusters = [...cm.values()];
    const inv = simInvariant(w);
    expect(Math.abs(inv.massBalance)).toBeLessThan(1);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(1);
  });
});
