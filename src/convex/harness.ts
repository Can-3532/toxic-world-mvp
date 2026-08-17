// TOXIC WORLD — PRODUCTION ENGINE TEST HARNESS (Sprint 2.4 audit, Sprint 2.5
// clean-world tooling). Read-only live audit against the deployed engine; the
// heavy automated scenarios live in tests/engineSim.ts + tests/engine.test.ts
// (headless oracle driven by the same pure engine module).
//
// Usage:
//   bunx convex run harness:invariantAudit    — two-layer invariant on live DB
//   bunx convex run harness:reanchorInvariant — one-time legacy repair (2.4)
//   bunx convex run harness:resetWorld        — pristine World 0 baseline (2.5)

import { mutation, query } from "./_generated/server";
import { checkWasteInvariant, pollutionFrac } from "./engine";
import { batteryCap } from "./game";
import { BURN_ZONE, BURN_ZONE_MULTIPLIER, WORLD } from "./gameParams";
import { seedWorld } from "./world";

export const invariantAudit = query({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    if (!world) return null;

    const [players, clusters, zone] = await Promise.all([
      ctx.db
        .query("players")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
      ctx.db
        .query("wasteClusters")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
      ctx.db
        .query("burnZones")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .first(),
    ]);

    const sums = players.reduce(
      (acc, p) => ({
        cargoKg: acc.cargoKg + p.robot.cargoKg,
        storageKg: acc.storageKg + p.storageKg,
        processingKg: acc.processingKg + p.processing.queuedKg,
      }),
      { cargoKg: 0, storageKg: 0, processingKg: 0 },
    );

    const invariant = checkWasteInvariant({
      // legacy worlds: re-anchor to total waste ever (pollution + burned)
      initialWasteKg:
        world.seedPollutionKg ?? world.pollutionKg + world.burnedKg,
      generatedKg: world.generatedKg ?? 0,
      pollutionKg: world.pollutionKg,
      burnedKg: world.burnedKg,
      hiddenKg: world.hiddenKg,
      collectableKg: world.collectableKg,
      clusterKg: clusters.reduce((s, c) => s + c.kg, 0),
      ...sums,
    });

    return {
      worldId: world.worldId,
      status: world.status,
      pollutionFrac: pollutionFrac(world.pollutionKg, world.capacityKg),
      invariant,
      skewKg: Math.max(
        Math.abs(invariant.massBalance),
        Math.abs(invariant.poolBalance),
      ),
      lastTickSkewKg: world.invariantSkewKg ?? null,
      players: players.length,
      clusters: clusters.length,
      zone: zone?.status ?? null,
    };
  },
});

/**
 * QA-ONLY, one-time repair for worlds created before Sprint 2.4: the invariant
 * telemetry fields (seedPollutionKg / generatedKg) did not exist, so the mass
 * balance reads the pre-telemetry burned waste as skew. Re-anchor from first
 * principles: seed = capacity × initial fraction, generated = pollution +
 * burned − seed (derived from the mass balance itself), which makes both
 * invariants exactly 0 going forward. Does NOT touch game state.
 *
 * Usage:  bunx convex run harness:reanchorInvariant
 */
export const reanchorInvariant = mutation({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    if (!world) return { ok: false, reason: "no world" };
    const seedPollutionKg =
      world.capacityKg *
      (world.resetCount === 0
        ? WORLD.INITIAL_POLLUTION_FRAC
        : WORLD.RESET_POLLUTION_FRAC);
    const generatedKg =
      world.pollutionKg + world.burnedKg - seedPollutionKg;
    await ctx.db.patch(world._id, {
      seedPollutionKg,
      generatedKg,
      invariantSkewKg: 0,
    });
    return {
      ok: true,
      seedPollutionKg,
      generatedKg,
      burnedKg: world.burnedKg,
      pollutionKg: world.pollutionKg,
    };
  },
});

/**
 * SPRINT 2.5 — CLEAN WORLD RESET (QA tool). Re-creates World 0 from scratch:
 * capacity 10,000 t, pollution 50%, collectable 10%, generated 0, burned 0,
 * zero legacy residual. Wipes world doc, waste clusters, event feed and burn
 * zone, and zeroes player-held waste (cargo / storage / processing) so both
 * invariant layers start at exactly 0. Player accounts, bases, balances and
 * upgrade levels are preserved.
 *
 * From this point all benchmarks run against this pristine baseline.
 *
 * Usage:  bunx convex run harness:resetWorld
 */
export const resetWorld = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // wipe world-level state
    for (const w of await ctx.db.query("worlds").collect()) {
      await ctx.db.delete(w._id);
    }
    for (const c of await ctx.db.query("wasteClusters").collect()) {
      await ctx.db.delete(c._id);
    }
    for (const e of await ctx.db.query("worldEvents").collect()) {
      await ctx.db.delete(e._id);
    }
    for (const z of await ctx.db.query("burnZones").collect()) {
      await ctx.db.delete(z._id);
    }

    // zero player-held waste (part of the recoverable pool) — keep accounts
    const players = await ctx.db.query("players").collect();
    for (const p of players) {
      const bx = p.baseX ?? WORLD.MAP_SIZE / 2;
      const by = p.baseY ?? WORLD.MAP_SIZE / 2;
      await ctx.db.patch(p._id, {
        worldId: 0,
        storageKg: 0,
        processing: {
          queuedKg: 0,
          since: now,
          sessionId: undefined,
          sliceIndex: 0,
        },
        robot: {
          ...p.robot,
          state: "idle",
          targetClusterId: undefined,
          x: bx,
          y: by,
          fromX: bx,
          fromY: by,
          cargoKg: 0,
          battery: batteryCap(p),
        },
      });
    }

    // pristine World 0 (seedWorld = the same clean baseline the tick uses)
    const world = await seedWorld(ctx, now);
    await ctx.db.insert("burnZones", {
      worldId: 0,
      status: "inactive",
      x: 0,
      y: 0,
      spawnedAt: 0,
      expiresAt: 0,
      nextSpawnAt:
        now +
        (BURN_ZONE.MIN_COOLDOWN_S +
          Math.random() * (BURN_ZONE.MAX_COOLDOWN_S - BURN_ZONE.MIN_COOLDOWN_S)) *
          1000,
      multiplier: BURN_ZONE_MULTIPLIER,
    });

    return {
      ok: true,
      worldId: world.worldId,
      capacityKg: world.capacityKg,
      pollutionKg: world.pollutionKg,
      collectableKg: world.collectableKg,
      hiddenKg: world.hiddenKg,
      generatedKg: world.generatedKg,
      burnedKg: world.burnedKg,
      pollutionFrac: (world.pollutionKg / world.capacityKg) * 100,
      invariantSkewKg: 0,
      playersKept: players.length,
      clustersReseeded: WORLD.ACTIVE_CLUSTER_TARGET,
    };
  },
});
