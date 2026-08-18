// TOXIC WORLD — SPRINT 2.11 PROTECTION SYSTEMS VALIDATION.
// Runs the REAL production protection module (src/convex/protection.ts) and
// drives the deterministic oracle (tests/engineSim.ts, which mirrors world.ts
// step-for-step) through the protection-aware collapse matrix and Emergency
// Launch completion. Design: TOXIC_WORLD_PROTECTION_SYSTEMS_v0.1.md.
//
// Run:  bun test tests/protectionValidation.test.ts

import { describe, expect, test } from "bun:test";
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
  protectionDefaults,
  shieldActive,
  type Protection,
} from "../src/convex/protection";
import { PROTECTION, WORLD } from "../src/convex/gameParams";
import { freshWorld, makePlayer, simTick } from "./engineSim";

const H = 3_600_000;

// ---------------------------------------------------------------------------
// 1. State machine — pure function unit tests
// ---------------------------------------------------------------------------

describe("protection state machine (protection.ts)", () => {
  test("fresh players start NORMAL", () => {
    expect(protectionDefaults().state).toBe("normal");
  });

  test("AFK threshold is 12 real hours, inclusive", () => {
    const now = 1_000_000;
    expect(afkDue(now - PROTECTION.AFK_AFTER_MS, now)).toBe(true); // exactly 12h
    expect(afkDue(now - PROTECTION.AFK_AFTER_MS - 1, now)).toBe(true);
    expect(afkDue(now - PROTECTION.AFK_AFTER_MS + 1, now)).toBe(false);
    expect(afkDue(now, now)).toBe(false);
  });

  test("tick idle check: NORMAL crossing 12 h idle → AFK; AFK stays AFK", () => {
    const now = 100_000;
    const idle = { state: "normal" } as Protection;
    expect(applyIdleCheck(idle, now - PROTECTION.AFK_AFTER_MS, now).state).toBe("afk");
    const afk = { state: "afk" } as Protection;
    // no auto-revert — the tick never silently un-AFKs
    expect(applyIdleCheck(afk, now, now).state).toBe("afk");
  });

  test("any player action ends AFK (onActivity), NORMAL stays NORMAL", () => {
    expect(onActivity({ state: "afk" } as Protection).state).toBe("normal");
    expect(onActivity({ state: "normal" } as Protection).state).toBe("normal");
    // sealed states are NOT un-sealed by activity — that needs unlockBase
    expect(onActivity({ state: "locked" } as Protection).state).toBe("locked");
    expect(onActivity({ state: "launching" } as Protection).state).toBe("launching");
  });

  test("sealed = locked | launching", () => {
    expect(isSealed("normal")).toBe(false);
    expect(isSealed("afk")).toBe(false);
    expect(isSealed("locked")).toBe(true);
    expect(isSealed("launching")).toBe(true);
  });

  test("Toxic Shield: buff window + refresh semantics", () => {
    const now = 100_000;
    expect(shieldActive(now + 1000, now)).toBe(true);
    expect(shieldActive(now - 1, now)).toBe(false);
    expect(shieldActive(undefined, now)).toBe(false);
  });

  test("drain multiplier matrix (doc §2.5)", () => {
    const now = 100_000;
    const shielded = { state: "normal", shieldUntil: now + H } as Protection;
    const plain = { state: "normal" } as Protection;
    const sealed = { state: "locked" } as Protection;
    // safe world → always 1
    expect(drainMultiplier(shielded, now, false)).toBe(1);
    expect(drainMultiplier(plain, now, false)).toBe(1);
    expect(drainMultiplier(sealed, now, false)).toBe(1);
    // critical world → unshielded ×2, shielded ×1, sealed ×1
    expect(drainMultiplier(plain, now, true)).toBe(PROTECTION.CRITICAL_DRAIN_MULT);
    expect(drainMultiplier(shielded, now, true)).toBe(1);
    expect(drainMultiplier(sealed, now, true)).toBe(1);
    // expired shield does NOT protect
    expect(
      drainMultiplier({ state: "normal", shieldUntil: now - 1 } as Protection, now, true),
    ).toBe(PROTECTION.CRITICAL_DRAIN_MULT);
  });

  test("onWorldCollapse: afk → locked(collapse); others unchanged", () => {
    const now = 100_000;
    const afk = onWorldCollapse({ state: "afk" } as Protection, now);
    expect(afk.state).toBe("locked");
    expect(afk.lockReason).toBe("collapse");
    expect(afk.lockedAt).toBe(now);
    for (const s of ["normal", "locked", "launching"] as const) {
      const r = onWorldCollapse({ state: s } as Protection, now);
      expect(r.state).toBe(s);
    }
  });

  test("keepsHeldOnCollapse: sealed states keep their stockpile (post-collapse state)", () => {
    // NOTE: mirror world.ts ordering — afk is converted to locked by
    // onWorldCollapse BEFORE the keep check, so the effective keep set is
    // exactly { locked, launching }.
    expect(keepsHeldOnCollapse(keepsHeldOnCollapse("afk") ? "afk" : "afk")).toBe(false);
    expect(keepsHeldOnCollapse(onWorldCollapse({ state: "afk" } as Protection, 0).state)).toBe(true);
    expect(keepsHeldOnCollapse("locked")).toBe(true);
    expect(keepsHeldOnCollapse("launching")).toBe(true);
    expect(keepsHeldOnCollapse("normal")).toBe(false);
  });

  test("launchDue: 5 real-minute countdown", () => {
    const now = 100_000;
    // launchAt is the COMPLETION timestamp (game.ts sets now + WINDOW); due
    // means the current time has reached it.
    expect(launchDue(now + PROTECTION.LAUNCH_WINDOW_MS - 1, now)).toBe(false); // countdown running
    expect(launchDue(now, now)).toBe(true); // exactly due
    expect(launchDue(now - 1, now)).toBe(true); // overdue
    expect(launchDue(undefined, now)).toBe(false);
  });

  test("unlock / shield / launch fees are the frozen [PLAYTEST] constants", () => {
    expect(PROTECTION.AFK_AFTER_MS).toBe(12 * H);
    expect(PROTECTION.UNLOCK_COST_TOX).toBe(200);
    expect(PROTECTION.SHIELD_COST_TOX).toBe(150);
    expect(PROTECTION.SHIELD_DURATION_MS).toBe(2 * H);
    expect(PROTECTION.CRITICAL_DRAIN_MULT).toBe(2);
    expect(PROTECTION.LAUNCH_FEE_TOX).toBe(300);
    expect(PROTECTION.LAUNCH_WINDOW_MS).toBe(5 * 60_000);
    expect(PROTECTION.TREASURY_BURN_FRAC).toBe(0.15);
    expect(PROTECTION.TREASURY_SEED_TOX).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Collapse mass accounting (doc §3) — pure functions
// ---------------------------------------------------------------------------

describe("collapse mass accounting (collapseSeed / proportionalPreserve)", () => {
  const P0 = WORLD.CAPACITY_KG * WORLD.RESET_POLLUTION_FRAC; // 2,250,000 kg

  test("preserved holdings are carved out of the new world's seed", () => {
    const s = collapseSeed(WORLD.CAPACITY_KG, 500);
    expect(s.pollutionKg).toBe(P0);
    expect(s.preservedKg).toBe(500);
    const recoverable = P0 - 500;
    expect(s.hiddenKg).toBeCloseTo(recoverable * (1 - WORLD.INITIAL_COLLECTABLE_FRAC), 6);
    expect(s.collectableKg).toBeCloseTo(recoverable * WORLD.INITIAL_COLLECTABLE_FRAC, 6);
    // Layer 2 exact: hidden + collectable + preserved == P0
    expect(s.hiddenKg + s.collectableKg + s.preservedKg).toBeCloseTo(P0, 6);
  });

  test("pathological case: carried > seed → capped at P0, zero recoverable", () => {
    const s = collapseSeed(WORLD.CAPACITY_KG, P0 + 999_999);
    expect(s.preservedKg).toBe(P0);
    expect(s.hiddenKg).toBe(0);
    expect(s.collectableKg).toBe(0);
  });

  test("proportionalPreserve scales held mass to the cap when carried > P0", () => {
    const scaled = proportionalPreserve(1000, 500, {
      storage: 300,
      cargo: 200,
      processing: 500,
    });
    expect(scaled.storage).toBeCloseTo(150, 6);
    expect(scaled.cargo).toBeCloseTo(100, 6);
    expect(scaled.processing).toBeCloseTo(250, 6);
    // carried ≤ preserved → scale == 1 (identity in every normal case)
    const id = proportionalPreserve(100, 200, { storage: 30, cargo: 20, processing: 50 });
    expect(id).toEqual({ storage: 30, cargo: 20, processing: 50 });
    // zero carried → no change
    const zero = proportionalPreserve(0, 500, { storage: 30, cargo: 0, processing: 0 });
    expect(zero).toEqual({ storage: 30, cargo: 0, processing: 0 });
  });
});

// ---------------------------------------------------------------------------
// 3. Whole-world protection scenarios (deterministic oracle)
// ---------------------------------------------------------------------------

describe("protection in the world tick (oracle mirrors world.ts)", () => {
  /** drive the world until it collapses; returns the post-collapse state */
  function untilCollapse(s: ReturnType<typeof freshWorld>, maxTicks = 200) {
    let now = s.world.lastTick;
    for (let i = 0; i < maxTicks; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
      if (s.world.worldId > 0) return s;
    }
    throw new Error("world never collapsed within the tick budget");
  }

  test("collapse matrix (doc §3): normal wiped, afk/locked/launching preserved", () => {
    const mk = (
      id: string,
      state: Protection["state"],
      lastActiveAt: number,
      lockedAt?: number,
    ) =>
      makePlayer(id, {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 500, // held mass — the whole point of the matrix
        lastActiveAt,
        protection:
          state === "normal"
            ? { state }
            : state === "afk"
              ? { state }
              : state === "locked"
                ? { state, lockedAt: lockedAt ?? 0, lockReason: "voluntary" }
                : { state, launchAt: undefined },
        auto: false, // keep holdings frozen — we assert preservation, not movement
      }, 0);

    const cases: {
      name: string;
      state: Protection["state"];
      stale: boolean;
      expectedState: Protection["state"];
      keeps: boolean;
      reason?: "collapse";
    }[] = [
      { name: "normal", state: "normal", stale: false, expectedState: "normal", keeps: false },
      { name: "afk (12h idle)", state: "normal", stale: true, expectedState: "locked", keeps: true, reason: "collapse" },
      { name: "locked (voluntary)", state: "locked", stale: false, expectedState: "locked", keeps: true },
      { name: "launching", state: "launching", stale: false, expectedState: "launching", keeps: true },
    ];

    for (const c of cases) {
      const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
      // sim-relative clock: the sim's ticks start at 0, so "idle 12h+" is a
      // NEGATIVE lastActiveAt (Date.now()-based timestamps would read as
      // future activity and the base would never go AFK).
      const lastActiveAt = c.stale ? -(PROTECTION.AFK_AFTER_MS + 1) : 0;
      s.players.push(mk("p1", c.state, lastActiveAt));
      // a world whose ONLY base is sealed can never collapse (sealed bases
      // generate nothing, doc §2.3) — add a normal generating "drone" base so
      // pollution is driven to 100% while the protected player rides along.
      s.players.push(mk("drone", "normal", 0));
      const after = untilCollapse(s);
      const p = after.players[0];
      expect(p.protection.state, c.name).toBe(c.expectedState);
      expect(p.storageKg, c.name).toBe(c.keeps ? 500 : 0);
      if (c.reason) expect(p.protection.lockReason).toBe("collapse");
      // world reset to World 1 with the two-layer invariant EXACT
      expect(after.world.worldId).toBe(1);
      const r = simTick(after, after.world.lastTick + WORLD.TICK_SECONDS * 1000, false);
      expect(Math.abs(r.invariantMass)).toBeLessThan(1e-6);
      expect(Math.abs(r.invariantPool)).toBeLessThan(1e-6);
    }
  });

  test("AFK bases keep generating (autopilot) — locked bases stop", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 200,
        baseY: 200,
        protection: { state: "locked", lockedAt: 0, lockReason: "voluntary" },
        auto: false,
      }, 0),
      makePlayer("afk", {
        hasBase: true,
        baseX: 800,
        baseY: 800,
        lastActiveAt: -PROTECTION.AFK_AFTER_MS,
        auto: false,
      }, 0),
      makePlayer("normal", { hasBase: true, baseX: 500, baseY: 500, auto: false }, 0),
    );
    const before = s.world.pollutionKg;
    const r = runTicks(s, 60); // 1 game hour
    expect(r.state.world.generationRateKgH).toBeCloseTo(100, 6); // afk + normal only
    expect(r.state.world.pollutionKg).toBeCloseTo(before + 100, 3);
    // the locked player never contributes generation
    expect(r.state.players[0].protection.state).toBe("locked");
  });

  test("locked bases KEEP burning their existing queue (anti-deadlock, doc §2.3)", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      toxBalance: 0,
      protection: { state: "locked", lockedAt: 0, lockReason: "voluntary" },
      processing: { queuedKg: 1000, since: 0, sessionId: "p1:q", sliceIndex: 0 },
      auto: false,
    }, 0);
    s.players.push(p);
    // the seeded queue (1000 kg) is real pool mass — debit it from the
    // collectable pool so Layer 2 starts exact (mirrors harness:seedLoad).
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 1000);
    const pollutionBefore = s.world.pollutionKg;
    const r = runTicks(s, 10); // 50 real seconds → 100 kg burned
    const q = r.state.players[0];
    expect(q.processing.queuedKg).toBe(1000 - 100);
    expect(q.toxBalance).toBeCloseTo(50, 6); // 100 kg → 50 TOX, earnable while sealed
    expect(r.state.world.pollutionKg).toBeCloseTo(pollutionBefore - 100 + 0, 3);
    expect(Math.abs(r.pool)).toBeLessThan(1e-6);
  });

  test("Emergency Launch completes: base −1, robot −1, fee, treasury −15%, spill", () => {
    const s = freshWorld();
    const now = 0;
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      storageKg: 100,
      toxBalance: 1000,
      solBalance: 0,
      protection: {
        state: "launching",
        lockedAt: 0,
        lockReason: "voluntary",
        launchAt: now + PROTECTION.LAUNCH_WINDOW_MS,
      },
      auto: false,
    }, now);
    s.players.push(p);
    // the seeded storage (100 kg) is real pool mass — debit it from the
    // collectable pool (mirrors harness:seedLoad) so Layer 2 starts exact.
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 100);
    const startTreasury = s.world.treasuryTox;
    // run past the 5-minute window
    let t = s.world.lastTick;
    for (let i = 0; i < 61; i++) {
      t += WORLD.TICK_SECONDS * 1000;
      simTick(s, t, false);
    }
    const q = s.players[0];
    expect(q.hasBase).toBe(false); // Base −1
    expect(q.storageKg).toBe(0);
    expect(q.processing.queuedKg).toBe(0);
    expect(q.robot.cargoKg).toBe(0); // Robot −1 (reset to reserve unit)
    expect(q.robot.state).toBe("idle");
    expect(q.robot.auto).toBe(true);
    expect(q.toxBalance).toBeCloseTo(1000 - PROTECTION.LAUNCH_FEE_TOX, 6); // fee charged at completion
    expect(q.solBalance).toBeCloseTo(WORLD.BASE_PRICE_SOL, 6); // MOCK re-entry grant
    expect(q.protection.state).toBe("normal");
    // treasury −15% (mock world vault)
    expect(s.world.treasuryTox).toBeCloseTo(startTreasury * (1 - PROTECTION.TREASURY_BURN_FRAC), 6);
    // abandoned stockpile spilled back into the recoverable pool (Layer 2 exact)
    const r = simTick(s, t + WORLD.TICK_SECONDS * 1000, false);
    expect(Math.abs(r.invariantPool)).toBeLessThan(1e-6);
    expect(Math.abs(r.invariantMass)).toBeLessThan(1e-6);
  });

  test("Toxic Shield does NOT prevent or delay world collapse; buff persists", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    const shieldUntil = Date.now() + PROTECTION.SHIELD_DURATION_MS;
    s.players.push(
      makePlayer("shielded", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 100,
        protection: { state: "normal", shieldUntil },
        auto: false,
      }, Date.now()),
    );
    const after = untilCollapse(s);
    expect(after.world.worldId).toBe(1); // collapse happened regardless
    expect(after.players[0].protection.shieldUntil).toBe(shieldUntil); // buff persists
    expect(after.players[0].protection.state).toBe("normal");
  });

  test("sealed robots are parked at base and contribute zero demand", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 400,
        baseY: 400,
        protection: { state: "locked", lockedAt: 0, lockReason: "voluntary" },
        auto: true,
      }, 0),
    );
    const r = runTicks(s, 2);
    const p = r.state.players[0];
    expect(r.state.world.demandKgH).toBe(0);
    expect(p.robot.state).toBe("idle");
    expect(p.robot.x).toBe(400);
    expect(p.robot.y).toBe(400);
  });

  test("players WITHOUT a base never go AFK (idle check only applies to bases)", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("nobase", {
        hasBase: false,
        baseX: 500,
        baseY: 500,
        lastActiveAt: -PROTECTION.AFK_AFTER_MS * 2,
      }, 0),
    );
    const r = runTicks(s, 2);
    expect(r.state.players[0].protection.state).toBe("normal");
  });
});

// helper import to keep the top of the file tidy (bun:test top-level only)
import { runTicks } from "./engineSim";
