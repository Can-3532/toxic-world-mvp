import { v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { api } from "./_generated/api";
import { checkWasteInvariant, pollutionFrac } from "./engine";
import { batteryCap } from "./game";
import { BURN_ZONE, BURN_ZONE_MULTIPLIER, UPGRADES, WORLD } from "./gameParams";
import { runTick, seedWorld } from "./world";

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

export const resetWorld = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

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
        lastActiveAt: now,
        protection: { state: "normal" },
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
        // Sprint 2.13 — reset manual mode on clean baseline
        manual: false,
        shipping: { active: false, kg: 0, startAt: 0, finishAt: 0 },
      });
    }

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

// ---------------------------------------
// SPRINT 2.6 — LIVE-DB LOAD & CONCURRENCY HARNESS
// ---------------------------------------

const LOAD_USER_NAME = "LOAD-BENCH-USER";
const LOAD_PLAYER_NAME = "LOADTEST";

export const seedLoad = mutation({
  args: {
    count: v.number(),
    activeFraction: v.optional(v.number()),
    storageFraction: v.optional(v.number()),
    queueFraction: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const activeFraction = args.activeFraction ?? 0.5;
    const storageFraction = args.storageFraction ?? 0.3;
    const queueFraction = args.queueFraction ?? 0.2;

    let user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("name"), LOAD_USER_NAME))
      .first();
    if (!user) {
      const uid = await ctx.db.insert("users", { name: LOAD_USER_NAME });
      user = (await ctx.db.get(uid))!;
    }

    const world = await ctx.db.query("worlds").first();
    const worldId = world?.worldId ?? 0;
    const levelPool = [1, 1, 1, 2, 3, 5]; // 50% L1, ~33% L2/3, ~17% L5
    const now = Date.now();
    let created = 0;
    let seededHeldKg = 0;
    for (let i = 0; i < args.count; i++) {
      const lv = levelPool[Math.floor(Math.random() * levelPool.length)];
      const bx = 120 + Math.random() * (WORLD.MAP_SIZE - 240);
      const by = 120 + Math.random() * (WORLD.MAP_SIZE - 240);
      const storageKg =
        Math.random() < storageFraction
          ? Math.floor(Math.random() * UPGRADES.storage.caps[lv - 1])
          : 0;
      const queuedKg =
        Math.random() < queueFraction ? 10 + Math.floor(Math.random() * 40) : 0;
      seededHeldKg += storageKg + queuedKg;
      await ctx.db.insert("players", {
        userId: user._id,
        worldId,
        name: LOAD_PLAYER_NAME,
        hasBase: true,
        baseX: bx,
        baseY: by,
        solBalance: Math.random() < 0.5 ? WORLD.BASE_PRICE_SOL : 0,
        toxBalance: Math.floor(Math.random() * 300),
        genesisGrant: false,
        totalCollectedKg: 0,
        totalBurnedKg: 0,
        storageKg,
        processing: {
          queuedKg,
          since: now,
          sessionId: undefined,
          sliceIndex: 0,
        },
        levels: { cargo: lv, recharge: lv, battery: lv, storage: lv },
        lastActiveAt: now,
        protection: { state: "normal" },
        robot: {
          state: "idle",
          x: bx,
          y: by,
          fromX: bx,
          fromY: by,
          departAt: 0,
          targetClusterId: undefined,
          battery: UPGRADES.battery.caps[lv - 1],
          cargoKg: 0,
          arriveAt: undefined,
          busyUntil: undefined,
          auto: Math.random() < activeFraction,
          totalTrips: 0,
        },
        // Sprint 2.13 — load players are always auto mode
        manual: false,
        shipping: { active: false, kg: 0, startAt: 0, finishAt: 0 },
      });
      created++;
    }
    if (seededHeldKg > 0 && world) {
      await ctx.db.patch(world._id, {
        collectableKg: Math.max(0, world.collectableKg - seededHeldKg),
      });
    }
    return { created, worldId, seededHeldKg };
  },
});

export const tickOnce = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let dbReadOps = 0;
    let dbWriteOps = 0;
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        const key = String(prop);
        if (key === "insert" || key === "patch" || key === "delete") {
          return (...args: unknown[]) => {
            dbWriteOps += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args);
          };
        }
        if (key === "query" || key === "get") {
          return (...args: unknown[]) => {
            dbReadOps += 1;
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args);
          };
        }
        const v = (target as unknown as Record<string, unknown>)[key];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const t0 = performance.now();
    await runTick({ ...ctx, db } as unknown as MutationCtx, now);
    const tickMs = performance.now() - t0;
    const world = await ctx.db.query("worlds").first();
    return {
      advanced: true,
      tickMs,
      dbReadOps,
      dbWriteOps,
      world: world
        ? {
            worldId: world.worldId,
            pollutionKg: world.pollutionKg,
            generatedKg: world.generatedKg ?? 0,
            burnedKg: world.burnedKg,
            lastTick: world.lastTick,
            invariantSkewKg: world.invariantSkewKg ?? 0,
          }
        : null,
    };
  },
});

