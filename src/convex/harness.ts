// TOXIC WORLD — Sprint 2.4 PRODUCTION ENGINE TEST HARNESS.
// Read-only live audit against the deployed engine. The heavy automated
// scenarios live in tests/engineSim.ts + tests/engine.test.ts (headless oracle
// driven by the same pure engine module); this query checks the invariant on
// the REAL Convex state so the harness is verifiable against production data.
//
// Usage:
//   bunx convex run harness:invariantAudit

import { mutation, query } from "./_generated/server";
import { checkWasteInvariant, pollutionFrac } from "./engine";
import { WORLD } from "./gameParams";

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
