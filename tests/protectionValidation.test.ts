// TOXIC WORLD — SPRINT 2.11: PROTECTION SYSTEMS (Lock / AFK / Shield / Launch)
//
// Design: TOXIC_WORLD_PROTECTION_SYSTEMS_v0.1.md. Validates the production
// rules on the SAME pure functions the tick/mutations call (protection.ts)
// AND through the deterministic oracle (tests/engineSim.ts → world.ts mirror)
// so the headless tests exercise the real production logic, not a copy.
//
// Run:  bun test tests/protectionValidation.test.ts

import { describe, expect, test } from "bun:test";
import { PROTECTION, ROBOT, WORLD } from "../src/convex/gameParams";
import {
  afkDue,
  applyIdleCheck,
  collapseSeed,
  drainMultiplier,
  isSealed,
  keepsHeldOnCollapse,
  launchDue,
  onActivity,
  onWorldCollapse,
  proportionalPreserve,
  shieldActive,
} from "../src/convex/protection";
import { Sim, makePlayer, makeCluster, type SimPlayer } from "./engineSim";

const EPS = 1e-6;
const AFK_MS = PROTECTION.AFK_AFTER_MS;
const NOW = 10_000;

function sealedPlayer(opts: { state: "locked" | "launching" }): SimPlayer {
  return makePlayer("s", {
    base: true,
    protection:
      opts.state === "locked"
        ? { state: "locked", lockedAt: 1_000, lockReason: "voluntary" }
        : { state: "launching", lockedAt: 1_000, lockReason: "collapse", launchAt: NOW + 60_000 },
  });
}

// ---------------------------------------------------------------------------
// 0. frozen constants (cost/duration pins)
// ---------------------------------------------------------------------------