export const benchStatus = query({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    if (!world) return null;
    const [players, clusters] = await Promise.all([
      ctx.db
        .query("players")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
      ctx.db
        .query("wasteClusters")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
    ]);

    const synthetic = players.filter((p) => p.name === LOAD_PLAYER_NAME).length;
    const reserved = clusters.filter((c) => c.reservedBy);
    const ownerCounts = new Map<string, number>();
    for (const c of reserved) {
      const k = String(c.reservedBy);
      ownerCounts.set(k, (ownerCounts.get(k) ?? 0) + 1);
    }
    const dupReservations = [...ownerCounts.values()].reduce(
      (a, n) => a + Math.max(0, n - 1),
      0,
    );
    let reservationMismatch = 0;
    for (const c of reserved) {
      const owner = players.find((p) => p._id === c.reservedBy);
      if (
        !owner ||
        owner.robot.targetClusterId !== c._id ||
        (owner.robot.state !== "to_cluster" &&
          owner.robot.state !== "collecting")
      ) {
        reservationMismatch++;
      }
    }

    const sample = players
      .filter((p) => p.name === LOAD_PLAYER_NAME)
      .slice(0, 20);
    let sampledRows = 0;
    let sampledKeys = 0;
    for (const p of sample) {
      const rows = await ctx.db
        .query("rewardLedger")
        .withIndex("by_player", (q) => q.eq("playerId", p._id))
        .collect();
      sampledRows += rows.length;
      sampledKeys += new Set(rows.map((r) => r.key)).size;
    }

    const sums = players.reduce(
      (acc, p) => ({
        cargoKg: acc.cargoKg + p.robot.cargoKg,
        storageKg: acc.storageKg + p.storageKg,
        processingKg: acc.processingKg + p.processing.queuedKg,
      }),
      { cargoKg: 0, storageKg: 0, processingKg: 0 },
    );
    const invariant = checkWasteInvariant({
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
      pollutionFrac: pollutionFrac(world.pollutionKg, world.capacityKg),
      status: world.status,
      players: players.length,
      syntheticPlayers: synthetic,
      activeBases: players.filter((p) => p.hasBase).length,
      autoRobots: players.filter((p) => p.robot.auto).length,
      storageKg: sums.storageKg,
      queuedKg: sums.processingKg,
      clusters: clusters.length,
      reservedClusters: reserved.length,
      dupReservations,
      reservationMismatch,
      ledgerSample: { players: sample.length, rows: sampledRows, uniqueKeys: sampledKeys },
      massBalance: invariant.massBalance,
      poolBalance: invariant.poolBalance,
      skewKg: Math.max(Math.abs(invariant.massBalance), Math.abs(invariant.poolBalance)),
      lastTickAgeMs: Date.now() - world.lastTick,
    };
  },
});

export const cleanupLoad = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;
    const WRITE_BUDGET = 3000;
    const synth = await ctx.db
      .query("players")
      .filter((q) => q.eq(q.field("name"), LOAD_PLAYER_NAME))
      .take(limit);
    let playersDeleted = 0;
    let ledgerDeleted = 0;
    let returnedKg = 0;
    for (const p of synth) {
      const rows = await ctx.db
        .query("rewardLedger")
        .withIndex("by_player", (q) => q.eq("playerId", p._id))
        .collect();
      if (playersDeleted + ledgerDeleted + rows.length + 1 > WRITE_BUDGET) {
        break;
      }
      for (const r of rows) {
        await ctx.db.delete(r._id);
        ledgerDeleted++;
      }
      returnedKg += p.robot.cargoKg + p.storageKg + p.processing.queuedKg;
      await ctx.db.delete(p._id);
      playersDeleted++;
    }
    if (returnedKg > 0) {
      const world = await ctx.db.query("worlds").first();
      if (world) {
        await ctx.db.patch(world._id, {
          collectableKg: world.collectableKg + returnedKg,
        });
      }
    }
    const remaining = await ctx.db
      .query("players")
      .filter((q) => q.eq(q.field("name"), LOAD_PLAYER_NAME))
      .take(1);
    if (remaining.length === 0) {
      const user = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("name"), LOAD_USER_NAME))
        .first();
      if (user) await ctx.db.delete(user._id);
    }
    return {
      playersDeleted,
      ledgerDeleted,
      returnedKg,
      done: remaining.length === 0,
    };
  },
});

export const worldStateProbe = query({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    return world
      ? {
          generatedKg: world.generatedKg ?? 0,
          pollutionKg: world.pollutionKg,
          lastTick: world.lastTick,
          worldId: world.worldId,
          generationRateKgH: world.generationRateKgH,
          tickIndex: world.tickIndex ?? 0,
          activePlayers: world.activePlayers,
        }
      : {
          generatedKg: 0,
          pollutionKg: 0,
          lastTick: 0,
          worldId: 0,
          generationRateKgH: 0,
          tickIndex: 0,
          activePlayers: 0,
        };
  },
});

export const concurrencyProbe = mutation({
  args: { n: v.optional(v.number()) },
  handler: async (
    ctx,
    { n = 5 },
  ): Promise<{
    n: number;
    advanced: number;
    results: { advanced: boolean; tickMs: number }[];
  }> => {
    const results: { advanced: boolean; tickMs: number }[] = await Promise.all(
      Array.from({ length: n }, () => ctx.runMutation(api.world.tick)),
    );
    const advanced = results.filter((r) => r.advanced).length;
    return { n, advanced, results };
  },
});
