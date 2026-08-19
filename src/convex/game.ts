import { v } from "convex/values";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { getCurrentUser } from "./users";
import { MANUAL, PROTECTION, ROBOT, UPGRADES, WORLD, batteryForTrip } from "./gameParams";
import { isSealed, onActivity } from "./protection";

const SEALED_MSG = "Base is sealed (locked or launching) — unlock it first";

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
    const now = Date.now();

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
      // Sprint 2.11 — protection systems (defaults: NORMAL, active now)
      lastActiveAt: now,
      protection: { state: "normal" },
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
      // Sprint 2.13 — manual driving mode (default OFF for new players)
      manual: false,
      shipping: { active: false, kg: 0, startAt: 0, finishAt: 0 },
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

    const now = Date.now();
    await ctx.db.patch(p._id, {
      hasBase: true,
      baseX: x,
      baseY: y,
      solBalance: p.solBalance - WORLD.BASE_PRICE_SOL,
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
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
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
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
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
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
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    const now = Date.now();
    const auto = !p.robot.auto;
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      robot: { ...p.robot, auto },
    });
    return { ok: true, auto };
  },
});

/** Move everything in storage into the burner queue (starts a reward session). */
export const queueProcessing = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    if (p.storageKg <= 0) throw new Error("Storage is empty");
    const now = Date.now();
    const hasSession = p.processing.queuedKg > 0 && !!p.processing.sessionId;
    const queuedKg = p.processing.queuedKg + p.storageKg;
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
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
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);

    const level = p.levels[track];
    if (level >= 5) throw new Error("Max level reached");
    const cfg = UPGRADES[track];
    const cost = cfg.costs[level];
    if (p.toxBalance < cost) throw new Error(`Need ${cost} TOX`);

    const now = Date.now();
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

    await ctx.db.patch(p._id, {
      ...patch,
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
    });
    return { ok: true, level: level + 1 };
  },
});

// ---------------------------------------------------------------------------
// SPRINT 2.11 — PROTECTION SYSTEMS (Lock / AFK / Shield / Emergency Launch)
// ---------------------------------------------------------------------------

/** Voluntarily seal the base (free). */
export const lockBase = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    const prot = p.protection ?? { state: "normal" };
    if (isSealed(prot.state)) throw new Error("Base is already sealed");
    const now = Date.now();
    const bx = p.baseX ?? WORLD.MAP_SIZE / 2;
    const by = p.baseY ?? WORLD.MAP_SIZE / 2;
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: {
        ...prot,
        state: "locked",
        lockedAt: now,
        lockReason: "voluntary",
      },
      robot: {
        ...p.robot,
        state: "idle",
        targetClusterId: undefined,
        x: bx,
        y: by,
        fromX: bx,
        fromY: by,
      },
    });
    return { ok: true, state: "locked" };
  },
});

/** Unseal a locked base for UNLOCK_COST_TOX. */
export const unlockBase = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    const prot = p.protection ?? { state: "normal" };
    if (prot.state !== "locked") throw new Error("Base is not locked");
    if (p.toxBalance < PROTECTION.UNLOCK_COST_TOX)
      throw new Error(`Unlock costs ${PROTECTION.UNLOCK_COST_TOX} TOX`);
    const now = Date.now();
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      toxBalance: p.toxBalance - PROTECTION.UNLOCK_COST_TOX,
      protection: {
        ...prot,
        state: "normal",
        lockedAt: undefined,
        lockReason: undefined,
      },
    });
    return { ok: true, state: "normal" };
  },
});

/** Toxic Shield */
export const activateShield = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    const prot = p.protection ?? { state: "normal" };
    if (isSealed(prot.state)) throw new Error(SEALED_MSG);
    if (p.toxBalance < PROTECTION.SHIELD_COST_TOX)
      throw new Error(`Shield costs ${PROTECTION.SHIELD_COST_TOX} TOX`);
    const now = Date.now();
    const shieldUntil = now + PROTECTION.SHIELD_DURATION_MS;
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      toxBalance: p.toxBalance - PROTECTION.SHIELD_COST_TOX,
      protection: { ...prot, shieldUntil },
    });
    return { ok: true, shieldUntil };
  },
});

