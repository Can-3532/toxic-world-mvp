// TOXIC WORLD — PRODUCTION ENGINE TEST HARNESS (Sprint 2.4 / 2.5 acceptance).
// Runs the REAL pure functions the production tick calls (src/convex/engine.ts)
// and drives the deterministic oracle (tests/engineSim.ts) through whole-world
// scenarios: waste invariant, pollution match, Model C replenishment, Batch/
// Reservation allocation, burn rewards, idempotency, world collapse freeze,
// critical recovery, active/inactive populations, and 10/100/1k/10k scale.
//
// Run:  bun test tests/engine.test.ts

import { describe, it as test, expect } from "vitest";
import {
  batchAllocation,
  checkWasteInvariant,
  collapseResetValues,
  pollutionFrac,
  replenishmentModelC,
  robotDemands,
  worldStatus,
} from "../src/convex/engine";
import { WORLD } from "../src/convex/gameParams";
import {
  freshWorld,
  makePlayer,
  runTicks,
  simTick,
  storageCap,
} from "./engineSim";

// ---------------------------------------------------------------------------
// 1. Two-layer waste invariant (Sprint 2.5 spec)
// ---------------------------------------------------------------------------

describe("waste invariant (two layers)", () => {
  test("Layer 1: seed + generated == pollution + burned", () => {
    const r = checkWasteInvariant({
      initialWasteKg: 5_000_000,
      generatedKg: 1_200,
      pollutionKg: 5_000_000 + 1_200 - 500,
      burnedKg: 500,
      hiddenKg: 4_449_630,
      collectableKg: 494_170,
      clusterKg: 55_700,
      cargoKg: 0,
      storageKg: 0,
      processingKg: 0,
    });
    expect(r.massBalance).toBeCloseTo(0, 6);
    // Layer 2: holdings must equal pollution − generated (4,999,500 here)
    expect(r.poolBalance).toBeCloseTo(0, 6);
  });

  test("the same kg in two buckets (cluster + cargo) is detected as double-count", () => {
    // The same physical 100 kg appears in BOTH cluster and cargo, so the
    // recorded holdings (hidden + collectable = 4,999,900, + 200 in the two
    // buckets = 5,000,100) exceed the atmosphere (5,000,000) by exactly the
    // double-counted 100 kg.
    const r = checkWasteInvariant({
      initialWasteKg: 5_000_000,
      generatedKg: 0,
      pollutionKg: 5_000_000,
      burnedKg: 0,
      hiddenKg: 4_500_000,
      collectableKg: 499_900,
      clusterKg: 100, // <- also counted in cargo below
      cargoKg: 100,
      storageKg: 0,
      processingKg: 0,
    });
    expect(r.poolBalance).toBeCloseTo(100, 6); // skew = double-counted mass
  });

  test("pollution fraction matches current pollution / capacity × 100", () => {
    expect(pollutionFrac(5_000_000, 10_000_000)).toBeCloseTo(50, 9);
    expect(pollutionFrac(9_000_000, 10_000_000)).toBeCloseTo(90, 9);
    expect(pollutionFrac(10_000_000, 10_000_000)).toBeCloseTo(100, 9);
  });
});

// ---------------------------------------------------------------------------
// 3. Dynamic Replenishment — Model C
// ---------------------------------------------------------------------------

describe("Model C replenishment", () => {
  test("ratio = demand / generation; repl = clip(0.05 × ratio, 5%, 9%)", () => {
    // ratio 1.0 → 0.05
    expect(replenishmentModelC(100, 100)).toBeCloseTo(0.05, 9);
    // ratio 1.8 → 0.09 → clipped at max
    expect(replenishmentModelC(100, 180)).toBeCloseTo(0.09, 9);
    // ratio 0.4 → 0.02 → clipped at floor 0.05
    expect(replenishmentModelC(100, 40)).toBeCloseTo(0.05, 9);
    // ratio 0 → floor
    expect(replenishmentModelC(100, 0)).toBeCloseTo(0.05, 9);
    // no generation: the freeze formula is clip(0.05×ratio, 0.05, 0.09), and
    // the engine defines ratio = 0 when gen = 0, so the floor still applies
    // (0.05). This case is unreachable in production anyway: demand comes from
    // active robots, which require bases, which generate.
    expect(replenishmentModelC(0, 42)).toBeCloseTo(0.05, 9);
  });

  test("typical starter ratios sit at the 5% floor (frozen Sprint 2.9 behavior)", () => {
    // gen = 50 kg/game-h per base; demand ref = 42 → ratio 0.84 → 0.042 → floor
    expect(replenishmentModelC(500, 420)).toBeCloseTo(0.05, 9);
  });
});

