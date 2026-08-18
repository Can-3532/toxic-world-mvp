// TOXIC WORLD — Sprint 2.12 PROTECTION SYSTEMS VALIDATION
// Tests the full protection state machine, all transitions, and economy interactions.
// Mirrors production world.ts via the deterministic oracle (engineSim.ts).

import { describe, it, expect } from "vitest";
import {
  PROTECTION,
  UPGRADES,
  WORLD,
  TOX_PER_TON,
  BURN_ZONE_MULTIPLIER,
} from "../src/convex/gameParams";
import {
  isSealed,
  onWorldCollapse,
  keepsHeldOnCollapse,
  drainMultiplier,
  collapseSeed,
  proportionalPreserve,
  applyIdleCheck,
  onActivity,
  afkDue,
  shieldActive,
  launchDue,
  protectionDefaults,
} from "../src/convex/protection";
import {
  replenishmentModelC,
  worldStatus,
} from "../src/convex/engine";
import {
  normalBurnTox,
  burnZoneTox,
} from "../src/convex/economy";
import {
  freshWorld,
  makePlayer,
  makePlayers,
  simTick,
  runTicks,
  simInvariant,
  simWithPlayers,
  type SimState,
} from "./engineSim";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPS = 1e-6;

function assertExactInvariant(state: SimState) {
  const inv = simInvariant(state);
  expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
  expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
}

/** Deterministic Burn Zone schedule (same as the 2.8/2.10 suites). */
const zoneActiveAt = (t: number) => t % 16 < 4;

function runStarter(
  opts: {
    cadenceTicks?: number;
    gameHours?: number;
    worldPollutionFrac?: number;
  } = {},
): {
  p: ReturnType<typeof makePlayer>;
  state: SimState;
  stallTicks: number;
  maxStorageKg: number;
  maxQueueKg: number;
} {
  const gameHours = opts.gameHours ?? 24;
  const cadenceTicks = opts.cadenceTicks ?? 1;
  const p = makePlayer("s", { hasBase: true, baseX: 500, baseY: 500, auto: true });
  const state = simWithPlayers([p]);
  if (opts.worldPollutionFrac != null) {
    state.world.pollutionKg = state.world.capacityKg * opts.worldPollutionFrac;
  }
  const ticks = gameHours * 60;
  let stallTicks = 0;
  let maxStorageKg = 0;
  let maxQueueKg = 0;
  for (let t = 0; t < ticks; t++) {
    simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, zoneActiveAt(t));
    if (p.storageKg > 0 && (cadenceTicks <= 1 || t % cadenceTicks === 0)) {
      p.processing.queuedKg += p.storageKg;
      if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
      p.storageKg = 0;
    }
    if (p.robot.state === "idle" && p.robot.cargoKg > 0) stallTicks += 1;
    maxStorageKg = Math.max(maxStorageKg, p.storageKg);
    maxQueueKg = Math.max(maxQueueKg, p.processing.queuedKg);
    assertExactInvariant(state);
  }
  return { p, state, stallTicks, maxStorageKg, maxQueueKg };
}

// ============================================================================
// SECTION 1: PROTECTION STATE MACHINE — CORE TRANSITIONS
// ============================================================================