/** Emergency Launch */
export const launchBase = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    const prot = p.protection ?? { state: "normal" };
    if (prot.state !== "locked") throw new Error("Only a locked base can launch");
    if (p.toxBalance < PROTECTION.LAUNCH_FEE_TOX)
      throw new Error(
        `Launch needs ${PROTECTION.LAUNCH_FEE_TOX} TOX (charged at completion)`,
      );
    const now = Date.now();
    const launchAt = now + PROTECTION.LAUNCH_WINDOW_MS;
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: { ...prot, state: "launching", launchAt },
    });
    return { ok: true, launchAt };
  },
});

/** Abort an Emergency Launch */
export const cancelLaunch = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    const prot = p.protection ?? { state: "normal" };
    if (prot.state !== "launching") throw new Error("No launch in progress");
    const now = Date.now();
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: { ...prot, state: "locked", launchAt: undefined },
    });
    return { ok: true, state: "locked" };
  },
});

// ---------------------------------------------------------------------------
// SPRINT 2.13 — MANUAL DRIVING MUTATIONS
// ---------------------------------------------------------------------------

/**
 * Toggle between auto-pilot and manual driving mode.
 * Switching to manual parks the robot (idle) and sets the manual flag.
 * Switching back to auto clears the manual flag.
 */
export const toggleManualMode = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    if (p.robot.state !== "idle") throw new Error("Robot is busy — wait for it to finish");

    const now = Date.now();
    const manual = !(p.manual ?? false);
    const bx = p.baseX ?? WORLD.MAP_SIZE / 2;
    const by = p.baseY ?? WORLD.MAP_SIZE / 2;
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      manual,
      robot: {
        ...p.robot,
        state: manual ? "driving" : "idle",
        x: manual ? p.robot.x : bx,
        y: manual ? p.robot.y : by,
        fromX: bx,
        fromY: by,
      },
    });
    return { ok: true, manual };
  },
});

/**
 * Move the robot in manual mode (called from client keyboard loop).
 * Client sends direction vector; server applies speed × dtReal and drains battery.
 */
export const moveRobotManual = mutation({
  args: {
    dx: v.number(), // -1, 0, or 1
    dy: v.number(), // -1, 0, or 1
    dtMs: v.number(), // milliseconds since last frame
  },
  handler: async (ctx, { dx, dy, dtMs }) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    if (!(p.manual ?? false)) throw new Error("Not in manual mode");
    if (p.robot.state !== "driving" && p.robot.state !== "idle")
      throw new Error("Robot is busy");
    if (p.robot.battery <= 0) throw new Error("No battery — recharge at base");

    // Normalize diagonal
    let ndx = dx;
    let ndy = dy;
    const len = Math.sqrt(ndx * ndx + ndy * ndy);
    if (len > 1) {
      ndx /= len;
      ndy /= len;
    }

    const dtSec = Math.min(dtMs / 1000, 0.2); // cap at 200ms to prevent jumps
    const distMoved = MANUAL.MOVE_SPEED * dtSec;

    let newX = p.robot.x + ndx * distMoved;
    let newY = p.robot.y + ndy * distMoved;
    // Clamp to map bounds
    newX = Math.max(0, Math.min(WORLD.MAP_SIZE, newX));
    newY = Math.max(0, Math.min(WORLD.MAP_SIZE, newY));

    const bCap = batteryCap(p);
    const drainPerSec = MANUAL.DRAIN_MOVING;
    const drain = drainPerSec * dtSec;
    const newBattery = Math.max(0, p.robot.battery - drain);

    // Check if near base for auto-unload
    const baseX = p.baseX ?? WORLD.MAP_SIZE / 2;
    const baseY = p.baseY ?? WORLD.MAP_SIZE / 2;
    const distToBase = Math.hypot(newX - baseX, newY - baseY);
    let storageKg = p.storageKg;
    let cargoKg = p.robot.cargoKg;
    let totalCollectedKg = p.totalCollectedKg;
    let state: "driving" | "idle" = "driving";

    // Auto-unload at base
    if (distToBase <= MANUAL.BASE_DEPOSIT_RANGE && cargoKg > 0) {
      const space = storageCap(p) - storageKg;
      const unload = Math.min(cargoKg, space);
      if (unload > 0) {
        cargoKg -= unload;
        storageKg += unload;
        totalCollectedKg += unload;
      }
    }

    // Auto-recharge when near base and battery low
    if (distToBase <= MANUAL.BASE_DEPOSIT_RANGE && newBattery < bCap) {
      const rechargeRate = UPGRADES.recharge.rates[p.levels.recharge - 1];
      const recharged = Math.min(bCap - newBattery, rechargeRate * dtSec);
      // (Recharge happens passively at base in manual mode)
      // Just leave battery as is — player must drive to base to recharge
    }

    const now = Date.now();
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      storageKg,
      totalCollectedKg,
      robot: {
        ...p.robot,
        state,
        x: newX,
        y: newY,
        fromX: newX,
        fromY: newY,
        departAt: now,
        battery: newBattery,
        cargoKg,
      },
    });
    return {
      ok: true,
      x: newX,
      y: newY,
      battery: newBattery,
      cargoKg,
      storageKg,
    };
  },
});