describe("0. protection constants (frozen v0.1 placeholders)", () => {
  test("values pinned", () => {
    expect(PROTECTION.AFK_AFTER_MS).toBe(12 * 3_600_000);
    expect(PROTECTION.UNLOCK_COST_TOX).toBe(200);
    expect(PROTECTION.SHIELD_COST_TOX).toBe(150);
    expect(PROTECTION.SHIELD_DURATION_MS).toBe(2 * 3_600_000);
    expect(PROTECTION.CRITICAL_DRAIN_MULT).toBe(2);
    expect(PROTECTION.LAUNCH_FEE_TOX).toBe(300);
    expect(PROTECTION.LAUNCH_WINDOW_MS).toBe(5 * 60_000);
    expect(PROTECTION.TREASURY_BURN_FRAC).toBe(0.15);
    expect(PROTECTION.TREASURY_SEED_TOX).toBe(1_000_000);
  });
  test("sealed = locked | launching", () => {
    expect(isSealed("normal")).toBe(false);
    expect(isSealed("afk")).toBe(false);
    expect(isSealed("locked")).toBe(true);
    expect(isSealed("launching")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. pure rules — AFK detection
// ---------------------------------------------------------------------------

describe("1. AFK (12 real hours)", () => {
  test("afkDue boundary", () => {
    expect(afkDue(NOW - AFK_MS, NOW)).toBe(true); // exactly at threshold
    expect(afkDue(NOW - AFK_MS - 1, NOW)).toBe(true);
    expect(afkDue(NOW - AFK_MS + 1, NOW)).toBe(false);
  });
  test("applyIdleCheck: normal + idle → afk; otherwise unchanged", () => {
    expect(applyIdleCheck({ state: "normal" }, NOW - AFK_MS, NOW).state).toBe("afk");
    expect(applyIdleCheck({ state: "normal" }, NOW, NOW).state).toBe("normal");
    expect(applyIdleCheck({ state: "afk" }, NOW - AFK_MS, NOW).state).toBe("afk");
    expect(applyIdleCheck({ state: "locked" }, NOW - AFK_MS, NOW).state).toBe("locked");
  });
  test("onActivity: any action ends AFK", () => {
    expect(onActivity({ state: "afk" }).state).toBe("normal");
    expect(onActivity({ state: "normal" }).state).toBe("normal");
    // does NOT unseal a locked/launching base
    expect(onActivity({ state: "locked" }).state).toBe("locked");
    expect(onActivity({ state: "launching" }).state).toBe("launching");
  });
  test("sim: idle player flips to afk on the next tick, generation continues", () => {
    const p = makePlayer("a", { base: true, lastActiveAt: NOW - AFK_MS - 1 });
    const sim = new Sim({ players: [p], seed: 31 });
    sim.tick(NOW);
    expect(p.protection.state).toBe("afk");
    // AFK bases stay on autopilot: they keep generating (Sprint 2.9 model)
    expect(sim.world.generationRateKgH).toBe(WORLD.BASE_GEN_KG_H);
    const inv = sim.invariant();
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
});

// ---------------------------------------------------------------------------
// 2. pure rules — Toxic Shield
// ---------------------------------------------------------------------------

describe("2. toxic shield (critical-state drain)", () => {
  test("shieldActive", () => {
    expect(shieldActive(undefined, NOW)).toBe(false);
    expect(shieldActive(NOW + 1, NOW)).toBe(true);
    expect(shieldActive(NOW - 1, NOW)).toBe(false);
  });
  test("drainMultiplier: safe world → 1 always", () => {
    expect(drainMultiplier({ state: "normal" }, NOW, false)).toBe(1);
    expect(drainMultiplier({ state: "afk" }, NOW, false)).toBe(1);
    expect(drainMultiplier({ state: "locked" }, NOW, false)).toBe(1);
  });
  test("drainMultiplier: critical → unshielded ×2, shielded ×1, sealed ×1", () => {
    expect(drainMultiplier({ state: "normal" }, NOW, true)).toBe(
      PROTECTION.CRITICAL_DRAIN_MULT,
    );
    expect(drainMultiplier({ state: "afk" }, NOW, true)).toBe(
      PROTECTION.CRITICAL_DRAIN_MULT,
    );
    expect(
      drainMultiplier({ state: "normal", shieldUntil: NOW + 1000 }, NOW, true),
    ).toBe(1);
    expect(drainMultiplier({ state: "locked" }, NOW, true)).toBe(1);
    expect(drainMultiplier({ state: "launching" }, NOW, true)).toBe(1);
    // expired shield → unprotected again
    expect(
      drainMultiplier({ state: "normal", shieldUntil: NOW - 1 }, NOW, true),
    ).toBe(PROTECTION.CRITICAL_DRAIN_MULT);
  });
  test("sim: unshielded robot drains 2× mid-trip in critical, shielded drains 1×", () => {
    const run = (shielded: boolean, frac: number) => {
      const pollution = WORLD.CAPACITY_KG * frac;
      const p = makePlayer("p1", {
        base: true,
        x: 100,
        y: 500,
        lastActiveAt: NOW,
        protection: shielded ? { shieldUntil: NOW + 3_600_000 } : undefined,
      });
      const sim = new Sim({
        players: [p],
        seed: 11,
        world: {
          pollutionKg: pollution,
          collectableKg: pollution * WORLD.INITIAL_COLLECTABLE_FRAC,
          hiddenKg: pollution * (1 - WORLD.INITIAL_COLLECTABLE_FRAC),
          seedPollutionKg: pollution,
        },
        clusters: [makeCluster("c1", 700, 500, 500)],
      });
      // manual command (mirrors commandRobot)
      sim.clusters[0].reservedBy = p.id;
      p.robot.state = "to_cluster";
      p.robot.targetClusterId = "c1";
      p.robot.fromX = p.robot.x;
      p.robot.fromY = p.robot.y;
      p.robot.departAt = NOW;
      p.robot.arriveAt = NOW + (600 / ROBOT.SPEED_M_S) * 1000;
      const before = p.robot.battery;
      sim.tick(NOW);
      return { drop: before - p.robot.battery, sim, p };
    };

    const safeUnshielded = run(false, 0.5); // safe world → drain ×1
    const criticalUnshielded = run(false, 0.902);
    const criticalShielded = run(true, 0.902);
    const base = ROBOT.DRAIN_MOVING * WORLD.TICK_SECONDS;
    expect(safeUnshielded.drop).toBeCloseTo(base, 6);
    expect(criticalUnshielded.drop).toBeCloseTo(base * PROTECTION.CRITICAL_DRAIN_MULT, 6);
    expect(criticalShielded.drop).toBeCloseTo(base, 6);
    // shield does NOT stop the world from collapsing (personal protection only)
    for (const r of [safeUnshielded, criticalUnshielded, criticalShielded]) {
      const inv = r.sim.invariant();
      expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
      expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. pure rules — collapse fate + mass accounting
// ---------------------------------------------------------------------------

describe("3. world collapse — fate + carried-mass accounting", () => {
  test("onWorldCollapse: afk auto-locks, others unchanged", () => {
    const now = NOW;
    expect(onWorldCollapse({ state: "afk" }, now)).toEqual({
      state: "locked",
      lockedAt: now,
      lockReason: "collapse",
    });
    expect(onWorldCollapse({ state: "normal" }, now).state).toBe("normal");
    expect(onWorldCollapse({ state: "locked" }, now).state).toBe("locked");
    expect(onWorldCollapse({ state: "launching" }, now).state).toBe("launching");
  });
  test("keepsHeldOnCollapse: sealed keeps, normal wiped", () => {
    expect(keepsHeldOnCollapse("normal")).toBe(false);
    expect(keepsHeldOnCollapse("afk")).toBe(false); // afk → locked first
    expect(keepsHeldOnCollapse("locked")).toBe(true);
    expect(keepsHeldOnCollapse("launching")).toBe(true);
  });
  test("collapseSeed: preserved holdings come out of the recoverable pool", () => {
    const s0 = collapseSeed(WORLD.CAPACITY_KG, 0);
    expect(s0.pollutionKg).toBeCloseTo(
      WORLD.CAPACITY_KG * WORLD.RESET_POLLUTION_FRAC,
      6,
    );
    expect(s0.hiddenKg).toBeCloseTo(s0.pollutionKg * 0.9, 6);
    expect(s0.collectableKg).toBeCloseTo(s0.pollutionKg * 0.1, 6);
    expect(s0.preservedKg).toBe(0);

    const s1 = collapseSeed(WORLD.CAPACITY_KG, 1_000);
    expect(s1.preservedKg).toBe(1_000);
    expect(s1.hiddenKg + s1.collectableKg).toBeCloseTo(s0.pollutionKg - 1_000, 6);
  });
  test("collapseSeed caps preserved at the seed (pathological 10k case)", () => {
    const big = collapseSeed(WORLD.CAPACITY_KG, WORLD.CAPACITY_KG * 2);
    expect(big.preservedKg).toBeCloseTo(big.pollutionKg, 6);
  });
  test("proportionalPreserve: scale 1 normally, proportional when over-cap", () => {
    const held = { storage: 50, cargo: 30, processing: 20 };
    expect(proportionalPreserve(1_000, 1_000, held)).toEqual(held);
    const s = proportionalPreserve(2_000, 1_000, held);
    expect(s.storage).toBe(25);
    expect(s.cargo).toBe(15);
    expect(s.processing).toBe(10);
    expect(proportionalPreserve(0, 0, held)).toEqual(held); // nothing carried
  });
});

// ---------------------------------------------------------------------------
// 4. sim — locked base behavior (generation off, robot parked, queue burns)
// ---------------------------------------------------------------------------

describe("4. locked base (sim)", () => {
  test("generation stops for sealed bases only", () => {
    const locked = sealedPlayer({ state: "locked" });
    const normal = makePlayer("n", { base: true });
    const sim = new Sim({ players: [locked, normal], seed: 23 });
    sim.tick(NOW);
    // 1 of 2 bases generates → 50 kg/h
    expect(sim.world.generationRateKgH).toBe(WORLD.BASE_GEN_KG_H);
  });
  test("sealed robots never appear in batch allocation (no new reservations)", () => {
    const locked = sealedPlayer({ state: "locked" });
    const sim = new Sim({
      players: [locked],
      seed: 19,
      clusters: [makeCluster("c1", 100, 100, 500)],
    });
    sim.tick(NOW);
    expect(sim.lastAssignments.size).toBe(0);
    expect(locked.robot.state).toBe("idle");
    expect(locked.robot.cargoKg).toBe(0);
  });
  test("existing burn queue CONTINUES while sealed (anti-deadlock)", () => {
    const locked = sealedPlayer({ state: "locked" });
    locked.processing = { queuedKg: 50, since: 0, sessionId: "s", sliceIndex: 0 };
    const sim = new Sim({ players: [locked], seed: 29 });
    sim.tick(NOW);
    const burnPerTick = WORLD.PROCESSING_KG_PER_S * WORLD.TICK_SECONDS;
    expect(locked.processing.queuedKg).toBeCloseTo(50 - burnPerTick, 6);
    expect(locked.toxBalance).toBeCloseTo(burnPerTick * 0.5, 6);
    const inv = sim.invariant();
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
  test("launching behaves like locked until the countdown ends", () => {
    const launching = sealedPlayer({ state: "launching" });
    launching.storageKg = 30;
    const sim = new Sim({ players: [launching], seed: 37 });
    sim.tick(NOW);
    expect(launching.protection.state).toBe("launching");
    expect(launching.storageKg).toBe(30); // stockpile preserved
    expect(sim.world.generationRateKgH).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. sim — collapse with mixed states (keep/wipe + exact invariants)
// ---------------------------------------------------------------------------

describe("5. protection-aware collapse (sim)", () => {
  test("normal wiped · locked kept · afk auto-locked+kept; invariants exact", () => {
    const pollution = WORLD.CAPACITY_KG - 0.5; // 1 tick of generation crosses 100%
    const normal = makePlayer("n", { base: true, storageKg: 40, tox: 10 });
    const locked = makePlayer("l", {
      base: true,
      storageKg: 50,
      tox: 100,
      protection: { state: "locked", lockedAt: 1_000, lockReason: "voluntary" },
    });
    const afk = makePlayer("a", {
      base: true,
      storageKg: 60,
      tox: 5,
      lastActiveAt: NOW - AFK_MS - 1, // tick flips normal → afk → locked
    });
    const sim = new Sim({
      players: [normal, locked, afk],
      seed: 13,
      world: {
        pollutionKg: pollution,
        collectableKg: pollution * WORLD.INITIAL_COLLECTABLE_FRAC,
        hiddenKg: pollution * (1 - WORLD.INITIAL_COLLECTABLE_FRAC),
        seedPollutionKg: pollution,
      },
    });
    sim.tick(NOW);

    expect(sim.world.worldId).toBe(1);
    expect(sim.world.pollutionKg / sim.world.capacityKg).toBeCloseTo(
      WORLD.RESET_POLLUTION_FRAC,
      9,
    );
    // normal base: wiped (v0.4 behavior)
    expect(normal.storageKg).toBe(0);
    expect(normal.protection.state).toBe("normal");
    // locked base: stockpile preserved
    expect(locked.storageKg).toBe(50);
    expect(locked.protection.state).toBe("locked");
    // afk base: auto-locked at collapse, stockpile preserved
    expect(afk.protection.state).toBe("locked");
    expect(afk.protection.lockReason).toBe("collapse");
    expect(afk.storageKg).toBe(60);
    // carried (50 + 60) came out of the recoverable seed — Layer 2 exact
    const inv = sim.invariant();
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
});

// ---------------------------------------------------------------------------
// 6. sim — Emergency Launch completion (Base −1, Robot −1, treasury −15%)
// ---------------------------------------------------------------------------

describe("6. emergency launch (sim)", () => {
  test("countdown completion destroys the base and charges fee + treasury", () => {
    const p = makePlayer("p1", {
      base: true,
      tox: 500,
      sol: 0,
      storageKg: 30,
      protection: {
        state: "launching",
        lockedAt: 1_000,
        lockReason: "collapse",
        launchAt: NOW - 1, // countdown already finished
      },
    });
    const sim = new Sim({ players: [p], seed: 17 });
    sim.tick(NOW);

    expect(p.hasBase).toBe(false);
    expect(p.toxBalance).toBeCloseTo(500 - PROTECTION.LAUNCH_FEE_TOX, 6);
    expect(p.solBalance).toBeCloseTo(WORLD.BASE_PRICE_SOL, 6); // mock re-entry
    expect(p.storageKg).toBe(0);
    expect(p.robot.cargoKg).toBe(0);
    expect(p.robot.auto).toBe(true);
    expect(p.robot.state).toBe("idle");
    expect(p.protection.state).toBe("normal");
    // treasury −15% (mock)
    expect(sim.world.treasuryTox).toBeCloseTo(
      PROTECTION.TREASURY_SEED_TOX * (1 - PROTECTION.TREASURY_BURN_FRAC),
      6,
    );
    // abandoned stockpile returned to the collectable pool → invariants exact
    const inv = sim.invariant();
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  });
  test("cancel before the deadline: nothing is charged", () => {
    const p = makePlayer("p1", {
      base: true,
      tox: 500,
      sol: 0.1,
      protection: {
        state: "launching",
        lockedAt: 1_000,
        lockReason: "voluntary",
        launchAt: NOW + 60_000, // still counting down
      },
    });
    const sim = new Sim({ players: [p], seed: 41 });
    sim.tick(NOW);
    expect(p.hasBase).toBe(true);
    expect(p.toxBalance).toBe(500);
    expect(sim.world.treasuryTox).toBe(PROTECTION.TREASURY_SEED_TOX);
    expect(p.protection.state).toBe("launching");
  });
});

// ---------------------------------------------------------------------------
// 7. launchDue boundary
// ---------------------------------------------------------------------------

describe("7. launchDue", () => {
  test("undefined / future / past", () => {
    expect(launchDue(undefined, NOW)).toBe(false);
    expect(launchDue(NOW + 1, NOW)).toBe(false);
    expect(launchDue(NOW, NOW)).toBe(true);
    expect(launchDue(NOW - 1, NOW)).toBe(true);
  });
});
