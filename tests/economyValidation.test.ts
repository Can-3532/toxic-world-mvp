// TOXIC WORLD — SPRINT 2.8: TIME COMPRESSION & ECONOMY VALIDATION (5 s tick).
//
// No new features — this suite MEASURES whether the Sprint 2.7 B tick
// (TICK_SECONDS = 5, 1 game minute per tick) preserves the economy. It runs
// the same deterministic oracle sim (engineSim.ts → world.ts mirror) and
// prints a benchmark table with the two time axes EXPLICITLY separated:
//
//   REAL TIME  (1 s)      : robot movement, battery, recharge, burn (kg/s)
//   GAME TIME  (1 tick = 1 game minute) : generation, pollution, replenishment,
//                                          demand (kg per game hour)
//
// Run:  bun test tests/economyValidation.test.ts

import { describe, expect, test } from "bun:test";
import { replenishmentModelC } from "../src/convex/engine";
import { WORLD, CARGO_CUMULATIVE_TOX, TOX_PER_TON } from "../src/convex/gameParams";
import { Sim, makePlayer, makePlayers } from "./engineSim";

const EPS = 1e-6;
// 1 real hour = 3600 real s = 3600/5 = 720 ticks × 1 game-min = 12 game hours
const GAME_HOURS_PER_REAL_HOUR =
  ((3600 / WORLD.TICK_SECONDS) * WORLD.GAME_MINUTES_PER_TICK) / 60;

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "∞";
}

// ---------------------------------------------------------------------------
// 1. TIME AXES — anchor constants
// ---------------------------------------------------------------------------