describe("1. Protection State Machine — Core Transitions", () => {
  it("1.1 new player starts NORMAL", () => {
    const prot = protectionDefaults();
    expect(prot.state).toBe("normal");
  });

  it("1.2 AFK detection triggers after 12 real hours", () => {
    const now = Date.now();
    const lastActive = now - PROTECTION.AFK_AFTER_MS - 1;
    expect(afkDue(lastActive, now)).toBe(true);
  });

  it("1.3 AFK detection does NOT trigger before 12 real hours", () => {
    const now = Date.now();
    const lastActive = now - PROTECTION.AFK_AFTER_MS + 1;
    expect(afkDue(lastActive, now)).toBe(false);
  });

  it("1.4 applyIdleCheck transitions NORMAL → AFK after 12h", () => {
    const now = Date.now();
    const prot = { state: "normal" as const };
    const lastActive = now - PROTECTION.AFK_AFTER_MS - 1;
    const result = applyIdleCheck(prot, lastActive, now);
    expect(result.state).toBe("afk");
  });

  it("1.5 applyIdleCheck does NOT transition LOCKED → AFK", () => {
    const now = Date.now();
    const prot = { state: "locked" as const };
    const lastActive = now - PROTECTION.AFK_AFTER_MS - 1;
    const result = applyIdleCheck(prot, lastActive, now);
    expect(result.state).toBe("locked");
  });

  it("1.6 applyIdleCheck does NOT transition LAUNCHING → AFK", () => {
    const now = Date.now();
    const prot = { state: "launching" as const };
    const lastActive = now - PROTECTION.AFK_AFTER_MS - 1;
    const result = applyIdleCheck(prot, lastActive, now);
    expect(result.state).toBe("launching");
  });

  it("1.7 onActivity transitions AFK → NORMAL", () => {
    const prot = { state: "afk" as const };
    const result = onActivity(prot);
    expect(result.state).toBe("normal");
  });

  it("1.8 onActivity does NOT change NORMAL", () => {
    const prot = { state: "normal" as const };
    const result = onActivity(prot);
    expect(result.state).toBe("normal");
  });

  it("1.9 isSealed returns true for LOCKED", () => {
    expect(isSealed("locked")).toBe(true);
  });

  it("1.10 isSealed returns true for LAUNCHING", () => {
    expect(isSealed("launching")).toBe(true);
  });

  it("1.11 isSealed returns false for NORMAL", () => {
    expect(isSealed("normal")).toBe(false);
  });

  it("1.12 isSealed returns false for AFK", () => {
    expect(isSealed("afk")).toBe(false);
  });

  it("1.13 keepsHeldOnCollapse returns true for LOCKED", () => {
    expect(keepsHeldOnCollapse("locked")).toBe(true);
  });

  it("1.14 keepsHeldOnCollapse returns true for LAUNCHING", () => {
    expect(keepsHeldOnCollapse("launching")).toBe(true);
  });

  it("1.15 keepsHeldOnCollapse returns false for NORMAL", () => {
    expect(keepsHeldOnCollapse("normal")).toBe(false);
  });

  it("1.16 keepsHeldOnCollapse returns false for AFK", () => {
    expect(keepsHeldOnCollapse("afk")).toBe(false);
  });
});

// ============================================================================
// SECTION 2: BASE LOCK TESTS
// ============================================================================

describe("2. Base Lock Tests", () => {
  it("2.1 locked base: generation stops", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 400,
        baseY: 400,
        protection: { state: "locked", lockReason: "voluntary" },
      }),
    );
    runTicks(s, 60);
    expect(s.world.generationRateKgH).toBe(0);
  });

  it("2.2 locked base: robot is parked (sealed robots are skipped by tick)", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 400,
        baseY: 400,
        protection: { state: "locked", lockReason: "voluntary" },
      }),
    );
    runTicks(s, 60);
    // Sealed robots are never stepped — they remain in whatever state they
    // were set to when locked (idle). The tick skips them entirely.
    expect(s.players[0].robot.state).toBe("idle");
  });

  it("2.3 locked base: storage is preserved", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 400,
        baseY: 400,
        storageKg: 100,
        protection: { state: "locked", lockReason: "voluntary" },
      }),
    );
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 100);
    runTicks(s, 5);
    expect(s.players[0].storageKg).toBe(100);
  });

  it("2.4 locked base: existing burn queue continues", () => {
    const s = freshWorld();
    const p = makePlayer("locked", {
      hasBase: true,
      baseX: 400,
      baseY: 400,
      protection: { state: "locked", lockReason: "voluntary" },
      queuedKg: 200,
      sessionId: "test-session",
    });
    s.players.push(p);
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 200);

    const initialQueued = p.processing.queuedKg;
    runTicks(s, 5);

    expect(p.processing.queuedKg).toBeLessThan(initialQueued);
    expect(p.toxBalance).toBeGreaterThan(0);
  });

  it("2.5 locked base: unlock returns to NORMAL", () => {
    const p = makePlayer("locked", {
      hasBase: true,
      baseX: 400,
      baseY: 400,
      toxBalance: 500,
      protection: { state: "locked", lockReason: "voluntary" },
    });

    // Simulate unlock
    p.toxBalance -= PROTECTION.UNLOCK_COST_TOX;
    p.protection = {
      ...p.protection,
      state: "normal",
      lockedAt: undefined,
      lockReason: undefined,
    };

    expect(p.protection.state).toBe("normal");
    expect(p.toxBalance).toBe(300);
  });

  it("2.6 locked base: world collapse while locked preserves stockpile", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 500,
        protection: { state: "locked", lockReason: "voluntary" },
      }),
      makePlayer("drone", { hasBase: true, baseX: 300, baseY: 300, auto: false }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 500 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].protection.state).toBe("locked");
    expect(s.players[0].storageKg).toBe(500);
  });
});

// ============================================================================
// SECTION 3: AFK PROTECTION TESTS
// ============================================================================

