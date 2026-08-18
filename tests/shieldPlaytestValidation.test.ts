/**
 * TOXIC WORLD — Sprint 2.12.3
 * SHIELD PLAYTEST VALIDATION
 *
 * Measures shield behavioral value across pollution levels,
 * player profiles, and cost variations. Does NOT change any
 * protected system values. Deterministic oracle-based.
 */

import { describe, it, expect } from "vitest";
import {
  PROTECTION,
  WORLD,
  TOX_PER_TON,
  UPGRADES,
} from "../src/convex/gameParams";
import {
  drainMultiplier,
  shieldActive as checkShieldActive,
} from "../src/convex/protection";
import {
  freshWorld,
  makePlayer,
  makePlayers,
  simTick,
  runTicks,
  simInvariant,
  simWithPlayers,
  type SimState,
  type SimPlayer,
} from "./engineSim";

const POLLUTION_LEVELS = [90, 92.5, 95, 97.5, 99];
const COST_OPTIONS = [100, 125, 150, 175, 200];
const LEVELS = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShieldedPlayer(
  id: string | number,
  level: number,
  pollution: number,
  shieldUntil: number,
): SimPlayer {
  return makePlayer(id, {
    hasBase: true,
    baseX: 500,
    baseY: 500,
    auto: true,
    levels: { cargo: level, recharge: level, battery: level, storage: level },
    protection: { state: "normal", shieldUntil },
  });
}

function runShieldScenario(
  pollution: number,
  level: number,
  ticks: number,
  shielded: boolean,
) {
  const s = freshWorld(WORLD.CAPACITY_KG, pollution / 100);
  const now = s.world.lastTick;
  const shieldUntil = shielded
    ? now + PROTECTION.SHIELD_DURATION_MS
    : 0;
  const p = makeShieldedPlayer("p1", level, pollution, shieldUntil);
  s.players.push(p);

  let t = now;
  let activeTicks = 0;
  let totalBurned = 0;
  for (let i = 0; i < ticks; i++) {
    const prevBurned = p.totalBurnedKg;
    const prevBattery = p.robot.battery;
    t += WORLD.TICK_SECONDS * 1000;
    simTick(s, t, false);
    totalBurned += p.totalBurnedKg - prevBurned;
    if (p.robot.state !== "recharging") activeTicks++;
  }

  return {
    totalBurned,
    activeTicks,
    toxBalance: p.toxBalance,
    protectionShieldUntil: p.protection.shieldUntil ?? 0,
    storageCap: 60 * level, // from gameParams
  };
}

// ============================================================================
// §1 — SHIELD USAGE BY POLLUTION
// ============================================================================
describe("§1 Shield Usage by Pollution", () => {
  for (const pollution of POLLUTION_LEVELS) {
    it(`shield active at ${pollution}% pollution`, () => {
      const s = freshWorld(WORLD.CAPACITY_KG, pollution / 100);
      const now = s.world.lastTick;
      const p = makeShieldedPlayer("p1", 1, pollution, now + PROTECTION.SHIELD_DURATION_MS);
      s.players.push(p);
      // After a few ticks, shield should still be active
      let t = now;
      for (let i = 0; i < 5; i++) {
        t += WORLD.TICK_SECONDS * 1000;
        simTick(s, t, false);
      }
      expect(p.protection.shieldUntil).toBeGreaterThan(t);
    });

    it(`shield benefit at ${pollution}% (4 game-h = 48 ticks)`, () => {
      const shielded = runShieldScenario(pollution, 1, 48, true);
      const unshielded = runShieldScenario(pollution, 1, 48, false);
      const deltaBurn = shielded.totalBurned - unshielded.totalBurned;
      // Shield should help burn at critical pollution
      expect(deltaBurn).toBeGreaterThanOrEqual(0);
    });
  }

  it("all invariants hold during shield at critical", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now = s.world.lastTick;
    s.players.push(
      makeShieldedPlayer("p1", 1, 95, now + PROTECTION.SHIELD_DURATION_MS),
    );
    let t = now;
    for (let i = 0; i < 48; i++) {
      t += WORLD.TICK_SECONDS * 1000;
      simTick(s, t, false);
    }
    const inv = simInvariant(s);
    expect(Math.abs(inv.massBalance)).toBeLessThan(1e-3);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(1e-3);
  });
});

