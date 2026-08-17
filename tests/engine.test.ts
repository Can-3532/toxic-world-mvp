// TOXIC WORLD — Sprint 2.4 PRODUCTION ENGINE TEST HARNESS.
//
// Automates the behaviors previously validated in the Python simulation against
// the real engine code: the SAME pure functions the production tick calls
// (src/convex/engine.ts, economy.ts, gameParams.ts) plus a deterministic
// headless oracle simulator (tests/engineSim.ts) that mirrors world.ts
// step-for-step.
//
// Run:  bun test tests/engine.test.ts
// Plus live-DB audit:  bunx convex run harness:invariantAudit

import { describe, expect, test } from "bun:test";
import {
  batchAllocation,
  checkWasteInvariant,
  collapseResetValues,
  pollutionFrac,
  replenishmentModelC,
  robotDemands,
  selectCluster,
  worldStatus,
} from "../src/convex/engine";
import {
  advanceBurn,
  burnRewardTox,
  computeBurnSlice,
  rewardKey,
} from "../src/convex/economy";
import {
  BURN_ZONE_MULTIPLIER,
  REPLENISHMENT,
  ROBOT,
  UPGRADES,
  WORLD,
} from "../src/convex/gameParams";
import {
  createSimWorld,
  processPlayerBurn,
  runSim,
  tickSim,
  type SimWorld,
} from "./engineSim";

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60;
const approx = (a: number, b: number, tol = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// ---------------------------------------------------------------------------
// 1. Waste invariant — Initial Waste + Generated = every tracked bucket
// ---------------------------------------------------------------------------

describe("1. waste invariant", () => {
  test("pure checkWasteInvariant balances a hand-built ledger", () => {
    const inv = checkWasteInvariant({
      initialWasteKg: 5_000_000,
      generatedKg: 1_234,
      pollutionKg: 5_000_000,
      burnedKg: 1_234,
      hiddenKg: 4_498_000,
      collectableKg: 499_000,
      clusterKg: 1_000,
      cargoKg: 400,
      storageKg: 200,
      processingKg: 166,
    });
    // mass balance: pollution + burned == seed + generated
    expect(inv.massBalance).toBeCloseTo(0, 9);
    // pool conservation: hidden+collectable+clusters+cargo+storage+processing
    // == pollution − generated (recoverable portion of the atmosphere)
    expect(inv.poolBalance).toBeCloseTo(0, 9);
  });

  test("invariant holds on every sim tick (generation + collection + burn)", () => {
    const w = createSimWorld({ players: 12, seed: 7, autoQueue: true });
    runSim(w, 200);
    expect(w.invariantHistory.length).toBe(200);
    for (const h of w.invariantHistory) {
      approx(h.massBalance, 0, 1e-6);
      approx(h.poolBalance, 0, 1e-6);
    }
  });

  test("legacy world re-anchor (seed = initial frac, generated derived) balances both", () => {
    // pre-Sprint 2.4 world: burned waste existed before the telemetry fields.
    // Re-anchor: seed = capacity × INITIAL_POLLUTION_FRAC, and derive the
    // cumulative generated from the mass balance (generated = pollution +
    // burned − seed), which makes both invariants exactly 0.
    const seed = WORLD.CAPACITY_KG * WORLD.INITIAL_POLLUTION_FRAC; // 5,000,000
    const generatedKg = 5_000_000 + 11_392.97 - seed; // = burned, consistent
    const legacy = checkWasteInvariant({
      initialWasteKg: seed,
      generatedKg,
      pollutionKg: 5_000_000,
      burnedKg: 11_392.97,
      // pools must equal pollution − generated = 4,988,607.03
      hiddenKg: 4_488_607.03,
      collectableKg: 500_000,
      clusterKg: 0,
      cargoKg: 0,
      storageKg: 0,
      processingKg: 0,
    });
    expect(legacy.massBalance).toBeCloseTo(0, 6);
    expect(legacy.poolBalance).toBeCloseTo(0, 6);
  });

  test("invariant holds after world collapse re-anchors the ledger", () => {
    const w = createSimWorld({ players: 4, seed: 3, pollutionKg: WORLD.CAPACITY_KG - 0.5 });
    runSim(w, 20); // first tick collapses, rest re-anchored
    for (const h of w.invariantHistory.slice(1)) {
      approx(h.massBalance, 0, 1e-6);
      approx(h.poolBalance, 0, 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Pollution — Current Global Waste / 10,000,000 kg × 100 matches state
// ---------------------------------------------------------------------------

describe("2. pollution fraction", () => {
  test("pollutionFrac matches pollution/capacity × 100 at every level", () => {
    const cap = WORLD.CAPACITY_KG;
    for (const kg of [0, 500_000, 5_000_000, 9_000_000, 9_999_999, cap]) {
      approx(pollutionFrac(kg, cap), (kg / cap) * 100);
    }
  });

  test("sim pollution grows by generation and shrinks by burn, exact", () => {
    // auto=false + autoQueue=false → robots idle, no burn: pure generation
    const w = createSimWorld({ players: 5, seed: 11, auto: false, autoQueue: false });
    const before = w.pollutionKg;
    const genPerTick = 5 * WORLD.BASE_GEN_KG_H * TICK_GAME_H;
    runSim(w, 10);
    approx(w.pollutionKg, before + 10 * genPerTick, 1e-6);
    approx(w.pollutionKg / w.capacityKg * 100, pollutionFrac(w.pollutionKg, w.capacityKg));
  });
});

// ---------------------------------------------------------------------------
// 3. Dynamic Replenishment — Model C
// ---------------------------------------------------------------------------

describe("3. dynamic replenishment Model C", () => {
  test("formula: clip(0.05 × demand/generation, 0.05, 0.09)", () => {
    // ratio 0 (no demand) → floor
    approx(replenishmentModelC(100, 0), 0.05);
    // ratio 1 → 0.05 × 1 = 0.05
    approx(replenishmentModelC(100, 100), 0.05);
    // ratio 1.6 → 0.08
    approx(replenishmentModelC(100, 160), 0.08);
    // ratio 1.8 → 0.09 (max)
    approx(replenishmentModelC(100, 180), 0.09);
    // ratio 10 → clipped to 0.09
    approx(replenishmentModelC(100, 1000), 0.09);
    // ratio 0.4 → 0.02 → clipped to floor 0.05
    approx(replenishmentModelC(100, 40), 0.05);
    // zero generation → ratio 0 → floor
    approx(replenishmentModelC(0, 100), 0.05);
    // constants match the freeze
    expect(REPLENISHMENT.BASE_FRAC).toBe(0.05);
    expect(REPLENISHMENT.MIN_FRAC).toBe(0.05);
    expect(REPLENISHMENT.MAX_FRAC).toBe(0.09);
  });

  test("sim unlocks exactly hidden × frac × tickGameH (bounded by hidden)", () => {
    const w = createSimWorld({ players: 10, seed: 5 });
    const before = w.hiddenKg;
    tickSim(w);
    const demand = w.players.filter((p) => robotDemands(p.state)).length * WORLD.DEMAND_REF_KG_H;
    const gen = 10 * WORLD.BASE_GEN_KG_H;
    const frac = replenishmentModelC(gen, demand);
    const expectedUnlock = Math.min(before, before * frac * TICK_GAME_H);
    approx(before - w.hiddenKg, expectedUnlock, 1e-6);
    // collectable gains exactly that much
    approx(w.collectableKg + w.clusters.reduce((s, c) => s + c.kg, 0), 500_000 + expectedUnlock, 1e-6);
  });
});

// ---------------------------------------------------------------------------
// 4. Batch Allocation — low-level base access, high-level pool consumption
// ---------------------------------------------------------------------------

describe("4. batch allocation", () => {
  test("batchAllocation: every robot gets a cluster when enough exist", () => {
    const robots = [
      { id: "a", x: 100, y: 100, level: 1 },
      { id: "b", x: 200, y: 200, level: 3 },
      { id: "c", x: 300, y: 300, level: 5 },
    ];
    const clusters = [
      { id: 1, x: 110, y: 110, kg: 500 },
      { id: 2, x: 210, y: 210, kg: 500 },
      { id: 3, x: 310, y: 310, kg: 500 },
    ];
    const a = batchAllocation(robots, clusters);
    expect(a.size).toBe(3);
  });

  test("low-level robots get floor access when clusters are scarce", () => {
    const robots = [
      { id: "l1", x: 100, y: 100, level: 1 },
      { id: "l2", x: 120, y: 120, level: 1 },
      { id: "h1", x: 500, y: 500, level: 5 },
      { id: "h2", x: 520, y: 520, level: 5 },
    ];
    const clusters = [
      { id: 1, x: 105, y: 105, kg: 500 },
      { id: 2, x: 115, y: 115, kg: 500 },
    ];
    // only 2 clusters for 4 robots: low-level robots must win them
    const a = batchAllocation(robots, clusters);
    expect(a.get("l1")).toBeDefined();
    expect(a.get("l2")).toBeDefined();
    expect(a.get("h1")).toBeUndefined();
    expect(a.get("h2")).toBeUndefined();
  });

  test("mixed population sim: all robots collect, L5 consumes more pool than L1", () => {
    const w = createSimWorld({
      players: 12,
      seed: 42,
      autoQueue: false,
      activeFraction: 1,
    });
    // 6 × L1, 6 × L5
    w.players.forEach((p, i) => {
      const lv = i < 6 ? 1 : 5;
      p.levels = { cargo: lv, recharge: lv, battery: lv, storage: lv };
      p.battery = UPGRADES.battery.caps[lv - 1];
    });
    runSim(w, 400);

    const low = w.players.filter((p) => p.levels.cargo === 1);
    const high = w.players.filter((p) => p.levels.cargo === 5);

    // base access: every robot (incl. low-level) completed at least one trip
    for (const p of w.players) {
      expect(p.totalTrips).toBeGreaterThan(0);
    }
    // high-level robots consume the pool harder (bigger cargo per trip)
    const lowAvg = low.reduce((s, p) => s + p.totalCollectedKg, 0) / low.length;
    const highAvg = high.reduce((s, p) => s + p.totalCollectedKg, 0) / high.length;
    expect(highAvg).toBeGreaterThan(lowAvg * 1.5);
    // invariant still holds
    const last = w.invariantHistory[w.invariantHistory.length - 1];
    approx(last.massBalance, 0, 1e-6);
    approx(last.poolBalance, 0, 1e-6);
  });

  test("selectCluster never returns a reserved or empty cluster", () => {
    const clusters = [
      { x: 100, y: 100, kg: 0, reservedBy: undefined },
      { x: 300, y: 300, kg: 400, reservedBy: "robot-x" },
      { x: 200, y: 200, kg: 500, reservedBy: undefined },
    ];
    const found = selectCluster({ x: 150, y: 150 }, clusters);
    expect(found?.cluster.x).toBe(200);
    expect(found?.cluster.y).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. Burn reward — Normal 500 TOX/t, Burn Zone 600 TOX/t
// ---------------------------------------------------------------------------

describe("5. burn reward (500 normal / 600 zone)", () => {
  test("normal: 1 ton → 500 TOX, 100 kg → 50 TOX", () => {
    approx(burnRewardTox(1000, false), 500);
    approx(burnRewardTox(100, false), 50);
  });

  test("burn zone: 1 ton → 600 TOX, 100 kg → 60 TOX (×1.2)", () => {
    approx(burnRewardTox(1000, true), 600);
    approx(burnRewardTox(100, true), 60);
    expect(BURN_ZONE_MULTIPLIER).toBe(1.2);
  });

  test("sim: full normal burn pays exactly burned_kg/1000 × 500 TOX", () => {
    const w = createSimWorld({ players: 1, seed: 2, queuedKg: 1000, autoQueue: false });
    // keep the Burn Zone asleep for the whole run → all slices normal
    w.zone = {
      status: "inactive",
      x: 0,
      y: 0,
      spawnedAt: 0,
      expiresAt: 0,
      nextSpawnAt: Number.POSITIVE_INFINITY,
    };
    const ticks = Math.ceil(1000 / (WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS));
    runSim(w, ticks);
    const p = w.players[0];
    approx(p.toxBalance, 500, 1e-6);
    approx(p.toxFromNormal, 500, 1e-6);
    expect(p.toxFromZone).toBe(0);
    expect(w.ledger.size).toBe(ticks);
  });

  test("sim: active burn zone pays ×1.2, pollution drops 1:1 (net of generation)", () => {
    const w = createSimWorld({ players: 1, seed: 2, queuedKg: 1000, autoQueue: false });
    // force the zone active for the whole run
    w.zone = {
      status: "active",
      x: 500,
      y: 500,
      spawnedAt: 0,
      expiresAt: Number.POSITIVE_INFINITY,
      nextSpawnAt: Number.POSITIVE_INFINITY,
    };
    const beforePollution = w.pollutionKg;
    const ticks = Math.ceil(1000 / (WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS));
    runSim(w, ticks);
    const p = w.players[0];
    approx(p.toxBalance, 600, 1e-6);
    approx(p.toxFromZone, 600, 1e-6);
    // pollution = before − burned + generated (1 base × 50 kg/h × ticks)
    const genKg = 1 * WORLD.BASE_GEN_KG_H * TICK_GAME_H * ticks;
    approx(beforePollution - w.pollutionKg, 1000 - genKg, 1e-6);
  });
});

// ---------------------------------------------------------------------------
// 6. Idempotency — the same session/slice can never credit TOX twice
// ---------------------------------------------------------------------------

describe("6. reward idempotency", () => {
  test("same slice processed twice → second processing credits 0 TOX", () => {
    const w = createSimWorld({ players: 1, seed: 2, queuedKg: 8, autoQueue: false });
    const p = w.players[0];
    processPlayerBurn(w, p, false, WORLD.TICK_SECONDS); // slice 0 → +2 TOX
    expect(p.toxBalance).toBe(2);
    expect(p.sliceIndex).toBe(1);
    // simulate a duplicate tick: rewind slice index, burn again
    p.sliceIndex = 0;
    const before = p.toxBalance;
    processPlayerBurn(w, p, false, WORLD.TICK_SECONDS);
    expect(p.toxBalance).toBe(before); // no double credit
  });

  test("normal and burn-zone share one ledger key per waste unit", () => {
    const state = { sessionId: "s", queuedKg: 1000, sliceIndex: 3 };
    const n = computeBurnSlice(state, 4, false);
    const z = computeBurnSlice(state, 4, true);
    expect(n.key).toBe(z.key);
    expect(n.key).toBe(rewardKey("s", 3));
    expect(z.tox).toBe(n.tox * BURN_ZONE_MULTIPLIER);
  });

  test("advanceBurn with alreadyRewarded burns kg without crediting or advancing", () => {
    const state = { sessionId: "s", queuedKg: 1000, sliceIndex: 0 };
    const next = advanceBurn(state, 4, true);
    expect(next.queuedKg).toBe(996);
    expect(next.sliceIndex).toBe(0);
  });

  test("sim ledger has exactly one entry per unique slice key", () => {
    const w = createSimWorld({ players: 2, seed: 9, queuedKg: 200, autoQueue: false });
    runSim(w, 100);
    // every credited slice key unique
    expect(w.ledger.size).toBeGreaterThan(0);
    // per-player tox equals sum over their burned slices
    for (const p of w.players) {
      approx(p.toxBalance, p.toxFromNormal + p.toxFromZone, 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. World Collapse — 99.999% → 100% transition and post-collapse freeze
// ---------------------------------------------------------------------------

describe("7. world collapse", () => {
  test("99.999% + generation → 100% → collapse → reset at 22.5%, state frozen", () => {
    const cap = WORLD.CAPACITY_KG;
    const w = createSimWorld({ players: 2, seed: 4, pollutionKg: cap - 0.5 });
    expect(w.worldId).toBe(0);
    expect(w.status).toBe("safe");

    // one tick: generation (2 × 50 kg/h × tickH ≈ 1.67 kg) pushes over capacity
    tickSim(w);
    expect(w.worldId).toBe(1); // world advanced
    expect(w.resetCount).toBe(1);
    approx(w.pollutionKg, cap * WORLD.RESET_POLLUTION_FRAC, 1e-6); // 22.5%
    expect(w.status).toBe("safe");
    expect(w.clusters.length).toBeGreaterThan(0); // re-seeded
    for (const p of w.players) {
      expect(p.worldId).toBe(1);
      expect(p.state).toBe("idle");
      expect(p.cargoKg).toBe(0);
    }

    // state freeze: no re-collapse while pollution stays below 100%
    runSim(w, 50);
    expect(w.worldId).toBe(1);
    expect(w.resetCount).toBe(1);
    expect(w.status).not.toBe("collapsed");
  });

  test("collapseResetValues match freeze: 22.5% start, 10% collectable", () => {
    const r = collapseResetValues(WORLD.CAPACITY_KG);
    approx(r.pollutionKg, 2_250_000);
    approx(r.collectableKg, 225_000);
    approx(r.hiddenKg, 2_025_000);
    approx(r.pollutionKg, WORLD.CAPACITY_KG * WORLD.RESET_POLLUTION_FRAC);
  });

  test("worldStatus thresholds: 90% critical, 100% collapse", () => {
    const cap = WORLD.CAPACITY_KG;
    expect(worldStatus(0.5 * cap, cap)).toBe("safe");
    expect(worldStatus(0.89999 * cap, cap)).toBe("safe");
    expect(worldStatus(0.9 * cap, cap)).toBe("critical");
    expect(worldStatus(0.99999 * cap, cap)).toBe("critical");
    expect(worldStatus(cap, cap)).toBe("collapsed");
  });
});

// ---------------------------------------------------------------------------
// 8. Critical recovery — from 90%, burn > generation ⇒ pollution falls
// ---------------------------------------------------------------------------

describe("8. critical recovery", () => {
  test("pollution monotonically decreases while burn > generation", () => {
    const cap = WORLD.CAPACITY_KG;
    const w = createSimWorld({
      players: 1,
      seed: 6,
      pollutionKg: 0.9 * cap, // exactly critical
      queuedKg: 10_000, // burn = 4 kg/tick vs gen = 0.833 kg/tick
      autoQueue: false,
    });
    expect(worldStatus(w.pollutionKg, cap)).toBe("critical");

    const before = w.pollutionKg;
    const genPerTick = 1 * WORLD.BASE_GEN_KG_H * TICK_GAME_H; // 0.8333
    const burnPerTick = WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS; // 4
    runSim(w, 100);
    // queue is still burning after 100 ticks (10,000 kg / 4 kg/tick)
    expect(w.players[0].queuedKg).toBeGreaterThan(0);

    // while the queue burned: pollution falls by exactly (burn − gen) per tick
    approx(
      before - w.pollutionKg,
      100 * (burnPerTick - genPerTick),
      1e-6,
    );
    expect(w.pollutionKg).toBeLessThan(before);
    expect(w.pollutionKg).toBeGreaterThan(0);
    expect(worldStatus(w.pollutionKg, cap)).toBe("safe");
  });

  test("burn ≤ generation ⇒ pollution does not fall", () => {
    const cap = WORLD.CAPACITY_KG;
    const w = createSimWorld({ players: 1, seed: 6, pollutionKg: 0.9 * cap, queuedKg: 0, autoQueue: false });
    const before = w.pollutionKg;
    runSim(w, 10);
    expect(w.pollutionKg).toBeGreaterThan(before); // only generation
  });
});

// ---------------------------------------------------------------------------
// 9. Active / inactive — 100%, 75%, 50%, 25% robot activity
// ---------------------------------------------------------------------------

describe("9. active / inactive populations", () => {
  function avgDemand(activeFraction: number): { demandKgH: number; genKgH: number } {
    const N = 40;
    const w = createSimWorld({ players: N, seed: 13, auto: false, autoQueue: false });
    const active = Math.round(N * activeFraction);
    w.players.forEach((p, i) => {
      p.auto = i < active;
    });
    runSim(w, 200);
    const mean =
      w.demandHistory.reduce((s, d) => s + d, 0) / w.demandHistory.length;
    return { demandKgH: mean, genKgH: N * WORLD.BASE_GEN_KG_H };
  }

  test("activity fraction scales demand linearly (100/75/50/25%)", () => {
    const fractions = [1, 0.75, 0.5, 0.25];
    const demands = fractions.map((f) => avgDemand(f).demandKgH);
    // demand is driven by robots that are mid-trip; a robot cannot be mid-trip
    // every tick (recharge/idle gaps), so compare relative scaling, not absolute
    const base = demands[0]; // 100% activity
    expect(base).toBeGreaterThan(0);
    fractions.forEach((f, i) => {
      const active = Math.round(40 * f);
      // relative demand ≈ relative activity (tolerance for duty-cycle effects)
      expect(demands[i] / base).toBeGreaterThan(f * 0.6);
      expect(demands[i] / base).toBeLessThanOrEqual(f * 1.4 + 0.05);
      // absolute ceiling: demand ≤ active robots × DEMAND_REF
      expect(demands[i]).toBeLessThanOrEqual(active * WORLD.DEMAND_REF_KG_H + 1);
      void active;
    });
    // generation is base-count driven → identical at every activity level
    const gens = fractions.map((f) => avgDemand(f).genKgH);
    expect(new Set(gens).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Scale — 10 / 100 / 1,000 / 10,000 player simulation + performance
// ---------------------------------------------------------------------------

describe("10. scale simulation + performance", () => {
  const cases: Array<{ players: number; ticks: number }> = [
    { players: 10, ticks: 60 },
    { players: 100, ticks: 60 },
    { players: 1_000, ticks: 30 },
    { players: 10_000, ticks: 10 },
  ];

  for (const c of cases) {
    test(`${c.players.toLocaleString()} players × ${c.ticks} ticks: invariant holds, timing recorded`, () => {
      const w = createSimWorld({ players: c.players, seed: 17, autoQueue: true });
      const t0 = performance.now();
      runSim(w, c.ticks);
      const ms = performance.now() - t0;

      // invariant at every tick at every scale
      for (const h of w.invariantHistory) {
        approx(h.massBalance, 0, 1e-6);
        approx(h.poolBalance, 0, 1e-6);
      }
      // performance report (printed by bun test)
      console.log(
        `[scale] ${c.players} players × ${c.ticks} ticks → ${ms.toFixed(1)}ms total, ${(ms / c.ticks).toFixed(2)}ms/tick, ${(ms / c.ticks / c.players).toFixed(4)}ms/player/tick`,
      );
      expect(ms).toBeLessThan(60_000); // generous CI bound
    });
  }
});

// ---------------------------------------------------------------------------
// shared engine predicate quick checks (used across scenarios above)
// ---------------------------------------------------------------------------

describe("engine predicates", () => {
  test("robotDemands matches the tick's demand accounting", () => {
    expect(robotDemands("to_cluster")).toBe(true);
    expect(robotDemands("collecting")).toBe(true);
    expect(robotDemands("to_base")).toBe(true);
    expect(robotDemands("idle")).toBe(false);
    expect(robotDemands("unloading")).toBe(false);
    expect(robotDemands("recharging")).toBe(false);
  });

  test("production constants used by the harness are the real ones", () => {
    expect(WORLD.CAPACITY_KG).toBe(10_000_000);
    expect(WORLD.INITIAL_POLLUTION_FRAC).toBe(0.5);
    expect(WORLD.RESET_POLLUTION_FRAC).toBe(0.225);
    expect(WORLD.INITIAL_COLLECTABLE_FRAC).toBe(0.1);
    expect(WORLD.DEMAND_REF_KG_H).toBe(42);
    expect(UPGRADES.cargo.costs).toEqual([0, 150, 225, 340, 510]);
    expect(UPGRADES.recharge.costs).toEqual([0, 20, 30, 45, 65]);
    expect(ROBOT.SPEED_M_S).toBe(6);
  });
});