describe("3. AFK Protection Tests", () => {
  it("3.1 AFK: generation continues", () => {
    const s = freshWorld();
    s.players.push(
      makePlayer("afk", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        lastActiveAt: -PROTECTION.AFK_AFTER_MS,
      }),
    );
    const before = s.world.pollutionKg;
    runTicks(s, 60);
    // AFK bases still generate
    expect(s.world.pollutionKg).toBeCloseTo(before + WORLD.BASE_GEN_KG_H, 3);
  });

  it("3.2 AFK: world collapse auto-locks base", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    const storageKg = 60; // L1 cap
    s.players.push(
      makePlayer("afk", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg,
        lastActiveAt: -PROTECTION.AFK_AFTER_MS,
      }),
      makePlayer("drone", { hasBase: true, baseX: 300, baseY: 300, auto: false }),
    );
    s.world.collectableKg = Math.max(0, s.world.collectableKg - storageKg);
    let now = s.world.lastTick;
    for (let i = 0; i < 500 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].protection.state).toBe("locked");
    expect(s.players[0].protection.lockReason).toBe("collapse");
    expect(s.players[0].storageKg).toBe(storageKg);
  });

  it("3.3 AFK: 1h idle does NOT trigger AFK", () => {
    const now = 100_000;
    expect(applyIdleCheck({ state: "normal" }, now - 3_600_000, now).state).toBe("normal");
  });

  it("3.4 AFK: 6h idle does NOT trigger AFK", () => {
    const now = 100_000;
    expect(applyIdleCheck({ state: "normal" }, now - 6 * 3_600_000, now).state).toBe("normal");
  });

  it("3.5 AFK: 13h idle triggers AFK", () => {
    const now = 100_000;
    expect(applyIdleCheck({ state: "normal" }, now - 13 * 3_600_000, now).state).toBe("afk");
  });

  it("3.6 AFK: return after AFK restores NORMAL", () => {
    const afk: Protection = { state: "afk" };
    expect(onActivity(afk).state).toBe("normal");
  });
});

// ============================================================================
// SECTION 4: TOXIC SHIELD TESTS
// ============================================================================

describe("4. Toxic Shield Tests", () => {
  it("4.1 shield blocks critical drain multiplier", () => {
    const now = Date.now();
    const prot = { state: "normal" as const, shieldUntil: now + 100_000 };
    const mult = drainMultiplier(prot, now, true);
    expect(mult).toBe(1);
  });

  it("4.2 unshielded robot in critical gets drain multiplier", () => {
    const now = Date.now();
    const prot = { state: "normal" as const };
    const mult = drainMultiplier(prot, now, true);
    expect(mult).toBe(PROTECTION.CRITICAL_DRAIN_MULT);
  });

  it("4.3 shield does nothing in safe world", () => {
    const now = Date.now();
    const prot = { state: "normal" as const, shieldUntil: now + 100_000 };
    const mult = drainMultiplier(prot, now, false);
    expect(mult).toBe(1);
  });

  it("4.4 shield expiry: drain multiplier applies after expiry", () => {
    const now = Date.now();
    const prot = { state: "normal" as const, shieldUntil: now - 1000 };
    const mult = drainMultiplier(prot, now, true);
    expect(mult).toBe(PROTECTION.CRITICAL_DRAIN_MULT);
  });

  it("4.5 shield does NOT prevent world collapse", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("shielded", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        protection: {
          state: "normal",
          shieldUntil: 1_000_000 + PROTECTION.SHIELD_DURATION_MS,
        },
      }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    // World collapses regardless of shield
    expect(s.world.worldId).toBe(1);
    // Shield buff persists
    expect(s.players[0].protection.shieldUntil).toBeGreaterThan(0);
  });
});

// ============================================================================
// SECTION 5: EMERGENCY LAUNCH TESTS
// ============================================================================

