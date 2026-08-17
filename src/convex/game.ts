import { v } from "convex/values";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { ROBOT, UPGRADES, WORLD, batteryForTrip } from "./gameParams";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function getPlayer(ctx: QueryCtx | MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  return await ctx.db
    .query("players")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .first();
}

export const cargoCap = (p: Doc<"players">) =>
  UPGRADES.cargo.caps[p.levels.cargo - 1];
export const storageCap = (p: Doc<"players">) =>
  UPGRADES.storage.caps[p.levels.storage - 1];
export const batteryCap = (p: Doc<"players">) =>
  UPGRADES.battery.caps[p.levels.battery - 1];

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

/**
 * Ensures a player record exists for the signed-in user.
 * Grants the genesis demo credit (0.1 SOL) so the full loop is playable.
 */
export const ensurePlayer = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not signed in");

    const existing = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    if (existing) return { ok: true, created: false };

    const world = await ctx.db.query("worlds").first();
    const worldId = world?.worldId ?? 0;
    const cx = WORLD.MAP_SIZE / 2;

    const id = await ctx.db.insert("players", {
      userId: user._id,
      worldId,
      name: user.name ?? undefined,
      hasBase: false,
      solBalance: WORLD.GENESIS_GRANT_SOL, // MOCK — for the base purchase only
      toxBalance: 0,
      genesisGrant: true,
      totalCollectedKg: 0,
      totalBurnedKg: 0,
      totalEarnedSol: 0, // DEPRECATED (v0.3) — burn no longer pays SOL
      toxFromNormal: 0,
      toxFromZone: 0,
      storageKg: 0,
      processing: { queuedKg: 0, since: 0, sessionId: undefined, sliceIndex: 0 },
      levels: { cargo: 1, recharge: 1, battery: 1, storage: 1 },
      robot: {
        state: "idle",
        x: cx,
        y: cx,
        fromX: cx,
        fromY: cx,
        departAt: 0,
        battery: UPGRADES.battery.caps[0],
        cargoKg: 0,
        auto: true,
        totalTrips: 0,
      },
    });
    return { ok: true, created: true, playerId: id };
  },
});

/** Purchase the starter base for 0.1 SOL and deploy the robot. */
export const buyBase = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found — retry");
    if (p.hasBase) throw new Error("Base already deployed");
    if (p.solBalance < WORLD.BASE_PRICE_SOL)
      throw new Error(`Base costs ${WORLD.BASE_PRICE_SOL} SOL`);

    const pad = 120;
    const x = pad + Math.floor(Math.random() * (WORLD.MAP_SIZE - 2 * pad));
    const y = pad + Math.floor(Math.random() * (WORLD.MAP_SIZE - 2 * pad));

    await ctx.db.patch(p._id, {
      hasBase: true,
      baseX: x,
      baseY: y,
      solBalance: p.solBalance - WORLD.BASE_PRICE_SOL,
      robot: {
        ...p.robot,
        x,
        y,
        fromX: x,
        fromY: y,
        battery: batteryCap(p),
        state: "idle",
      },
    });
    return { ok: true, baseX: x, baseY: y };
  },
});

/** Command the idle robot to collect from a specific cluster (Batch/Reservation). */
export const commandRobot = mutation({
  args: { clusterId: v.id("wasteClusters") },
  handler: async (ctx, { clusterId }) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    const r = p.robot;
    if (r.state !== "idle") throw new Error("Robot is busy");
    if (r.cargoKg >= cargoCap(p)) throw new Error("Cargo full — unload at base first");

    const cluster = await ctx.db.get(clusterId);
    if (!cluster || cluster.kg <= 0) throw new Error("Cluster depleted");
    if (cluster.reservedBy) throw new Error("Cluster already reserved by another robot");
    if (cluster.worldId !== p.worldId) throw new Error("Cluster is not in your world");

    const now = Date.now();
    const dist = Math.hypot(r.x - cluster.x, r.y - cluster.y);
    const travelMs = (dist / ROBOT.SPEED_M_S) * 1000;

    await ctx.db.patch(cluster._id, { reservedBy: p._id, reservedAt: now });
    await ctx.db.patch(p._id, {
      robot: {
        ...r,
        state: "to_cluster",
        targetClusterId: cluster._id,
        fromX: r.x,
        fromY: r.y,
        departAt: now,
        arriveAt: now + travelMs,
      },
    });
    return { ok: true, travelMs };
  },
});

/** Toggle autonomous collection mode. */
export const toggleAuto = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    const auto = !p.robot.auto;
    await ctx.db.patch(p._id, { robot: { ...p.robot, auto } });
    return { ok: true, auto };
  },
});

/** Move everything in storage into the burner queue (starts a reward session). */
export const queueProcessing = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (p.storageKg <= 0) throw new Error("Storage is empty");
    const now = Date.now();
    const hasSession = p.processing.queuedKg > 0 && !!p.processing.sessionId;
    const queuedKg = p.processing.queuedKg + p.storageKg;
    await ctx.db.patch(p._id, {
      storageKg: 0,
      processing: {
        queuedKg,
        since: hasSession ? p.processing.since : now,
        // one reward session per queue; appending keeps the same id so the
        // reward ledger keys stay unique per waste unit
        sessionId: hasSession ? p.processing.sessionId : `${p._id}:${now}`,
        sliceIndex: hasSession ? p.processing.sliceIndex : 0,
      },
    });
    return { ok: true, queuedKg };
  },
});

/** Buy the next level of an upgrade track with TOX. */
export const upgrade = mutation({
  args: {
    track: v.union(
      v.literal("cargo"),
      v.literal("recharge"),
      v.literal("battery"),
      v.literal("storage"),
    ),
  },
  handler: async (ctx, { track }) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");

    const level = p.levels[track];
    if (level >= 5) throw new Error("Max level reached");
    const cfg = UPGRADES[track];
    const cost = cfg.costs[level];
    if (p.toxBalance < cost) throw new Error(`Need ${cost} TOX`);

    const levels = { ...p.levels, [track]: level + 1 };
    const patch: {
      toxBalance: number;
      levels: typeof levels;
      robot?: typeof p.robot;
    } = { toxBalance: p.toxBalance - cost, levels };

    if (track === "battery") {
      const oldCap = UPGRADES.battery.caps[level - 1];
      const newCap = UPGRADES.battery.caps[level];
      patch.robot = {
        ...p.robot,
        battery: Math.min(newCap, p.robot.battery + (newCap - oldCap)),
      };
    }

    await ctx.db.patch(p._id, patch);
    return { ok: true, level: level + 1 };
  },
});

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

/** Current player state (includes robot, storage, balances). */
export const me = query({
  args: {},
  handler: async (ctx) => getPlayer(ctx),
});

/** Top collectors of the world, by kg burned (v0.4: TOX progression metrics). */
export const leaderboard = query({
  args: {},
  handler: async (ctx) => {
    const players = await ctx.db.query("players").collect();
    return players
      .filter((p) => p.hasBase)
      .sort((a, b) => b.totalBurnedKg - a.totalBurnedKg)
      .slice(0, 10)
      .map((p) => ({
        name: p.name ?? "Scavenger",
        burnedKg: p.totalBurnedKg,
        toxEarned: (p.toxFromNormal ?? 0) + (p.toxFromZone ?? 0),
        worldId: p.worldId,
        // DEPRECATED (v0.3) — legacy leaderboard field, always 0 under v0.4
        earnedSol: p.totalEarnedSol ?? 0,
      }));
  },
});
