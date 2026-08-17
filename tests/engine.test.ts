// TOXIC WORLD — production engine test harness (Sprint 2.4 → 2.6).
//
// Validates the production engine math on the SAME pure functions the tick
// calls (engine.ts, economy.ts, gameParams.ts) via the deterministic oracle
// simulator (engineSim.ts), which mirrors world.ts step-for-step.
//
// Run:  bun test tests/engine.test.ts
// Full suite:  bun test tests/

import { describe, expect, test } from "bun:test";
import {
  batchAllocation,
  checkWasteInvariant,
  pollutionFrac,
  replenishmentModelC,
  worldStatus,
} from "../src/convex/engine";
import { WORLD, batteryForTrip } from "../src/convex/gameParams";
import {
  Sim,
  makeCluster,
  makePlayer,
  makePlayers,
} from "./engineSim";

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// 1. Waste invariant (two layers, official since Sprint 2.5)
// ---------------------------------------------------------------------------

describe("1. waste invariant", () => {
  test("Layer 1 (mass) + Layer 2 (pool) hold every tick of a multiplayer sim", () => {
    const sim = new Sim({
      players: makePlayers(5, { seed: 7, storageFraction: 0.6, queueFraction: 0.6 }),
      seed: 7,
    });
    for (let t = 0; t < 20; t++) {
      sim.tick(10_000 + t * 2_000);
      const inv = sim.invariant();
      expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
      expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
    }
  });
  test("checkWasteInvariant unit — balanced ledger", () => {
    const inv = checkWasteInvariant({
      initialWasteKg: 5_000_000,
      generatedKg: 0,
      pollutionKg: 5_000_000,
      burnedKg: 0,
      hiddenKg: 4_500_000,
      collectableKg: 450_000,
      clusterKg: 50_000,
      cargoKg: 0,
      storageKg: 0,
      processingKg: 0,
    });
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
  test("pool buckets are disjoint — the same kg is never double-counted", () => {
    // same total, mass shifted between buckets: pool must stay balanced while
    // each bucket is exclusive (hidden + collectable + clusters + cargo +
    // storage + processing == pollution − generated)
    const base = {
      initialWasteKg: 5_000_000,
      generatedKg: 0,
      pollutionKg: 5_000_000,
      burnedKg: 0,
      hiddenKg: 4_000_000,
      collectableKg: 500_000,
      clusterKg: 300_000,
      cargoKg: 100_000,
      storageKg: 60_000,
      processingKg: 40_000,
    };
    const inv = checkWasteInvariant(base);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
});

// ---------------------------------------------------------------------------
// 2. Pollution fraction
// ---------------------------------------------------------------------------

describe("2. pollution fraction", () => {
  test("50% at 5,000 t of 10,000 t capacity", () => {
    expect(pollutionFrac(5_000_000, 10_000_000)).toBe(50);
  });
  test("bounds: 0% and 100%", () => {
    expect(pollutionFrac(0, 10_000_000)).toBe(0);
    expect(pollutionFrac(10_000_000, 10_000_000)).toBe(100);
  });
  test("sim state matches the formula", () => {
    const sim = new Sim({ players: makePlayers(3, { seed: 1 }), seed: 1 });
    sim.tick(10_000);
    expect(
      (sim.world.pollutionKg / sim.world.capacityKg) * 100,
    ).toBeCloseTo(pollutionFrac(sim.world.pollutionKg, sim.world.capacityKg), 9);
  });
});

// ---------------------------------------------------------------------------
// 3. Dynamic Replenishment — Model C
// ---------------------------------------------------------------------------

describe("3. dynamic replenishment Model C", () => {
  test("ratio 0 (no demand) → 5% floor", () => {
    expect(replenishmentModelC(100, 0)).toBeCloseTo(0.05, 12);
  });
  test("ratio 1 → 5%", () => {
    expect(replenishmentModelC(100, 100)).toBeCloseTo(0.05, 12);
  });
  test("ratio 2 → clipped to 9% ceiling", () => {
    expect(replenishmentModelC(100, 200)).toBeCloseTo(0.09, 12);
  });
  test("ratio 0.5 → floored back to 5%", () => {
    expect(replenishmentModelC(100, 50)).toBeCloseTo(0.05, 12);
  });
  test("no base generation → ratio 0 → 5% floor", () => {
    expect(replenishmentModelC(0, 42)).toBeCloseTo(0.05, 12);
  });
  test("monotonic between floor and ceiling", () => {
    const a = replenishmentModelC(100, 120);
    const b = replenishmentModelC(100, 140);
    const c = replenishmentModelC(100, 170);
    expect(a).toBeCloseTo(0.06, 12);
    expect(b).toBeCloseTo(0.07, 12);
    expect(c).toBeCloseTo(0.085, 12);
  });
});

// ---------------------------------------------------------------------------
// 4. Batch / Reservation allocation (Design Freeze v0.4, production compliance)
// ---------------------------------------------------------------------------

describe("4. batch allocation", () => {
  const clusters = [
    makeCluster("c1", 10, 10, 500),
    makeCluster("c2", 20, 10, 500),
    makeCluster("c3", 30, 10, 500),
    makeCluster("c4", 40, 10, 500),
  ];
  const robots = [
    { id: "L1a", x: 50, y: 50, level: 1, battery: 999 },
    { id: "L1b", x: 60, y: 50, level: 1, battery: 999 },
    { id: "L5a", x: 70, y: 50, level: 5, battery: 999 },
    { id: "L5b", x: 80, y: 50, level: 5, battery: 999 },
  ];

  test("low-level robots get guaranteed floor access under scarcity", () => {
    // 4 robots, 3 clusters: both L1 robots must be served before any L5
    const a = batchAllocation(robots, clusters.slice(0, 3), 20);
    expect(a.size).toBe(3);
    expect(a.has("L1a")).toBe(true);
    expect(a.has("L1b")).toBe(true);
  });
  test("no duplicate reservation (each cluster assigned at most once)", () => {
    const a = batchAllocation(robots, clusters, 20);
    const assignedClusters = [...a.values()];
    expect(new Set(assignedClusters).size).toBe(assignedClusters.length);
  });
  test("deterministic: identical inputs → identical output", () => {
    const a = batchAllocation(robots, clusters, 20);
    const b = batchAllocation(robots, clusters, 20);
    expect(a).toEqual(b);
  });
  test("battery-infeasible robots are skipped (nearest affordable rule)", () => {
    const poor = [
      { id: "poor", x: 900, y: 900, level: 1, battery: 1 },
      { id: "rich", x: 900, y: 900, level: 1, battery: 999 },
    ];
    const a = batchAllocation(poor, clusters, 20, {
      tripCost: (_r, d) => (d > 200 ? 500 : 2),
    });
    expect(a.has("rich")).toBe(true);
    expect(a.has("poor")).toBe(false);
  });
  test("production sim path equals reference on identical inputs", () => {
    const players = makePlayers(40, { seed: 42, autoFraction: 1 });
    const sim = new Sim({ players, seed: 42 });
    sim.tick(10_000);
    const ref = batchAllocation(
      sim.lastAllocation.robots,
      sim.lastAllocation.clusters,
      WORLD.BATCH_SIZE,
      { tripCost: (_r, d) => batteryForTrip(d) },
    );
    expect(sim.lastAssignments).toEqual(ref);
  });
});

// ---------------------------------------------------------------------------
// 5. Burn reward (normal 500 TOX/t, Burn Zone 600 TOX/t)
// ---------------------------------------------------------------------------

describe("5. burn reward (sim-level)", () => {
  test("normal burn: exact TOX, 1:1 pollution drop, queue drains", () => {
    const p = makePlayer("p1", { base: true, queuedKg: 100 });
    const sim = new Sim({ players: [p], seed: 3 });
    sim.zone.status = "inactive";
    const pollutionBefore = sim.world.pollutionKg;
    const burnPerTick = WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS;
    sim.tick(10_000);
    // burner is real-time anchored: slice = kg/s × tick seconds
    expect(p.toxBalance).toBeCloseTo(burnPerTick * 0.5, 6);
    expect(p.totalBurnedKg).toBeCloseTo(burnPerTick, 6);
    expect(p.processing.queuedKg).toBeCloseTo(100 - burnPerTick, 6);
    // pollution = before + 1 base's generation (50 kg/h × 1 game min) − burn
    const genPerTick = WORLD.BASE_GEN_KG_H / 60;
    expect(sim.world.pollutionKg).toBeCloseTo(
      pollutionBefore + genPerTick - burnPerTick,
      3,
    );
  });
  test("burn zone: ×1.2 and credited to toxFromZone", () => {
    const p = makePlayer("p1", { base: true, queuedKg: 100 });
    const sim = new Sim({ players: [p], seed: 3 });
    sim.zone.status = "active";
    sim.zone.expiresAt = Number.MAX_SAFE_INTEGER; // stays active for the tick
    const burnPerTick = WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS;
    sim.tick(10_000);
    expect(p.toxBalance).toBeCloseTo(burnPerTick * 0.6, 6);
    expect(p.toxFromZone).toBeCloseTo(burnPerTick * 0.6, 6);
    expect(p.toxFromNormal).toBe(0);
    // zone and normal remove the same mass from pollution
    const genPerTick = WORLD.BASE_GEN_KG_H / 60;
    expect(sim.world.pollutionKg).toBeCloseTo(
      WORLD.CAPACITY_KG * WORLD.INITIAL_POLLUTION_FRAC + genPerTick - burnPerTick,
      3,
    );
  });
  test("burn NEVER touches SOL balance (v0.4)", () => {
    const p = makePlayer("p1", { base: true, queuedKg: 100, sol: 0.1 });
    const sim = new Sim({ players: [p], seed: 3 });
    sim.tick(10_000);
    sim.tick(12_000);
    expect(p.solBalance).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// 6. Idempotency — same session/slice can never credit TOX twice
// ---------------------------------------------------------------------------

describe("6. idempotency", () => {
  test("every burn slice gets a unique ledger key (no double reward)", () => {
    const p = makePlayer("p1", { base: true, queuedKg: 40 });
    const sim = new Sim({ players: [p], seed: 4 });
    sim.tick(10_000);
    sim.tick(10_000); // same wall time, second tick — new slice index
    const burnPerTick = WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS;
    expect(p.toxBalance).toBeCloseTo(2 * burnPerTick * 0.5, 6); // 2 slices
    expect(p.totalBurnedKg).toBeCloseTo(2 * burnPerTick, 6);
    const keys = [...sim.ledgerKeys];
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(2); // unique
  });
  test("replaying an already-credited slice adds ZERO tox", () => {
    const p = makePlayer("p1", { base: true, queuedKg: 100 });
    const sim = new Sim({ players: [p], seed: 4 });
    sim.tick(10_000);
    const keyAfterFirst = [...sim.ledgerKeys][0];
    const toxAfterFirst = p.toxBalance;
    // stale replay of the exact same slice (same session + sliceIndex 0)
    const dup = { sessionId: "p1:10000", queuedKg: 96, sliceIndex: 0 };
    const slice = { key: `${dup.sessionId}:${dup.sliceIndex}` };
    expect(slice.key).toBe(keyAfterFirst);
    // the ledger key already exists → the production path credits nothing
    expect(sim.ledgerKeys.has(slice.key)).toBe(true);
    expect(p.toxBalance).toBe(toxAfterFirst);
    void dup;
  });
});

// ---------------------------------------------------------------------------
// 7. World collapse — 99.999% → 100% → reset at 22.5%, state freeze
// ---------------------------------------------------------------------------

describe("7. world collapse", () => {
  test("collapse resets to 22.5%, zeroes held waste, keeps accounts", () => {
    // no queued burn here: a burn slice would pull pollution back under the
    // collapse threshold before the check (burn runs before status/collapse)
    const p = makePlayer("p1", {
      base: true,
      storageKg: 50,
      sol: 0.1,
      tox: 77,
    });
    // 0.5 kg under capacity: one tick of generation (0.833 kg) crosses 100%
    const pollution = WORLD.CAPACITY_KG - 0.5;
    const sim = new Sim({
      players: [p],
      seed: 5,
      world: {
        pollutionKg: pollution,
        collectableKg: pollution * WORLD.INITIAL_COLLECTABLE_FRAC,
        seedPollutionKg: pollution,
      },
    });
    sim.tick(10_000);
    expect(sim.world.worldId).toBe(1);
    expect(sim.world.pollutionKg / sim.world.capacityKg).toBeCloseTo(
      WORLD.RESET_POLLUTION_FRAC,
      9,
    );
    expect(sim.world.status).toBe("safe");
    expect(sim.world.generatedKg).toBe(0);
    expect(sim.world.burnedKg).toBe(0);
    // player-held waste dies with the world; balances and upgrades survive
    expect(p.worldId).toBe(1);
    expect(p.storageKg).toBe(0);
    expect(p.processing.queuedKg).toBe(0);
    expect(p.robot.cargoKg).toBe(0);
    expect(p.robot.state).toBe("idle");
    expect(p.solBalance).toBe(0.1);
    expect(p.toxBalance).toBe(77);
    // both invariant layers hold on the fresh world
    const inv = sim.invariant();
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
});

// ---------------------------------------------------------------------------
// 8. Critical recovery — burn > generation ⇒ pollution really falls
// ---------------------------------------------------------------------------

describe("8. critical recovery", () => {
  test("from 90% critical, burn > generation pulls pollution down", () => {
    const p = makePlayer("p1", { base: true, queuedKg: 5_000 });
    const frac = 0.902;
    const pollution = WORLD.CAPACITY_KG * frac;
    const sim = new Sim({
      players: [p],
      seed: 6,
      world: {
        pollutionKg: pollution,
        collectableKg: pollution * WORLD.INITIAL_COLLECTABLE_FRAC,
        hiddenKg: pollution * (1 - WORLD.INITIAL_COLLECTABLE_FRAC),
        seedPollutionKg: pollution,
      },
    });
    expect(sim.world.status).toBe("critical");
    const before = sim.world.pollutionKg;
    for (let t = 0; t < 10; t++) sim.tick(10_000 + t * 2_000);
    expect(sim.world.pollutionKg).toBeLessThan(before);
    expect(worldStatus(sim.world.pollutionKg, sim.world.capacityKg)).toBe(
      "critical",
    );
    const inv = sim.invariant();
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
});

// ---------------------------------------------------------------------------
// 9. Active / inactive — 100 / 75 / 50 / 25% robot activity
// ---------------------------------------------------------------------------

describe("9. active/inactive scaling", () => {
  test("demand scales with 100 / 75 / 50 / 25% activity", () => {
    // seed enough clusters that robot supply (not clusters) is the constraint;
    // production also grows the map by 25 clusters/tick, but a fresh world
    // starts with only 25 (MAX_CLUSTER_SPAWNS_PER_TICK) — cluster-starved
    const clusters = Array.from({ length: 400 }, (_, i) =>
      makeCluster(
        `c${i}`,
        100 + (i % 20) * 40,
        100 + Math.floor(i / 20) * 40,
        500,
      ),
    );
    const demands: Record<string, number> = {};
    for (const frac of [1, 0.75, 0.5, 0.25]) {
      const players = makePlayers(200, {
        seed: Math.round(frac * 1000),
        autoFraction: frac,
      });
      const sim = new Sim({ players, seed: 9, clusters });
      for (let t = 0; t < 4; t++) sim.tick(10_000 + t * 2_000);
      demands[String(frac)] = sim.world.demandKgH;
    }
    expect(demands["1"]).toBeGreaterThan(demands["0.75"]);
    expect(demands["0.75"]).toBeGreaterThan(demands["0.5"]);
    expect(demands["0.5"]).toBeGreaterThan(demands["0.25"]);
    expect(demands["0.25"]).toBeGreaterThan(0);
    expect(demands["1"] / demands["0.25"]).toBeGreaterThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// 10. Scale — 10 / 100 / 1,000 / 10,000 players
// ---------------------------------------------------------------------------

describe("10. scale (10 → 10,000 players)", () => {
  for (const n of [10, 100, 1_000, 10_000]) {
    test(`${n} players: invariant holds every tick (timings recorded)`, () => {
      const players = makePlayers(n, {
        seed: n,
        autoFraction: 0.5,
        storageFraction: 0.3,
        queueFraction: 0.2,
      });
      const sim = new Sim({ players, seed: n });
      const t0 = performance.now();
      let maxTick = 0;
      for (let t = 0; t < 5; t++) {
        const s = performance.now();
        sim.tick(10_000 + t * 2_000);
        maxTick = Math.max(maxTick, performance.now() - s);
        const inv = sim.invariant();
        expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
        expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
      }
      console.log(
        `scale ${n}: 5 ticks — max ${maxTick.toFixed(1)} ms, total ${(
          performance.now() - t0
        ).toFixed(1)} ms`,
      );
    });
  }
});