/**
 * Collect waste from a nearby cluster in manual mode.
 * Robot must be within COLLECT_RANGE of a cluster with kg > 0.
 */
export const collectManual = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    if (!(p.manual ?? false)) throw new Error("Not in manual mode");
    if (p.robot.state !== "driving") throw new Error("Robot not driving");
    if (p.robot.battery <= 0) throw new Error("No battery");
    if (p.robot.cargoKg >= cargoCap(p)) throw new Error("Cargo full");

    // Find nearest cluster within range
    const clusters = await ctx.db
      .query("wasteClusters")
      .withIndex("by_world", (q) => q.eq("worldId", p.worldId))
      .collect();

    let bestCluster: Doc<"wasteClusters"> | null = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      if (c.kg <= 0) continue;
      const d = Math.hypot(p.robot.x - c.x, p.robot.y - c.y);
      if (d < bestDist) {
        bestDist = d;
        bestCluster = c;
      }
    }

    if (!bestCluster || bestDist > MANUAL.COLLECT_RANGE) {
      throw new Error("No cluster within range");
    }

    const cCap = cargoCap(p);
    const amount = Math.min(cCap - p.robot.cargoKg, bestCluster.kg);
    const newKg = bestCluster.kg - amount;

    const now = Date.now();
    await ctx.db.patch(bestCluster._id, { kg: newKg });
    if (newKg <= 0) {
      await ctx.db.delete(bestCluster._id);
    }
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      robot: {
        ...p.robot,
        cargoKg: p.robot.cargoKg + amount,
        totalTrips: p.robot.totalTrips + 1,
      },
    });
    return { ok: true, collected: amount, remaining: newKg };
  },
});

/**
 * Drop all cargo (critical battery decision A).
 * Cargo is lost, robot becomes lighter and can return to base.
 */
export const dropCargo = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (!(p.manual ?? false)) throw new Error("Not in manual mode");
    if (p.robot.cargoKg <= 0) throw new Error("No cargo to drop");

    const droppedKg = p.robot.cargoKg;
    const now = Date.now();
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      robot: {
        ...p.robot,
        cargoKg: 0,
      },
    });
    return { ok: true, droppedKg };
  },
});

/**
 * Initiate a storage shipment (60s transit, then auto-burn).
 * All storage waste is moved into a shipment; after transit time it enters
 * the processing queue with the correct zone multiplier.
 */
export const shipStorage = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    if (p.storageKg <= 0) throw new Error("Storage is empty");
    if (p.shipping?.active) throw new Error("Shipment already in transit");

    const now = Date.now();
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      shipping: {
        active: true,
        kg: p.storageKg,
        startAt: now,
        finishAt: now + MANUAL.SHIPMENT_TRANSIT_S * 1000,
      },
      storageKg: 0,
    });
    return { ok: true, kg: p.storageKg, finishAt: now + MANUAL.SHIPMENT_TRANSIT_S * 1000 };
  },
});

/**
 * Complete a storage shipment (called by tick or manually when transit is done).
 * Moves shipped kg into the processing queue.
 */