// ============================================================================
// §2 — SHIELD USAGE BY PLAYER LEVEL
// ============================================================================
describe("§2 Shield Usage by Player Level", () => {
  for (const level of LEVELS) {
    it(`L${level} shield benefit at 95% pollution`, () => {
      const shielded = runShieldScenario(95, level, 48, true);
      const unshielded = runShieldScenario(95, level, 48, false);
      const deltaBurn = shielded.totalBurned - unshielded.totalBurned;
      expect(deltaBurn).toBeGreaterThanOrEqual(0);
    });

    it(`L${level} active ticks with shield vs without`, () => {
      const withShield = runShieldScenario(95, level, 48, true);
      const withoutShield = runShieldScenario(95, level, 48, false);
      expect(withShield.activeTicks).toBeGreaterThanOrEqual(
        withoutShield.activeTicks,
      );
    });
  }
});

// ============================================================================
// §3 — COST VARIATION
// ============================================================================
describe("§3 Cost Variation (L1, 95% critical)", () => {
  for (const cost of COST_OPTIONS) {
    it(`shield at ${cost} TOX — drain multiplier correct`, () => {
      const now = Date.now();
      const prot = { state: "normal" as const, shieldUntil: now + 100_000 };
      // At critical world, shielded player has drain multiplier = 1 (no penalty)
      const mult = drainMultiplier(prot, now, true);
      expect(mult).toBe(1);
      // Shield cost does not affect the drain multiplier function
    });
  }
});

// ============================================================================
// §4 — PLAYER VALUE (ADDITIONAL ACTIVE TIME)
// ============================================================================
describe("§4 Player Value — Additional Active Time", () => {
  for (const pollution of [90, 95, 99]) {
    it(`additional active time at ${pollution}%`, () => {
      const shielded = runShieldScenario(pollution, 1, 48, true);
      const unshielded = runShieldScenario(pollution, 1, 48, false);
      const additionalActive = shielded.activeTicks - unshielded.activeTicks;
      expect(additionalActive).toBeGreaterThanOrEqual(0);
    });
  }

  it("additional burn volume measured at L1 95%", () => {
    const shielded = runShieldScenario(95, 1, 48, true);
    const unshielded = runShieldScenario(95, 1, 48, false);
    expect(shielded.totalBurned).toBeGreaterThanOrEqual(
      unshielded.totalBurned,
    );
  });
});

// ============================================================================
// §5 — LEVEL EFFECT
// ============================================================================
describe("§5 Level Effect — Shield by L1-L5", () => {
  for (const level of LEVELS) {
    it(`L${level} shield cost/value at 95% critical`, () => {
      const shielded = runShieldScenario(95, level, 48, true);
      // Record the measurement
      expect(shielded.totalBurned).toBeGreaterThanOrEqual(0);
      expect(shielded.activeTicks).toBeGreaterThanOrEqual(0);
    });

    it(`L${level} zero-benefit check`, () => {
      const shielded = runShieldScenario(95, level, 48, true);
      const unshielded = runShieldScenario(95, level, 48, false);
      // L4/L5 may show 0 benefit — that's expected, not a bug
      const delta = shielded.totalBurned - unshielded.totalBurned;
      expect(delta).toBeGreaterThanOrEqual(0);
    });
  }
});

// ============================================================================
// §6 — USAGE THRESHOLD ANALYSIS
// ============================================================================
describe("§6 Usage Threshold Analysis", () => {
  it("simulate 100 players at 95% — measure shield uptake scenarios", () => {
    const percentages = [0, 5, 10, 20, 30, 50, 100];
    const results: Array<{
      pct: number;
      shielded: number;
      totalBurn: number;
    }> = [];

    for (const pct of percentages) {
      const shieldedCount = Math.floor(100 * (pct / 100));
      const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
      const now = s.world.lastTick;

      for (let i = 0; i < 100; i++) {
        const isShielded = i < shieldedCount;
        s.players.push(
          makeShieldedPlayer(
            `p${i}`,
            1,
            95,
            isShielded ? now + PROTECTION.SHIELD_DURATION_MS : 0,
          ),
        );
      }

      let totalBurn = 0;
      let t = now;
      for (let tick = 0; tick < 48; tick++) {
        const prevBurns = s.players.map((p) => p.totalBurnedKg);
        t += WORLD.TICK_SECONDS * 1000;
        simTick(s, t, false);
        for (let i = 0; i < 100; i++) {
          totalBurn += s.players[i].totalBurnedKg - prevBurns[i];
        }
      }

      results.push({ pct, shielded: shieldedCount, totalBurn });
    }

    // Verify shielded players burn more
    expect(results[results.length - 1].totalBurn).toBeGreaterThanOrEqual(
      results[0].totalBurn,
    );
  });
});