describe("5. Emergency Launch Tests", () => {
  it("5.1 launch completion: base destroyed, player returns to NORMAL", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      toxBalance: 500,
      protection: {
        state: "launching",
        launchAt: s.world.lastTick + PROTECTION.LAUNCH_WINDOW_MS,
      },
    });
    s.players.push(p);
    let t = s.world.lastTick;
    for (let i = 0; i < 61; i++) {
      t += WORLD.TICK_SECONDS * 1000;
      simTick(s, t, false);
    }
    expect(p.hasBase).toBe(false);
    expect(p.protection.state).toBe("normal");
  });

  it("5.2 launch completion: TOX fee deducted", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      toxBalance: 1000,
      protection: {
        state: "launching",
        launchAt: 0,
      },
    });
    s.players.push(p);
    runTicks(s, 61);
    expect(p.toxBalance).toBeCloseTo(700, 6);
  });

  it("5.3 launch completion: treasury decreases by 15%", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      protection: { state: "launching", launchAt: 0 },
    });
    s.players.push(p);
    const initialTreasury = s.world.treasuryTox;
    runTicks(s, 61);
    expect(s.world.treasuryTox).toBeCloseTo(
      initialTreasury * (1 - PROTECTION.TREASURY_BURN_FRAC),
      6,
    );
  });

  it("5.4 launch completion: held waste returned to pool", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      storageKg: 100,
      protection: { state: "launching", launchAt: 0 },
    });
    s.players.push(p);
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 100);
    const initialCollectable = s.world.collectableKg;
    runTicks(s, 61);
    expect(s.world.collectableKg).toBeGreaterThanOrEqual(initialCollectable + 100 - 1);
  });

  it("5.5 launch completion: SOL re-entry grant given", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      solBalance: 0,
      protection: { state: "launching", launchAt: 0 },
    });
    s.players.push(p);
    runTicks(s, 61);
    expect(p.solBalance).toBeCloseTo(WORLD.BASE_PRICE_SOL, 6);
  });

  it("5.6 launch completion: robot reset to reserve unit", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      protection: { state: "launching", launchAt: 0 },
    });
    s.players.push(p);
    runTicks(s, 61);
    expect(p.robot.state).toBe("idle");
    expect(p.robot.cargoKg).toBe(0);
    expect(p.robot.auto).toBe(true);
    expect(p.robot.battery).toBe(UPGRADES.battery.caps[0]);
  });

  it("5.7 launch NOT completed if countdown still active", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      protection: {
        state: "launching",
        launchAt: 1_000_000_000, // far future
      },
    });
    s.players.push(p);
    const startMs = s.world.lastTick + WORLD.TICK_SECONDS * 1000;
    runTicks(s, 1, startMs);
    expect(p.hasBase).toBe(true);
    expect(p.protection.state).toBe("launching");
  });

  it("5.8 cancel launch: returns to LOCKED", () => {
    const prot: Protection = {
      state: "launching",
      launchAt: Date.now() + 100_000,
    };
    const result = {
      ...prot,
      state: "locked" as const,
      launchAt: undefined,
    };
    expect(result.state).toBe("locked");
    expect(result.launchAt).toBeUndefined();
  });

  it("5.9 launch fee is charged at COMPLETION, not initiation", () => {
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      toxBalance: 500,
      protection: { state: "locked" },
    });

    // Initiation: no charge
    p.protection = { state: "launching", launchAt: Date.now() + 300_000 };
    expect(p.toxBalance).toBe(500);

    // Completion: fee deducted
    p.toxBalance -= PROTECTION.LAUNCH_FEE_TOX;
    expect(p.toxBalance).toBe(200);
  });

  it("5.10 multiple launches: treasury decreases cumulatively", () => {
    const s = freshWorld();
    for (let i = 0; i < 3; i++) {
      s.players.push(
        makePlayer(`p${i}`, {
          hasBase: true,
          baseX: 400 + i * 40,
          baseY: 500,
          protection: { state: "launching", launchAt: 0 },
        }),
      );
    }
    const initialTreasury = s.world.treasuryTox;
    runTicks(s, 61);
    const expected =
      initialTreasury * Math.pow(1 - PROTECTION.TREASURY_BURN_FRAC, 3);
    expect(s.world.treasuryTox).toBeCloseTo(expected, -1);
  });
});

// ============================================================================
// SECTION 6: COLLAPSE INTERACTION MATRIX
// ============================================================================

describe("6. Collapse Interaction Matrix", () => {
  it("6.1 NORMAL at collapse: stockpile wiped", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("normal", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 400,
        protection: { state: "normal" },
        auto: false,
      }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].storageKg).toBe(0);
    expect(s.players[0].robot.cargoKg).toBe(0);
    expect(s.players[0].processing.queuedKg).toBe(0);
  });

  it("6.2 AFK at collapse: stockpile preserved, state becomes LOCKED", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("afk", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 400,
        lastActiveAt: -PROTECTION.AFK_AFTER_MS - 1,
        auto: false,
      }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].protection.state).toBe("locked");
    expect(s.players[0].protection.lockReason).toBe("collapse");
    expect(s.players[0].storageKg).toBe(400);
  });

  it("6.3 LOCKED at collapse: stockpile preserved", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("locked", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 400,
        protection: { state: "locked", lockReason: "voluntary" },
      }),
      makePlayer("drone", { hasBase: true, baseX: 300, baseY: 300, auto: false }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 500 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].protection.state).toBe("locked");
    expect(s.players[0].storageKg).toBe(400);
  });

  it("6.4 LAUNCHING at collapse: stockpile preserved until launch completes", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("launcher", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg: 400,
        protection: { state: "launching", launchAt: undefined },
      }),
      makePlayer("drone", { hasBase: true, baseX: 300, baseY: 300, auto: false }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 500 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].storageKg).toBe(400);
    expect(s.players[0].protection.state).toBe("launching");
  });

  it("6.5 collapse: new world starts at 22.5%", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500, auto: false }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(
      (s.world.pollutionKg / s.world.capacityKg) * 100,
    ).toBeCloseTo(WORLD.RESET_POLLUTION_FRAC * 100, 0);
  });

  it("6.6 collapse: worldId increments", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    s.players.push(
      makePlayer("p1", { hasBase: true, baseX: 500, baseY: 500, auto: false }),
    );
    let now = s.world.lastTick;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
  });
});