export const completeShipment = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.shipping?.active) throw new Error("No active shipment");
    if (Date.now() < p.shipping.finishAt) throw new Error("Transit not complete yet");

    const now = Date.now();
    const hasSession = p.processing.queuedKg > 0 && !!p.processing.sessionId;
    const queuedKg = p.processing.queuedKg + p.shipping.kg;
    await ctx.db.patch(p._id, {
      processing: {
        queuedKg,
        since: hasSession ? p.processing.since : now,
        sessionId: hasSession ? p.processing.sessionId : `${p._id}:${now}`,
        sliceIndex: hasSession ? p.processing.sliceIndex : 0,
      },
      shipping: { active: false, kg: 0, startAt: 0, finishAt: 0 },
    });
    return { ok: true, queuedKg };
  },
});

/**
 * Buy Extra Battery (PLAYTEST — 50 TOX / 30 units).
 * Critical battery decision B: spend TOX to continue with cargo preserved.
 */
export const buyExtraBattery = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (!(p.manual ?? false)) throw new Error("Not in manual mode");
    if (p.toxBalance < MANUAL.EXTRA_BATTERY_COST_TOX)
      throw new Error(`Need ${MANUAL.EXTRA_BATTERY_COST_TOX} TOX`);
    if (p.robot.battery >= batteryCap(p))
      throw new Error("Battery already full");

    const now = Date.now();
    const bCap = batteryCap(p);
    const newBattery = Math.min(bCap, p.robot.battery + MANUAL.EXTRA_BATTERY_UNITS);
    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      toxBalance: p.toxBalance - MANUAL.EXTRA_BATTERY_COST_TOX,
      robot: {
        ...p.robot,
        battery: newBattery,
      },
    });
    return { ok: true, battery: newBattery, cost: MANUAL.EXTRA_BATTERY_COST_TOX };
  },
});

/**
 * Deposit cargo at an active Burn Zone for immediate burn (manual mode).
 * Burns the full cargo at the zone's ×1.2 multiplier and credits TOX.
 */
export const depositAtBurnZone = mutation({
  args: {},
  handler: async (ctx) => {
    const p = await getPlayer(ctx);
    if (!p) throw new Error("Player not found");
    if (!p.hasBase) throw new Error("Buy a base first");
    if (isSealed(p.protection?.state ?? "normal")) throw new Error(SEALED_MSG);
    if (!(p.manual ?? false)) throw new Error("Not in manual mode");
    if (p.robot.state !== "driving") throw new Error("Robot not driving");
    if (p.robot.cargoKg <= 0) throw new Error("No cargo to deposit");

    // Find the active burn zone
    const zone = await ctx.db
      .query("burnZones")
      .withIndex("by_world", (q) => q.eq("worldId", p.worldId))
      .first();
    if (!zone || zone.status !== "active") throw new Error("No active burn zone");

    // Check distance
    const dist = Math.hypot(p.robot.x - zone.x, p.robot.y - zone.y);
    if (dist > MANUAL.BURN_ZONE_RANGE)
      throw new Error(`Too far from burn zone (${Math.round(dist)}m)`);

    // Burn the cargo directly at zone multiplier
    const burnedKg = p.robot.cargoKg;
    const tox = (burnedKg / 1000) * 500 * zone.multiplier; // zone rate
    const now = Date.now();

    // Update pollution (burning removes waste from the world)
    const world = await ctx.db.query("worlds").first();
    if (world) {
      await ctx.db.patch(world._id, {
        pollutionKg: Math.max(0, world.pollutionKg - burnedKg),
        burnedKg: world.burnedKg + burnedKg,
      });
    }

    // Reward ledger entry (exactly-once)
    const sessionKey = `bz:${p._id}:${now}`;
    await ctx.db.insert("rewardLedger", {
      playerId: p._id,
      worldId: p.worldId,
      key: sessionKey,
      kind: "burn_zone",
      kg: burnedKg,
      tox,
      at: now,
    });

    await ctx.db.patch(p._id, {
      lastActiveAt: now,
      protection: onActivity(p.protection ?? { state: "normal" }),
      toxBalance: p.toxBalance + tox,
      totalBurnedKg: p.totalBurnedKg + burnedKg,
      toxFromZone: (p.toxFromZone ?? 0) + tox,
      robot: {
        ...p.robot,
        cargoKg: 0,
      },
    });
    return { ok: true, burnedKg, tox, zoneMultiplier: zone.multiplier };
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