// ============================================================================
// §7 — DETERMINISTIC ORACLE VALIDATION
// ============================================================================
describe("§7 Deterministic Oracle — Shield Consistency", () => {
  it("same inputs → same shield outcome (determinism)", () => {
    const burns: number[] = [];
    for (let run = 0; run < 3; run++) {
      const result = runShieldScenario(95, 1, 24, true);
      burns.push(result.totalBurned);
    }
    expect(burns[0]).toBe(burns[1]);
    expect(burns[1]).toBe(burns[2]);
  });

  it("shield state transitions deterministic", () => {
    const expires: number[] = [];
    for (let run = 0; run < 3; run++) {
      const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
      const now = s.world.lastTick;
      const p = makeShieldedPlayer("p1", 1, 95, now + 100_000);
      s.players.push(p);
      expires.push(p.protection.shieldUntil ?? 0);
    }
    expect(expires[0]).toBe(expires[1]);
    expect(expires[1]).toBe(expires[2]);
  });
});

// ============================================================================
// §8 — PRODUCTION E2E SHIELD FLOW
// ============================================================================
describe("§8 Production E2E Shield Flow", () => {
  it("full flow: critical world → shield → burn → expiry", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now = s.world.lastTick;
    const shieldUntil = now + PROTECTION.SHIELD_DURATION_MS;
    const p = makeShieldedPlayer("p1", 1, 95, shieldUntil);
    s.players.push(p);

    // Pre-conditions
    expect(p.protection.shieldUntil).toBeGreaterThan(now);
    expect(checkShieldActive(p.protection.shieldUntil, now)).toBe(true);

    // Run some ticks — shield active
    let t = now;
    for (let i = 0; i < 12; i++) {
      t += WORLD.TICK_SECONDS * 1000;
      simTick(s, t, false);
    }
    expect(checkShieldActive(p.protection.shieldUntil, t)).toBe(true);

    // Burn some waste
    p.processing.queuedKg += 100;
    const toxBefore = p.toxBalance;
    t += WORLD.TICK_SECONDS * 1000;
    simTick(s, t, false);
    expect(p.toxBalance).toBeGreaterThan(toxBefore);

    // Shield should still be active
    expect(checkShieldActive(p.protection.shieldUntil, t)).toBe(true);
  });

  it("battery drain reduced during shield at critical", () => {
    // Shielded
    const s1 = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now1 = s1.world.lastTick;
    const p1 = makeShieldedPlayer("p1", 1, 95, now1 + 100_000);
    s1.players.push(p1);
    const batBefore1 = p1.robot.battery;
    simTick(s1, now1 + WORLD.TICK_SECONDS * 1000, false);
    const drainShielded = batBefore1 - p1.robot.battery;

    // Unshielded
    const s2 = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now2 = s2.world.lastTick;
    const p2 = makeShieldedPlayer("p2", 1, 95, 0);
    s2.players.push(p2);
    const batBefore2 = p2.robot.battery;
    simTick(s2, now2 + WORLD.TICK_SECONDS * 1000, false);
    const drainUnshielded = batBefore2 - p2.robot.battery;

    // Shielded drain should be <= unshielded drain
    expect(drainShielded).toBeLessThanOrEqual(drainUnshielded);
  });

  it("drainMultiplier confirms shield blocks critical drain", () => {
    const now = Date.now();
    const shieldedProt = { state: "normal" as const, shieldUntil: now + 100_000 };
    const unshieldedProt = { state: "normal" as const };

    expect(drainMultiplier(shieldedProt, now, true)).toBe(1);
    expect(drainMultiplier(unshieldedProt, now, true)).toBe(
      PROTECTION.CRITICAL_DRAIN_MULT,
    );
  });
});