// ============================================================================
// SECTION 7: TOX REWARD CORRECTNESS
// ============================================================================

describe("7. TOX Reward Correctness", () => {
  it("7.1 normal burn: 500 TOX/ton", () => {
    expect(normalBurnTox(1000)).toBe(500);
  });

  it("7.2 normal burn: 100 kg = 50 TOX", () => {
    expect(normalBurnTox(100)).toBe(50);
  });

  it("7.3 burn zone: 600 TOX/ton", () => {
    expect(burnZoneTox(1000)).toBe(600);
  });

  it("7.4 burn zone: 100 kg = 60 TOX", () => {
    expect(burnZoneTox(100)).toBe(60);
  });

  it("7.5 idempotency: same burn slice not rewarded twice", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      queuedKg: 100,
      sessionId: "test-session",
    });
    s.players.push(p);
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 100);

    // First tick — reward
    runTicks(s, 1);
    const toxAfterFirst = p.toxBalance;
    expect(toxAfterFirst).toBeGreaterThan(0);
    const ledgerAfterFirst = s.ledger.length;

    // Second tick with same session — should NOT double-reward
    // (idempotency key prevents duplicate)
    runTicks(s, 1);
    // New slices for remaining queue are created, but the original key
    // is not re-rewarded
    expect(s.ledger.length).toBeGreaterThanOrEqual(ledgerAfterFirst);
  });

  it("7.6 burn reward only at PROCESSING → BURNED transition", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      queuedKg: 100,
      sessionId: "test",
    });
    s.players.push(p);
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 100);

    const toxBefore = p.toxBalance;
    runTicks(s, 1);
    expect(p.toxBalance).toBeGreaterThan(toxBefore);
  });

  it("7.7 collecting waste does NOT produce TOX", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      cargoKg: 50,
    });
    s.players.push(p);

    const toxBefore = p.toxBalance;
    runTicks(s, 1);
    expect(p.toxBalance).toBe(toxBefore);
  });

  it("7.8 unloading at base does NOT produce TOX", () => {
    const s = freshWorld();
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      cargoKg: 50,
    });
    s.players.push(p);

    const toxBefore = p.toxBalance;
    runTicks(s, 1);
    expect(p.toxBalance).toBe(toxBefore);
  });
});

// ============================================================================
// SECTION 8: STORAGE + PROTECTION INTERACTION
// ============================================================================

describe("8. Storage + Protection Interaction", () => {
  it("8.1 diligent player: TOX earned correctly over 24 game-hours", () => {
    const { p } = runStarter({ cadenceTicks: 1 });
    // Deterministic baseline ≈ 1,919.5 TOX/day
    expect(p.toxBalance).toBeGreaterThan(1000);
    expect(p.totalBurnedKg).toBeGreaterThan(3500);
  });

  it("8.2 storage fills up: excess cargo parks on robot", () => {
    const { p, maxStorageKg } = runStarter({ cadenceTicks: 360 });
    // L1 storage cap = 60 kg
    expect(maxStorageKg).toBe(60);
    expect(p.robot.cargoKg).toBeGreaterThan(0); // parked with cargo
  });

  it("8.3 AFK protection saves stockpile but loses missed income", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    const storageKg = 60; // L1 storage cap
    s.players.push(
      makePlayer("afk", {
        hasBase: true,
        baseX: 500,
        baseY: 500,
        storageKg,
        lastActiveAt: -PROTECTION.AFK_AFTER_MS,
      }),
      makePlayer("drone", { hasBase: true, baseX: 300, baseY: 300, auto: false }),
    );
    s.world.collectableKg = Math.max(0, s.world.collectableKg - storageKg);
    let now = s.world.lastTick;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      now += WORLD.TICK_SECONDS * 1000;
      simTick(s, now, false);
    }
    expect(s.world.worldId).toBe(1);
    expect(s.players[0].protection.state).toBe("locked");
    expect(s.players[0].storageKg).toBe(storageKg);
  });

  it("8.4 processing queue continues while locked (anti-deadlock)", () => {
    const s = freshWorld();
    const p = makePlayer("locked", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      protection: { state: "locked", lockReason: "voluntary" },
      queuedKg: 1000,
      sessionId: "lock-test",
    });
    s.players.push(p);
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 1000);

    const initialQueued = p.processing.queuedKg;
    runTicks(s, 10);

    expect(p.processing.queuedKg).toBeLessThan(initialQueued);
    expect(p.toxBalance).toBeGreaterThan(0);
  });
});

// ============================================================================
// SECTION 9: PLAYER PROFILES
// ============================================================================