// ---------------------------------------------------------------------------
// 4. World status thresholds
// ---------------------------------------------------------------------------

describe("world status / collapse thresholds", () => {
  test("90% critical, 100% collapsed, below safe", () => {
    const cap = 10_000_000;
    expect(worldStatus(8_999_999, cap)).toBe("safe");
    expect(worldStatus(9_000_000, cap)).toBe("critical");
    expect(worldStatus(9_999_999.9, cap)).toBe("critical");
    expect(worldStatus(10_000_000, cap)).toBe("collapsed");
  });

  test("collapse reset: World 1+ starts at 22.5%, 10% collectable", () => {
    const r = collapseResetValues(10_000_000);
    expect(r.pollutionKg).toBeCloseTo(2_250_000, 6);
    expect(r.collectableKg).toBeCloseTo(225_000, 6);
    expect(r.hiddenKg).toBeCloseTo(2_025_000, 6);
  });
});

describe("robotDemands predicate", () => {
  test("movement/collection states demand; parked/charging states do not", () => {
    for (const s of ["to_cluster", "collecting", "to_base"]) {
      expect(robotDemands(s)).toBe(true);
    }
    for (const s of ["idle", "unloading", "recharging"]) {
      expect(robotDemands(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Batch / Reservation allocation (Sprint 2.5 production compliance)
// ---------------------------------------------------------------------------

describe("Batch/Reservation allocation", () => {
  const cluster = (id: number, x: number, y: number, kg = 500) => ({
    id,
    x,
    y,
    kg,
  });

  test("shared pool scarcity: fewer clusters than robots ⇒ some robots wait", () => {
    const robots = [1, 2, 3, 4, 5].map((i) => ({
      id: i,
      x: i * 10,
      y: i * 10,
      level: 1,
    }));
    const clusters = [cluster(1, 5, 5), cluster(2, 15, 15)];
    const a = batchAllocation(robots, clusters, 20);
    expect(a.size).toBe(2);
    expect(new Set(a.values()).size).toBe(2); // no duplicate reservation
  });

  test("guaranteed floor access: L1 robots reserve before L5 under scarcity", () => {
    const robots = [
      { id: "l5-1", x: 1, y: 1, level: 5 },
      { id: "l5-2", x: 2, y: 2, level: 5 },
      { id: "l1-1", x: 3, y: 3, level: 1 },
    ];
    const clusters = [cluster(10, 5, 5), cluster(11, 6, 6)];
    const a = batchAllocation(robots, clusters, 20);
    expect(a.has("l1-1")).toBe(true); // low-level robot got floor access
    expect([...a.keys()]).toEqual(expect.arrayContaining(["l1-1"]));
  });

  test("no duplicate reservation + deterministic result", () => {
    const robots = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
      id: i,
      x: (i % 4) * 10,
      y: Math.floor(i / 4) * 10,
      level: (i % 3) + 1,
    }));
    const clusters = [1, 2, 3, 4, 5].map((i) => cluster(i, i * 12, i * 12));
    const a1 = batchAllocation(robots, clusters, 20);
    const a2 = batchAllocation(robots, clusters, 20);
    expect([...a1.entries()].sort()).toEqual([...a2.entries()].sort());
    expect(new Set(a1.values()).size).toBe(a1.size);
  });

  test("battery feasibility: an unaffordable trip is skipped (distance order)", () => {
    const robots = [
      { id: "poor", x: 0, y: 0, level: 1, battery: 10 },
      { id: "rich", x: 0, y: 0, level: 1, battery: 500 },
    ];
    // nearest cluster far enough that tripCost > 10
    const clusters = [cluster(1, 300, 0, 500), cluster(2, 310, 0, 500)];
    const tripCost = (_r: { id: string }, d: number) => d; // 1 battery per meter
    const a = batchAllocation(robots, clusters, 20, { tripCost });
    expect(a.has("poor")).toBe(false);
    expect(a.has("rich")).toBe(true);
  });

  test("SCALE: 10k robots × 500 clusters headless allocation (Sprint 2.4 item 10)", () => {
    const robots = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      x: (i * 7) % 1000,
      y: (i * 13) % 1000,
      level: (i % 5) + 1,
      battery: 1000, // all trips feasible
    }));
    const clusters = Array.from({ length: 500 }, (_, i) =>
      cluster(i, (i * 31) % 1000, (i * 17) % 1000),
    );
    const t0 = performance.now();
    const a = batchAllocation(robots, clusters, 20);
    const ms = performance.now() - t0;
    // 500 clusters → at most 500 reservations, all unique
    expect(a.size).toBeLessThanOrEqual(500);
    expect(new Set(a.values()).size).toBe(a.size);
    expect(ms).toBeLessThan(5000); // sanity bound, not an SLA
  });
});

// ---------------------------------------------------------------------------
// Whole-world scenarios — deterministic oracle (tests/engineSim.ts)
// ---------------------------------------------------------------------------

describe("whole-world oracle (mirrors world.ts runTick)", () => {
  test("invariant layers stay exact across many ticks (generation + burn)", () => {
    const s = freshWorld(10_000_000);
    const p = makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500 }, 0);
    s.players.push(p);
    // seed a burn queue so the burn path runs — the queued kg is REAL pool
    // mass, so it must be debited from the collectable pool (mirrors
    // harness:seedLoad) or Layer 2 reads it as phantom drift.
    s.players[0].processing = {
      queuedKg: 1000,
      since: 0,
      sessionId: "p1:0",
      sliceIndex: 0,
    };
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 1000);
    const { state, mass, pool } = runTicks(s, 60);
    expect(mass).toBeCloseTo(0, 6);
    expect(pool).toBeCloseTo(0, 6);
    expect(state.world.generationRateKgH).toBeCloseTo(50, 6);
    expect(state.world.burnedKg).toBeGreaterThan(0);
    expect(state.players[0].toxBalance).toBeGreaterThan(0);
  });

  test("pollution ticks up with generation (50 kg/game-h per active base)", () => {
    const s = freshWorld(10_000_000, 0.5); // World 0 at 50%
    s.players.push(makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500 }, 0));
    const before = s.world.pollutionKg;
    const { state } = runTicks(s, 60); // 60 ticks = 1 game hour
    const expected = before + WORLD.BASE_GEN_KG_H; // 1 game hour of generation
    expect(state.world.pollutionKg).toBeCloseTo(expected, 3);
  });

  test("pollution % on the world doc matches pollution / capacity × 100", () => {
    const s = freshWorld(10_000_000, 0.5);
    s.players.push(makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500 }, 0));
    const { state } = runTicks(s, 30);
    expect(pollutionFrac(state.world.pollutionKg, state.world.capacityKg)).toBeCloseTo(
      (state.world.pollutionKg / state.world.capacityKg) * 100,
      9,
    );
  });

  test("WORLD COLLAPSE: 99.999% → 100% transition freezes the old cycle and resets", () => {
    const s = freshWorld(10_000_000, 0.99999); // just below 100%
    s.players.push(makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500 }, 0));
    // one base generates 50 kg/game-h = 0.8333 kg/tick; from 9,999,900 kg the
    // world crosses 100% on the ~120th tick. Drive until the transition so the
    // post-collapse assertions run on the freshly-reset world (before any
    // follow-up generation advances it again).
    let now = s.world.lastTick;
    const events: { type: string; message: string }[] = [];
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      events.push(...simTick(s, now, false).events);
    }
    expect(events.some((e) => e.type === "collapse")).toBe(true);
    expect(s.world.worldId).toBe(1); // reset to World 1
    expect(s.world.status).toBe("safe");
    // reset seed: 22.5% × capacity, burned/generated re-anchored to 0
    expect(s.world.pollutionKg).toBeCloseTo(10_000_000 * WORLD.RESET_POLLUTION_FRAC, 3);
    expect(s.world.burnedKg).toBe(0);
    expect(s.world.generatedKg).toBeCloseTo(0, 6);
    // both invariant layers re-anchored to exactly 0 — verify via follow-up
    // ticks (which also re-run generation against the new seed)
    const r2 = simTick(s, now + WORLD.TICK_SECONDS * 1000, false);
    expect(Math.abs(r2.invariantMass)).toBeLessThan(1e-6);
    expect(Math.abs(r2.invariantPool)).toBeLessThan(1e-6);
  });

  test("critical recovery: burn > generation drives pollution back below 90%", () => {
    // small world so one player's burn (10 kg/tick) outweighs generation (0.83 kg/tick)
    const s = freshWorld(10_000, 0.91); // 9,100 kg → 91% critical
    s.players.push(makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500 }, 0));
    s.players[0].processing = {
      queuedKg: 10_000,
      since: 0,
      sessionId: "p1:crit",
      sliceIndex: 0,
    };
    let crossed = false;
    let now = s.world.lastTick;
    for (let i = 0; i < 60; i++) {
      now += 5000;
      const r = simTick(s, now, false);
      if (r.state.world.status === "safe" && r.state.world.pollutionKg / r.state.world.capacityKg < 0.9) {
        crossed = true;
        break;
      }
    }
    expect(crossed).toBe(true);
    expect(s.world.status).toBe("safe");
    expect(Math.abs(s.world.pollutionKg / s.world.capacityKg - pollutionFrac(s.world.pollutionKg, s.world.capacityKg) / 100)).toBeLessThan(1e-9);
  });

  test("active/inactive populations: demand scales 25/50/75/100% with activity", () => {
    // one cluster parked next to each base so an active robot always has an
    // affordable target and enters a demand state (to_cluster/collecting)
    const mk = (id: number, auto: boolean) => {
      const bx = 400 + id * 10;
      const by = 400;
      return { p: makePlayer(id, { hasBase: true, baseX: bx, baseY: by, auto }, 0), bx, by };
    };
    const demands: number[] = [];
    for (const active of [1, 2, 3, 4]) {
      const s = freshWorld(10_000_000, 0.5);
      for (let i = 0; i < 4; i++) {
        const { p, bx, by } = mk(i, i < active);
        s.players.push(p);
        s.clusters.push({ id: `near-${i}`, x: bx + 10, y: by, kg: 500 });
      }
      const { state } = runTicks(s, 1);
      // each ACTIVE robot entered a demand state → 42 ref each; parked robots → 0
      expect(state.world.demandKgH).toBeCloseTo(active * 42, 6);
      demands.push(state.world.demandKgH);
    }
    expect(demands).toEqual([42, 84, 126, 168]); // 25% / 50% / 75% / 100%
  });

  test("SCALE: 10 / 100 / 1,000 players hold both invariants through 10 ticks", () => {
    for (const count of [10, 100, 1000]) {
      const s = freshWorld(10_000_000, 0.5);
      for (let i = 0; i < count; i++) {
        s.players.push(
          makePlayer(i, {
            hasBase: true,
            baseX: 100 + (i % 20) * 20,
            baseY: 100 + Math.floor(i / 20) * 20,
            toxBalance: 0,
            auto: i % 2 === 0,
          }, 0),
        );
      }
      const { mass, pool } = runTicks(s, 10);
      expect(Math.abs(mass)).toBeLessThan(1e-6);
      expect(Math.abs(pool)).toBeLessThan(1e-6);
    }
  });

  test("robots collect into storage and storage is the AFK buffer (Sprint 2.10)", () => {
    const s = freshWorld(10_000_000, 0.5);
    s.players.push(makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500 }, 0));
    // place one cluster right at the base so the trip completes quickly.
    // freshWorld already spawned clusters and deducted them from collectableKg;
    // replacing the array without rebalancing leaves the seeded leftover as
    // phantom pool mass, so move the removed kg back into the collectable pool.
    const seededKg = s.clusters.reduce((a, c) => a + c.kg, 0);
    s.clusters = [{ id: "near", x: 506, y: 500, kg: 40 }];
    s.world.collectableKg += seededKg - 40;
    const { state, pool } = runTicks(s, 6); // 30 real seconds
    const p = state.players[0];
    const collected = p.totalCollectedKg + p.robot.cargoKg; // storage + in-flight cargo
    expect(collected).toBeGreaterThan(0);
    expect(p.robot.cargoKg).toBeLessThanOrEqual(20); // L1 cargo cap
    expect(p.storageKg).toBeLessThanOrEqual(storageCap(p)); // L1 storage cap
    // the collectable pool shrank 1:1 with what the robot holds (Layer 2 exact)
    expect(Math.abs(pool)).toBeLessThan(1e-6);
  });
});