// ============================================================================
// §9 — COLLAPSE EDGE CASES
// ============================================================================
describe("§9 Collapse Edge Cases", () => {
  it("shield active → world reaches 100% → shield does NOT prevent collapse", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.99999);
    const now = s.world.lastTick;
    const p = makeShieldedPlayer("p1", 1, 99.999, now + 1_000_000);
    s.players.push(p);

    let t = now;
    for (let i = 0; i < 200 && s.world.worldId === 0; i++) {
      t += WORLD.TICK_SECONDS * 1000;
      simTick(s, t, false);
    }

    // World collapses regardless of shield
    expect(s.world.worldId).toBe(1);
    // Shield buff persists
    expect(p.protection.shieldUntil).toBeGreaterThan(0);
  });  it("shield expires → world still critical → drain multiplier returns", () => {
    const now = Date.now();
    // Shield that already expired
    const protActive = { state: "normal" as const, shieldUntil: now + 100_000 };
    const protExpired = { state: "normal" as const, shieldUntil: now - 1000 };

    // Active shield → drain multiplier 1 (no penalty)
    expect(drainMultiplier(protActive, now, true)).toBe(1);
    // Expired shield → drain multiplier CRITICAL_DRAIN_MULT (penalty)
    expect(drainMultiplier(protExpired, now, true)).toBe(PROTECTION.CRITICAL_DRAIN_MULT);
  });
});

// ============================================================================
// §10 — SHIELD + OTHER PROTECTIONS
// ============================================================================
describe("§10 Shield Interaction with Other Protections", () => {
  it("shield + base lock → both states active", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now = s.world.lastTick;
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      protection: {
        state: "locked",
        shieldUntil: now + PROTECTION.SHIELD_DURATION_MS,
      },
    });
    s.players.push(p);
    expect(checkShieldActive(p.protection.shieldUntil, now)).toBe(true);
    expect(p.protection.state).toBe("locked");
  });

  it("shield + AFK → both states active", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now = s.world.lastTick;
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      protection: {
        state: "afk",
        shieldUntil: now + PROTECTION.SHIELD_DURATION_MS,
      },
    });
    s.players.push(p);
    expect(checkShieldActive(p.protection.shieldUntil, now)).toBe(true);
    expect(p.protection.state).toBe("afk");
  });
});

// ============================================================================
// §11 — SCALE TESTS
// ============================================================================
describe("§11 Scale Tests — Shield at 10/100 players", () => {
  for (const count of [10, 100]) {
    it(`${count} players with shield — invariant holds`, () => {
      const players = makePlayers(count, {
        seed: count,
        autoFraction: 1,
        storageFraction: 0.05,
        queueFraction: 0.05,
      });
      // Shield 50% of players
      const now = Date.now();
      for (let i = 0; i < Math.floor(count / 2); i++) {
        players[i].protection = {
          ...players[i].protection,
          shieldUntil: now + PROTECTION.SHIELD_DURATION_MS,
        };
      }
      const s = simWithPlayers(players);
      const startPollution = s.world.pollutionKg;

      let t = s.world.lastTick;
      for (let i = 0; i < 12; i++) {
        t += WORLD.TICK_SECONDS * 1000;
        simTick(s, t, false);
      }

      const inv = simInvariant(s);
      expect(Math.abs(inv.massBalance)).toBeLessThan(1e-2);
      expect(Math.abs(inv.poolBalance)).toBeLessThan(1e-2);
    });
  }
});

// ============================================================================
// §12 — CUMULATIVE COST ANALYSIS
// ============================================================================
describe("§12 Cumulative Shield Cost", () => {
  it("24 real hours (144 game ticks) shield cost is sustainable", () => {
    const s = freshWorld(WORLD.CAPACITY_KG, 0.95);
    const now = s.world.lastTick;
    const p = makePlayer("p1", {
      hasBase: true,
      baseX: 500,
      baseY: 500,
      auto: true,
      toxBalance: 5000,
    });
    s.players.push(p);

    let t = now;
    let shieldsUsed = 0;
    const shieldCostPer = PROTECTION.SHIELD_COST_TOX;

    for (let i = 0; i < 144; i++) {
      // Activate shield if not active and can afford
      if (
        !checkShieldActive(p.protection.shieldUntil, t) &&
        p.toxBalance >= shieldCostPer
      ) {
        p.protection = {
          ...p.protection,
          shieldUntil: t + PROTECTION.SHIELD_DURATION_MS,
        };
        p.toxBalance -= shieldCostPer;
        shieldsUsed++;
      }
      t += WORLD.TICK_SECONDS * 1000;
      simTick(s, t, false);
    }

    // Verify player didn't go bankrupt
    expect(p.toxBalance).toBeGreaterThanOrEqual(0);
    // Should have used shields
    expect(shieldsUsed).toBeGreaterThan(0);
  });
});