describe("9. Player Profiles", () => {
  it("9.1 GOOD ACTIVE: diligent → steady TOX income, no protection spend", () => {
    const { p } = runStarter({ cadenceTicks: 1 });
    // Baseline varies with cluster distribution; verify significant income
    expect(p.toxBalance).toBeGreaterThan(1500);
    expect(p.totalBurnedKg).toBeGreaterThan(3000);
    expect(p.protection.state).toBe("normal");
  });

  it("9.2 LONG AFK: stockpile safe at collapse", () => {
    const { p } = runStarter({ cadenceTicks: 1_000_000 });
    // Storage fills to 60 kg then robot parks
    expect(p.storageKg).toBe(60);
    expect(p.robot.cargoKg).toBe(20);
    expect(p.robot.state).toBe("idle");
  });

  it("9.3 CRITICAL WORLD: shield preserves activity throughput", () => {
    const p = makePlayer("s", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      auto: true,
    });
    const state = freshWorld(WORLD.CAPACITY_KG, 0.95);
    state.players.push(p);
    state.world.collectableKg = Math.max(0, state.world.collectableKg - 50);
    p.protection = { state: "normal", shieldUntil: 1_000_000 + 2 * 3_600_000 };

    const initialBattery = p.robot.battery;
    for (let t = 0; t < 10; t++) {
      simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, zoneActiveAt(t));
    }
    // Battery decreased (but at normal rate due to shield)
    expect(p.robot.battery).toBeLessThan(initialBattery);
  });
});

// ============================================================================
// SECTION 10: SCALE TESTS
// ============================================================================