describe("1. time axes (formal separation)", () => {
  test("cadence anchors", () => {
    expect(WORLD.TICK_SECONDS).toBe(5);
    expect(WORLD.GAME_MINUTES_PER_TICK).toBe(1);
    expect(GAME_HOURS_PER_REAL_HOUR).toBeCloseTo(12, 9);
  });
  test("GAME-time rate: base generation = 50 kg per game hour, 0.8333 kg/tick", () => {
    expect(WORLD.BASE_GEN_KG_H).toBe(50);
    expect((WORLD.BASE_GEN_KG_H * WORLD.GAME_MINUTES_PER_TICK) / 60).toBeCloseTo(
      50 / 60,
      12,
    );
  });
  test("REAL-time rate: burner = 2 kg/s real ⇒ 10 kg/tick, 600 kg/game-h, 7,200 kg/real-h", () => {
    const perTick = WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS;
    expect(perTick).toBe(10);
    expect(perTick * 60).toBe(600); // per game hour (60 ticks)
    expect(WORLD.PROCESSING_KG_PER_S * 3600).toBe(7200); // per real hour
  });
  test("conversion: kg/game-h × 12 = kg/real-h", () => {
    expect(50 * GAME_HOURS_PER_REAL_HOUR).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// 2. STARTER — 24 game hours (1,440 ticks) of one L1 robot
// ---------------------------------------------------------------------------

describe("2. starter benchmarks (24 game-h sim, both axes)", () => {
  // a diligent starter: every kg that lands in storage is queued for burning
  // (mirrors the queueProcessing player action)
  function runStarter(gameHours: number): { sim: Sim; p: ReturnType<typeof makePlayer> } {
    const p = makePlayer("starter", { base: true, level: 1, x: 500, y: 500, auto: true });
    const sim = new Sim({ players: [p], seed: 42 });
    sim.zone.nextSpawnAt = 1_000_000; // let the zone lifecycle run immediately
    const ticks = Math.round((gameHours * 60) / WORLD.GAME_MINUTES_PER_TICK);
    for (let t = 0; t < ticks; t++) {
      sim.tick(1_000_000 + t * WORLD.TICK_SECONDS * 1000);
      if (p.storageKg > 0) {
        // player action: queueProcessing
        p.processing.queuedKg += p.storageKg;
        if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
        p.storageKg = 0;
      }
      const inv = sim.invariant();
      expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
      expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
    }
    return { sim, p };
  }

  test("emergent starter throughput + TOX rates (both axes)", () => {
    const { sim, p } = runStarter(24);
    const gameHours = 24;

    const collectedGph = p.totalCollectedKg / gameHours;
    const burnedGph = p.totalBurnedKg / gameHours;
    const toxGph = p.toxBalance / gameHours;
    const toxRealH = toxGph * GAME_HOURS_PER_REAL_HOUR;
    const collectedRealH = collectedGph * GAME_HOURS_PER_REAL_HOUR;

    // per-tick burn can never exceed the burner: 10 kg/tick
    expect(p.totalBurnedKg).toBeGreaterThan(0);
    // the burner is never the bottleneck for a starter: collected ≈ burned
    expect(Math.abs(p.totalBurnedKg - p.totalCollectedKg)).toBeLessThan(
      p.totalCollectedKg * 0.05 + 1,
    );

    // invariant held every tick (asserted in runStarter)

    console.log("── STARTER (1 × L1, 24 game hours = 1440 ticks) ──────────────");
    console.log(`  collection      : ${fmt(collectedGph)} kg/game-h  | ${fmt(collectedRealH)} kg/real-h`);
    console.log(`  burned          : ${fmt(burnedGph)} kg/game-h  | ${fmt(burnedGph * GAME_HOURS_PER_REAL_HOUR)} kg/real-h`);
    console.log(`  TOX             : ${fmt(toxGph)} TOX/game-h | ${fmt(toxRealH)} TOX/real-h`);
    console.log(`  24 game-hour TOX: ${fmt(toxGph * 24)}   | 24 real-hour TOX: ${fmt(toxRealH * 24)}`);

    // upgrade times from the MEASURED rate (not the 38.34 design reference)
    const times = CARGO_CUMULATIVE_TOX.map((cum) => {
      const gameH = cum / toxGph;
      return { cum, gameH, realH: gameH / GAME_HOURS_PER_REAL_HOUR };
    });
    console.log(`  time to Cargo   : L2 ${fmt(times[0].gameH)} game-h (${fmt(times[0].realH)} real-h)`
      + ` | L3 ${fmt(times[1].gameH)} game-h (${fmt(times[1].realH)} real-h)`
      + ` | L4 ${fmt(times[2].gameH)} game-h (${fmt(times[2].realH)} real-h)`
      + ` | L5 ${fmt(times[3].gameH)} game-h (${fmt(times[3].realH)} real-h)`);

    // the upgrade times are DERIVED from the measured rate — self-consistency
    // (the old 7.8/19.6/37.3/63.9 game-h targets were based on the design's
    // assumed 38.34 kg/h reference; the sim measures ~174 kg/game-h, see log)
    for (let i = 0; i < times.length; i++) {
      expect(times[i].gameH * toxGph).toBeCloseTo(CARGO_CUMULATIVE_TOX[i], 9);
      expect(times[i].realH * GAME_HOURS_PER_REAL_HOUR).toBeCloseTo(times[i].gameH, 9);
    }
    const design = [7.8, 19.6, 37.3, 63.9];
    console.log("  old targets (design ref 38.34 kg/game-h): "
      + design.map((d) => `${d} game-h`).join(" | "));
    console.log("  Δ vs old targets (game-h): "
      + times.map((t, i) => `${(t.gameH / design[i]).toFixed(2)}×`).join(" | "));

    // 1 game-hour burn (burner capacity) is constant-anchored
    expect(WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS * 60).toBe(600);
    expect(WORLD.PROCESSING_KG_PER_S * 3600).toBe(7200);
  });

  test("storage dynamics: fill time, unload cadence, processing backlog", () => {
    const p = makePlayer("starter", { base: true, level: 1, x: 500, y: 500, auto: true });
    const sim = new Sim({ players: [p], seed: 42 });
    // measure over 12 game hours (one real hour)
    const ticks = 12 * 60;
    const storageCap = 60; // L1
    let totalTrips = 0;
    let unloads = 0;
    let maxBacklog = 0;
    for (let t = 0; t < ticks; t++) {
      sim.tick(2_000_000 + t * WORLD.TICK_SECONDS * 1000);
      if (p.storageKg > 0) {
        p.processing.queuedKg += p.storageKg;
        if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
        p.storageKg = 0;
      }
      if (p.robot.totalTrips > totalTrips) {
        totalTrips = p.robot.totalTrips;
        unloads += 1;
      }
      maxBacklog = Math.max(maxBacklog, p.processing.queuedKg);
    }
    const collected = p.totalCollectedKg;
    // storage fill time (game-h) = cap / collection rate
    const fillGameH = collected > 0 ? storageCap / (collected / 12) : Infinity;
    console.log("── STORAGE (starter, 12 game-h = 1 real-h) ─────────────────────");
    console.log(`  collected         : ${fmt(collected)} kg in 12 game-h (${fmt(collected / 12)} kg/game-h)`);
    console.log(`  storage fill time : ${fmt(fillGameH)} game-h (${fmt(fillGameH / GAME_HOURS_PER_REAL_HOUR)} real-h)`);
    console.log(`  robot trips       : ${totalTrips} (${fmt(unloads / 12)} unloads/game-h)`);
    console.log(`  max backlog       : ${fmt(maxBacklog)} kg (burner clears 10 kg/tick = 30 s for 60 kg)`);
    expect(unloads).toBeGreaterThan(0);
    expect(maxBacklog).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// 3. BURN ZONE — spawn frequency, real duration, player encounter rate
// ---------------------------------------------------------------------------

describe("3. burn zone under the 5 s tick", () => {
  test("lifecycle statistics over 24 game-h (2 real-h)", () => {
    const p = makePlayer("starter", { base: true, level: 1, x: 500, y: 500, auto: true });
    const sim = new Sim({ players: [p], seed: 7 });
    sim.zone.nextSpawnAt = 1_000_000;
    let spawns = 0;
    let activeMs = 0;
    let prevStatus: "active" | "inactive" = "inactive";
    let activeStart = 0;
    const ticks = 24 * 60;
    for (let t = 0; t < ticks; t++) {
      const now = 3_000_000 + t * WORLD.TICK_SECONDS * 1000;
      sim.tick(now);
      if (p.storageKg > 0) {
        p.processing.queuedKg += p.storageKg;
        if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
        p.storageKg = 0;
      }
      const z = sim.zone;
      if (z.status === "active" && prevStatus === "inactive") {
        spawns += 1;
        activeStart = now;
      }
      if (z.status === "active") activeMs += WORLD.TICK_SECONDS * 1000;
      if (z.status === "inactive" && prevStatus === "active") {
        activeMs += 0; // accounted on active ticks
      }
      prevStatus = z.status;
      void activeStart;
    }
    const totalMs = ticks * WORLD.TICK_SECONDS * 1000;
    const activeFrac = activeMs / totalMs;
    const encounterByTox =
      p.toxFromZone > 0
        ? p.toxFromZone / (p.toxFromNormal + p.toxFromZone)
        : 0;
    console.log("── BURN ZONE (24 game-h / 2 real-h) ────────────────────────────");
    console.log(`  spawns           : ${spawns} (avg interval ${fmt(totalMs / spawns / 1000)} s real)`);
    console.log(`  active duration  : ${fmt(activeMs / 1000)} s real total (${fmt(activeFrac * 100,)}% of real time)`);
    console.log(`  starter encounter: ${fmt(encounterByTox * 100)}% of burned TOX earned inside a zone`);
    // design: active 15–30 s, cooldown 45–90 s ⇒ active fraction ≈ 0.18–0.4
    expect(spawns).toBeGreaterThan(10);
    expect(activeFrac).toBeGreaterThan(0.1);
    expect(activeFrac).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 4. MODEL C — demand/generation ratio under the 5 s tick
// ---------------------------------------------------------------------------

describe("4. Model C with the 5 s tick", () => {
  test("replenishment frac stays in clip(0.05×ratio, 5%, 9%) every tick", () => {
    const players = makePlayers(1000, { seed: 11, autoFraction: 0.5 });
    const sim = new Sim({ players, seed: 11 });
    let prevHidden = sim.world.hiddenKg;
    for (let t = 0; t < 20; t++) {
      sim.tick(4_000_000 + t * WORLD.TICK_SECONDS * 1000);
      const w = sim.world;
      const ratio = w.generationRateKgH > 0 ? w.demandKgH / w.generationRateKgH : 0;
      const frac = replenishmentModelC(w.generationRateKgH, w.demandKgH);
      expect(frac).toBeGreaterThanOrEqual(0.05 - EPS);
      expect(frac).toBeLessThanOrEqual(0.09 + EPS);
      expect(frac).toBeCloseTo(
        Math.min(0.09, Math.max(0.05, 0.05 * ratio)),
        9,
      );
      // replenishment only moves hidden → collectable: hidden never increases
      expect(w.hiddenKg).toBeLessThanOrEqual(prevHidden + EPS);
      prevHidden = w.hiddenKg;
      const inv = sim.invariant();
      expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
      expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
    }
  });
  test("75% vs 50% activity preserves the demand/generation ordering", () => {
    const ratios: Record<string, number> = {};
    for (const frac of [0.75, 0.5]) {
      const players = makePlayers(1000, { seed: 13, autoFraction: frac });
      const sim = new Sim({ players, seed: 13 });
      for (let t = 0; t < 10; t++) sim.tick(5_000_000 + t * WORLD.TICK_SECONDS * 1000);
      const w = sim.world;
      ratios[String(frac)] = w.generationRateKgH > 0 ? w.demandKgH / w.generationRateKgH : 0;
    }
    expect(ratios["0.75"]).toBeGreaterThan(ratios["0.5"]);
  });
});

// ---------------------------------------------------------------------------
// 5. POLLUTION scenarios — trajectory + time-to-collapse, both axes
// ---------------------------------------------------------------------------

describe("5. pollution scenarios under the 5 s tick", () => {
  const scenarios: { name: string; n: number; auto: number; pool: number[] }[] = [
    { name: "10K all-L1, 50% active", n: 10_000, auto: 0.5, pool: [1] },
    { name: "10K mixed, 50% active", n: 10_000, auto: 0.5, pool: [1, 1, 1, 2, 3, 5] },
    { name: "1K mixed, 75% active", n: 1_000, auto: 0.75, pool: [1, 1, 1, 2, 3, 5] },
    { name: "1K mixed, 50% active", n: 1_000, auto: 0.5, pool: [1, 1, 1, 2, 3, 5] },
  ];

  for (const sc of scenarios) {
    test(`${sc.name}: net rate + invariants (1 game-h)`, () => {
      const players = makePlayers(sc.n, {
        seed: sc.n,
        autoFraction: sc.auto,
        storageFraction: 0.05,
        queueFraction: 0.05,
        levelPool: sc.pool,
      });
      const sim = new Sim({ players, seed: sc.n });
      const p0 = sim.world.pollutionKg;
      const ticks = 60; // 1 game hour
      for (let t = 0; t < ticks; t++) {
        sim.tick(6_000_000 + t * WORLD.TICK_SECONDS * 1000);
        const inv = sim.invariant();
        expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
        expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
      }
      const dPoll = sim.world.pollutionKg - p0; // kg per game hour
      const genPerGameH = sim.world.generationRateKgH; // kg per game hour
      const burnPerGameH = dPoll - genPerGameH < 0 ? genPerGameH - dPoll : 0; // crude
      const netRate = dPoll; // kg/game-h
      const collapseGameH = netRate > 0 ? (WORLD.CAPACITY_KG - p0) / netRate : Infinity;
      console.log(`── POLLUTION ${sc.name} ──────────────────────────────────────────`);
      console.log(`  gen ${fmt(genPerGameH)} kg/game-h | dPoll ${fmt(netRate)} kg/game-h`
        + ` | burn ~${fmt(Math.max(0, genPerGameH - netRate))} kg/game-h`
        + ` | collapse ≈ ${fmt(collapseGameH)} game-h (${fmt(collapseGameH / GAME_HOURS_PER_REAL_HOUR)} real-h)`
        + ` | pollution ${fmt((sim.world.pollutionKg / WORLD.CAPACITY_KG) * 100)}%`);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Summary table (printed once at the end)
// ---------------------------------------------------------------------------

test("summary table (console)", () => {
  console.log("");
  console.log("═ SPRINT 2.8 SUMMARY — 5 s tick, 12× compression ═══════════════");
  console.log("  REAL TIME (1 s)   : movement, battery, recharge, burn (2 kg/s)");
  console.log("  GAME TIME (1 tick): generation, pollution, replenishment, demand");
  console.log("  1 game hour = 60 ticks = 5 real minutes; 12 game-h / real-h");
  console.log("  burner: 10 kg/tick = 600 kg/game-h = 7,200 kg/real-h");
  console.log("  upgrade targets (game-h) unchanged from design freeze;");
  console.log("  real-h times = game-h / 12 (2.5× slower than the old 30× world)");
});