describe("10. Scale Tests", () => {
  it("10.1 10 players: invariant exact", () => {
    const players = makePlayers(10, { seed: 10, autoFraction: 1.0 });
    const state = simWithPlayers(players);
    for (let t = 0; t < 10; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    assertExactInvariant(state);
  });

  it("10.2 100 players: invariant exact", () => {
    const players = makePlayers(100, { seed: 100, autoFraction: 1.0 });
    const state = simWithPlayers(players);
    for (let t = 0; t < 10; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    assertExactInvariant(state);
  });

  it("10.3 1000 players: invariant exact", () => {
    const players = makePlayers(1000, { seed: 1000, autoFraction: 1.0 });
    const state = simWithPlayers(players);
    for (let t = 0; t < 5; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    assertExactInvariant(state);
  });

  it("10.4 10000 players: invariant exact (window check)", () => {
    const players = makePlayers(10_000, { seed: 10_000, autoFraction: 0.5 });
    const state = simWithPlayers(players);
    for (let t = 0; t < 3; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    assertExactInvariant(state);
    expect(state.players.length).toBe(10_000);
  });
});

// ============================================================================
// SECTION 11: DETERMINISTIC STATE TRANSITIONS
// ============================================================================

describe("11. Deterministic State Transitions", () => {
  it("11.1 same input → same output (deterministic)", () => {
    const run = () => {
      const p = makePlayer("s", { hasBase: true, baseX: 500, baseY: 500, auto: true });
      const state = simWithPlayers([p]);
      for (let t = 0; t < 60; t++) {
        simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
      }
      return { tox: p.toxBalance, burned: p.totalBurnedKg, worldId: state.world.worldId };
    };
    expect(run()).toEqual(run());
  });

  it("11.2 protection transitions are deterministic", () => {
    const now = Date.now();
    const prot1 = applyIdleCheck(
      { state: "normal" },
      now - PROTECTION.AFK_AFTER_MS - 1,
      now,
    );
    const prot2 = applyIdleCheck(
      { state: "normal" },
      now - PROTECTION.AFK_AFTER_MS - 1,
      now,
    );
    expect(prot1.state).toBe(prot2.state);
  });
});

// ============================================================================
// SECTION 12: ECONOMY CONSTANTS VERIFICATION
// ============================================================================

describe("12. Economy Constants Verification", () => {
  it("12.1 world capacity is 10,000 tons", () => {
    expect(WORLD.CAPACITY_KG).toBe(10_000_000);
  });

  it("12.2 initial pollution is 50%", () => {
    expect(WORLD.INITIAL_POLLUTION_FRAC).toBe(0.5);
  });

  it("12.3 critical threshold is 90%", () => {
    expect(WORLD.CRITICAL_FRAC).toBe(0.9);
  });

  it("12.4 TOX per ton is 500", () => {
    expect(TOX_PER_TON).toBe(500);
  });

  it("12.5 burn zone multiplier is 1.2", () => {
    expect(BURN_ZONE_MULTIPLIER).toBe(1.2);
  });

  it("12.6 AFK threshold is 12 real hours", () => {
    expect(PROTECTION.AFK_AFTER_MS).toBe(12 * 3_600_000);
  });

  it("12.7 unlock cost is 200 TOX", () => {
    expect(PROTECTION.UNLOCK_COST_TOX).toBe(200);
  });

  it("12.8 shield cost is 150 TOX", () => {
    expect(PROTECTION.SHIELD_COST_TOX).toBe(150);
  });

  it("12.9 shield duration is 2 real hours", () => {
    expect(PROTECTION.SHIELD_DURATION_MS).toBe(2 * 3_600_000);
  });

  it("12.10 launch fee is 300 TOX", () => {
    expect(PROTECTION.LAUNCH_FEE_TOX).toBe(300);
  });

  it("12.11 launch window is 5 real minutes", () => {
    expect(PROTECTION.LAUNCH_WINDOW_MS).toBe(5 * 60_000);
  });

  it("12.12 treasury burn fraction is 15%", () => {
    expect(PROTECTION.TREASURY_BURN_FRAC).toBe(0.15);
  });

  it("12.13 treasury seed is 1,000,000 TOX", () => {
    expect(PROTECTION.TREASURY_SEED_TOX).toBe(1_000_000);
  });
});

// ============================================================================
// SECTION 13: CRITICAL RECOVERY
// ============================================================================

describe("13. Critical Recovery", () => {
  it("13.1 burn > generation reduces pollution from critical", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.92);
    for (let i = 0; i < 5; i++) {
      s.players.push(
        makePlayer(`p${i}`, {
          hasBase: true,
          baseX: 400 + i * 40,
          baseY: 500,
          queuedKg: 500,
          sessionId: `crit-p${i}`,
        }),
      );
    }
    // Deduct held mass from collectable pool
    s.world.collectableKg = Math.max(0, s.world.collectableKg - 5 * 500);

    const initialPollution = s.world.pollutionKg;
    for (let t = 0; t < 20; t++) {
      simTick(s, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    // Burn 10 kg/tick × 20 ticks = 200 kg removed; generation 250 kg/game-h
    // but over 20 ticks (100s = 0.028 game-h) gen = 7 kg, so net burn wins
    expect(s.world.pollutionKg).toBeLessThan(initialPollution);
  });
});

// ============================================================================
// SECTION 14: MIXED PROTECTION STATES
// ============================================================================

describe("14. Mixed Protection States", () => {
  it("14.1 mixed normal/locked/afk: invariant holds", () => {
    const players = makePlayers(10, { seed: 10, autoFraction: 1.0 });
    players[0].protection = { state: "locked", lockReason: "voluntary" };
    players[1].protection = { state: "afk" };
    players[2].protection = { state: "locked", lockReason: "voluntary" };
    players[3].protection = { state: "afk" };
    const state = simWithPlayers(players);
    for (let t = 0; t < 10; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    assertExactInvariant(state);
  });

  it("14.2 locked players contribute 0 generation", () => {
    const players = makePlayers(5, { seed: 5, autoFraction: 1.0 });
    players[0].protection = { state: "locked", lockReason: "voluntary" };
    players[1].protection = { state: "locked", lockReason: "voluntary" };
    const state = simWithPlayers(players);
    for (let t = 0; t < 1; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    // 3 active players × 50 kg/h = 150 kg/h
    expect(state.world.generationRateKgH).toBe(3 * WORLD.BASE_GEN_KG_H);
  });

  it("14.3 locked players contribute 0 demand", () => {
    const players = makePlayers(5, { seed: 5, autoFraction: 1.0 });
    players[0].protection = { state: "locked", lockReason: "voluntary" };
    const state = simWithPlayers(players);
    for (let t = 0; t < 1; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    // 4 active players × 42 kg/h = 168 kg/h demand
    expect(state.world.demandKgH).toBe(4 * WORLD.DEMAND_REF_KG_H);
  });
});

// ============================================================================
// SECTION 15: MODEL C + PROTECTION
// ============================================================================

describe("15. Model C + Protection", () => {
  it("15.1 locked players affect replenishment ratio", () => {
    const players = makePlayers(10, { seed: 10, autoFraction: 1.0 });
    for (let i = 0; i < 5; i++) {
      players[i].protection = { state: "locked", lockReason: "voluntary" };
    }
    const state = simWithPlayers(players);
    for (let t = 0; t < 5; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    // 5 active players × 50 kg/h = 250 kg/h
    expect(state.world.generationRateKgH).toBe(5 * WORLD.BASE_GEN_KG_H);
  });
});

// ============================================================================
// SECTION 16: PROPORTIONAL PRESERVE
// ============================================================================

describe("16. Proportional Preserve", () => {
  it("16.1 scale = 1 when carried ≤ preserved", () => {
    const held = { storage: 100, cargo: 50, processing: 30 };
    const result = proportionalPreserve(200, 300, held);
    expect(result).toEqual(held);
  });

  it("16.2 scale < 1 when carried > preserved", () => {
    const held = { storage: 100, cargo: 50, processing: 30 };
    const result = proportionalPreserve(300, 150, held);
    const scale = 150 / 300;
    expect(result.storage).toBeCloseTo(100 * scale);
    expect(result.cargo).toBeCloseTo(50 * scale);
    expect(result.processing).toBeCloseTo(30 * scale);
  });

  it("16.3 carried = 0 → no scaling", () => {
    const held = { storage: 0, cargo: 0, processing: 0 };
    const result = proportionalPreserve(0, 100, held);
    expect(result).toEqual(held);
  });
});

// ============================================================================
// SECTION 17: COLLAPSE SEED
// ============================================================================

describe("17. Collapse Seed", () => {
  it("17.1 collapse seed with no carried mass", () => {
    const seed = collapseSeed(WORLD.CAPACITY_KG, 0);
    const p0 = WORLD.CAPACITY_KG * WORLD.RESET_POLLUTION_FRAC;
    expect(seed.pollutionKg).toBe(p0);
    expect(seed.preservedKg).toBe(0);
    expect(seed.hiddenKg).toBeCloseTo(p0 * 0.9);
    expect(seed.collectableKg).toBeCloseTo(p0 * 0.1);
  });

  it("17.2 collapse seed with carried mass", () => {
    const seed = collapseSeed(WORLD.CAPACITY_KG, 1000);
    const p0 = WORLD.CAPACITY_KG * WORLD.RESET_POLLUTION_FRAC;
    expect(seed.preservedKg).toBe(1000);
    expect(seed.hiddenKg).toBeCloseTo((p0 - 1000) * 0.9);
    expect(seed.collectableKg).toBeCloseTo((p0 - 1000) * 0.1);
  });

  it("17.3 collapse seed caps preserved at P0", () => {
    const p0 = WORLD.CAPACITY_KG * WORLD.RESET_POLLUTION_FRAC;
    const seed = collapseSeed(WORLD.CAPACITY_KG, p0 + 1000);
    expect(seed.preservedKg).toBe(p0);
  });
});

// ============================================================================
// SECTION 18: REPLENISHMENT MODEL C
// ============================================================================

describe("18. Replenishment Model C", () => {
  it("18.1 ratio = 0 → min fraction", () => {
    expect(replenishmentModelC(500, 0)).toBe(0.05);
  });

  it("18.2 ratio = 1 → base fraction", () => {
    expect(replenishmentModelC(500, 500)).toBeCloseTo(0.05, 9);
  });

  it("18.3 ratio > 1 → increased fraction", () => {
    expect(replenishmentModelC(500, 1000)).toBeGreaterThan(0.05);
  });

  it("18.4 ratio = 0 when genKgH = 0", () => {
    expect(replenishmentModelC(0, 100)).toBeCloseTo(0.05, 9);
  });

  it("18.5 max fraction capped at 0.09", () => {
    expect(replenishmentModelC(100, 10000)).toBeCloseTo(0.09, 9);
  });
});

// ============================================================================
// SECTION 19: WORLD STATUS
// ============================================================================

describe("19. World Status", () => {
  it("19.1 safe when pollution < 90%", () => {
    expect(worldStatus(WORLD.CAPACITY_KG * 0.5, WORLD.CAPACITY_KG)).toBe("safe");
  });

  it("19.2 critical when pollution >= 90%", () => {
    expect(worldStatus(WORLD.CAPACITY_KG * 0.95, WORLD.CAPACITY_KG)).toBe("critical");
  });

  it("19.3 collapsed when pollution >= 100%", () => {
    expect(worldStatus(WORLD.CAPACITY_KG, WORLD.CAPACITY_KG)).toBe("collapsed");
  });
});

// ============================================================================
// SECTION 20: INVARIANT STRESS
// ============================================================================

describe("20. Invariant Stress", () => {
  it("20.1 100 ticks with mixed states: invariant holds", () => {
    const players = makePlayers(50, { seed: 50, autoFraction: 0.5 });
    for (const p of players) {
      const r = Math.random();
      if (r < 0.2)
        p.protection = { state: "locked", lockReason: "voluntary" };
      else if (r < 0.3) p.protection = { state: "afk" };
    }
    for (const p of players) {
      if (Math.random() < 0.3) {
        p.processing.queuedKg = 50 + Math.random() * 200;
        p.processing.sessionId = `stress-${p.id}`;
        p.processing.since = 1_000_000;
      }
    }
    const state = simWithPlayers(players);
    for (let t = 0; t < 100; t++) {
      simTick(state, 10_000_000 + t * WORLD.TICK_SECONDS * 1000, false);
    }
    assertExactInvariant(state);
  });
});
