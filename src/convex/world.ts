import { v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  REPLENISHMENT,
  ROBOT,
  UPGRADES,
  WORLD,
  SOL_PER_KG,
  batteryForTrip,
} from "./gameParams";
import { batteryCap, cargoCap, storageCap } from "./game";

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60; // game hours per tick

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function formatKg(kg: number): string {
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${Math.round(kg)} kg`;
}

async function addEvent(
  ctx: MutationCtx,
  worldId: number,
  type: string,
  message: string,
) {
  await ctx.db.insert("worldEvents", { worldId, type, message, at: Date.now() });
  const all = await ctx.db
    .query("worldEvents")
    .withIndex("by_world", (q) => q.eq("worldId", worldId))
    .collect();
  if (all.length > 60) {
    const sorted = [...all].sort((a, b) => a.at - b.at);
    for (const old of sorted.slice(0, all.length - 60)) {
      await ctx.db.delete(old._id);
    }
  }
}

async function spawnClusters(
  ctx: MutationCtx,
  worldId: number,
  availableKg: number,
  target: number,
  current: number,
): Promise<number> {
  let remaining = availableKg;
  let spawned = 0;
  while (
    current + spawned < target &&
    remaining >= WORLD.CLUSTER_MIN_KG &&
    spawned < WORLD.MAX_CLUSTER_SPAWNS_PER_TICK
  ) {
    const size = Math.min(
      WORLD.CLUSTER_MIN_KG +
        Math.random() * (WORLD.CLUSTER_MAX_KG - WORLD.CLUSTER_MIN_KG),
      remaining,
    );
    await ctx.db.insert("wasteClusters", {
      worldId,
      x: Math.random() * WORLD.MAP_SIZE,
      y: Math.random() * WORLD.MAP_SIZE,
      kg: size,
    });
    remaining -= size;
    spawned += 1;
  }
  return remaining;
}

async function seedWorld(ctx: MutationCtx, now: number): Promise<Doc<"worlds">> {
  const pollutionKg = WORLD.CAPACITY_KG * WORLD.INITIAL_POLLUTION_FRAC;
  const collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
  const id = await ctx.db.insert("worlds", {
    worldId: 0,
    capacityKg: WORLD.CAPACITY_KG,
    pollutionKg,
    collectableKg,
    hiddenKg: pollutionKg - collectableKg,
    status: "safe",
    generationRateKgH: 0,
    demandKgH: 0,
    burnedKg: 0,
    activePlayers: 0,
    resetCount: 0,
    startedAt: now,
    lastTick: now,
  });
  const world = (await ctx.db.get(id)) as Doc<"worlds">;
  await spawnClusters(ctx, 0, world.collectableKg, WORLD.ACTIVE_CLUSTER_TARGET, 0);
  await addEvent(
    ctx,
    0,
    "spawn",
    `World 0 seeded — ${(WORLD.INITIAL_POLLUTION_FRAC * 100).toFixed(0)}% pollution, 10% collectable`,
  );
  return world;
}

// ---------------------------------------------------------------------------
// robot state machine (one player per call)
// ---------------------------------------------------------------------------

type ClusterMap = Map<Id<"wasteClusters">, Doc<"wasteClusters">>;

async function stepRobot(
  ctx: MutationCtx,
  p: Doc<"players">,
  clusterMap: ClusterMap,
  now: number,
  dtReal: number,
): Promise<boolean> {
  if (!p.hasBase) return false;
  const base = { x: p.baseX ?? WORLD.MAP_SIZE / 2, y: p.baseY ?? WORLD.MAP_SIZE / 2 };
  const r = { ...p.robot };
  const pl = { ...p };
  let demand = false;

  const bCap = batteryCap(p);
  const rechargeRate = UPGRADES.recharge.rates[p.levels.recharge - 1];
  const cCap = cargoCap(p);

  const releaseReservation = async () => {
    if (r.targetClusterId) {
      const c = clusterMap.get(r.targetClusterId);
      if (c && c.reservedBy === p._id) {
        await ctx.db.patch(c._id, { reservedBy: undefined, reservedAt: undefined });
        clusterMap.set(c._id, { ...c, reservedBy: undefined, reservedAt: undefined });
      }
      r.targetClusterId = undefined;
    }
  };

  const goHome = async (fromX: number, fromY: number) => {
    r.state = "to_base";
    r.fromX = fromX;
    r.fromY = fromY;
    r.departAt = now;
    r.arriveAt = now + (dist(base, { x: fromX, y: fromY }) / ROBOT.SPEED_M_S) * 1000;
  };

  switch (r.state) {
    case "idle": {
      // unload leftover cargo as soon as storage has room
      if (r.cargoKg > 0 && pl.storageKg < storageCap(p)) {
        const unload = Math.min(r.cargoKg, storageCap(p) - pl.storageKg);
        r.cargoKg -= unload;
        pl.storageKg += unload;
        pl.totalCollectedKg += unload;
      }
      if (r.auto && r.cargoKg < cCap) {
        let best: Doc<"wasteClusters"> | null = null;
        let bestD = Infinity;
        for (const c of clusterMap.values()) {
          if (c.kg <= 0 || c.reservedBy) continue;
          const d = dist(r, c);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (best) {
          const tripBattery = batteryForTrip(bestD);
          if (r.battery >= tripBattery) {
            await ctx.db.patch(best._id, { reservedBy: p._id, reservedAt: now });
            clusterMap.set(best._id, { ...best, reservedBy: p._id, reservedAt: now });
            r.state = "to_cluster";
            r.targetClusterId = best._id;
            r.fromX = r.x;
            r.fromY = r.y;
            r.departAt = now;
            r.arriveAt = now + (bestD / ROBOT.SPEED_M_S) * 1000;
          } else if (r.battery < bCap) {
            r.state = "recharging";
          }
        }
      }
      break;
    }
    case "to_cluster": {
      const target = r.targetClusterId ? clusterMap.get(r.targetClusterId) : undefined;
      const dest = target ?? base;
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * dtReal);
      const total = (r.arriveAt ?? now) - r.departAt;
      if (total > 0) {
        const t = Math.min(1, (now - r.departAt) / total);
        r.x = r.fromX + (dest.x - r.fromX) * t;
        r.y = r.fromY + (dest.y - r.fromY) * t;
      }
      const returnBattery =
        (dist(base, r) / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING +
        ROBOT.BATTERY_SAFETY_MARGIN;
      if (!target || target.kg <= 0 || r.battery <= returnBattery) {
        await releaseReservation();
        await goHome(r.x, r.y);
        break;
      }
      if (now >= (r.arriveAt ?? Infinity)) {
        r.x = target.x;
        r.y = target.y;
        r.state = "collecting";
        r.busyUntil = now + ROBOT.COLLECT_TIME_S * 1000;
      }
      demand = true;
      break;
    }
    case "collecting": {
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_COLLECTING * dtReal);
      if (now >= (r.busyUntil ?? now)) {
        const target = r.targetClusterId ? clusterMap.get(r.targetClusterId) : undefined;
        if (target && target.kg > 0) {
          const amount = Math.min(cCap - r.cargoKg, target.kg);
          r.cargoKg += amount;
          const newKg = target.kg - amount;
          await ctx.db.patch(target._id, { kg: newKg });
          clusterMap.set(target._id, { ...target, kg: newKg });
          if (newKg <= 0) {
            await ctx.db.delete(target._id);
            clusterMap.delete(target._id);
            await addEvent(ctx, p.worldId, "depleted", `Cluster depleted (+${formatKg(amount)})`);
          }
          r.totalTrips += 1;
        }
        await releaseReservation();
        await goHome(target ? target.x : r.x, target ? target.y : r.y);
      }
      demand = true;
      break;
    }
    case "to_base": {
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * dtReal);
      const total = (r.arriveAt ?? now) - r.departAt;
      if (total > 0) {
        const t = Math.min(1, (now - r.departAt) / total);
        r.x = r.fromX + (base.x - r.fromX) * t;
        r.y = r.fromY + (base.y - r.fromY) * t;
      }
      if (now >= (r.arriveAt ?? Infinity)) {
        r.x = base.x;
        r.y = base.y;
        r.state = "unloading";
        r.busyUntil = now + ROBOT.UNLOAD_TIME_S * 1000;
      }
      demand = true;
      break;
    }
    case "unloading": {
      if (now >= (r.busyUntil ?? now)) {
        const space = storageCap(p) - pl.storageKg;
        const unload = Math.min(r.cargoKg, space);
        pl.storageKg += unload;
        pl.totalCollectedKg += unload;
        r.cargoKg -= unload;
        r.state =
          r.battery < bCap * ROBOT.LOW_BATTERY_FRAC ? "recharging" : "idle";
      }
      break;
    }
    case "recharging": {
      r.battery = Math.min(bCap, r.battery + rechargeRate * dtReal);
      if (r.battery >= bCap) {
        r.battery = bCap;
        r.state = "idle";
      }
      break;
    }
  }

  await ctx.db.patch(p._id, {
    storageKg: pl.storageKg,
    totalCollectedKg: pl.totalCollectedKg,
    robot: r,
  });
  return demand;
}

// ---------------------------------------------------------------------------
// the world tick (driven by cron)
// ---------------------------------------------------------------------------

export const tick = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const dtReal = WORLD.TICK_SECONDS;

    let world = await ctx.db.query("worlds").first();
    if (!world) {
      world = await seedWorld(ctx, now);
    }
    // rate-limit: the world may only advance once per tick window, so a
    // client hammering this mutation cannot accelerate the simulation
    if (now - world.lastTick < WORLD.TICK_SECONDS * 1000 * 0.8) return;
    const worldId = world.worldId;

    const players = await ctx.db
      .query("players")
      .withIndex("by_world", (q) => q.eq("worldId", worldId))
      .collect();
    const clusterList = await ctx.db
      .query("wasteClusters")
      .withIndex("by_world", (q) => q.eq("worldId", worldId))
      .collect();
    const clusterMap: ClusterMap = new Map(
      clusterList.map((c) => [c._id, c]),
    );

    // 1) base generation → pollution
    const active = players.filter((p) => p.hasBase);
    const genKgH = active.length * WORLD.BASE_GEN_KG_H;
    let pollutionKg = Math.min(
      world.capacityKg,
      world.pollutionKg + genKgH * TICK_GAME_H,
    );

    // 2) robots
    let demandKgH = 0;
    for (const p of players) {
      const isActive = await stepRobot(ctx, p, clusterMap, now, dtReal);
      if (isActive) demandKgH += WORLD.DEMAND_REF_KG_H;
    }

    // release stale reservations (robot no longer targeting its cluster)
    for (const c of clusterMap.values()) {
      if (!c.reservedBy) continue;
      const owner = players.find((p) => p._id === c.reservedBy);
      const stillTargeting =
        owner &&
        owner.robot.targetClusterId === c._id &&
        (owner.robot.state === "to_cluster" || owner.robot.state === "collecting");
      if (!stillTargeting) {
        await ctx.db.patch(c._id, { reservedBy: undefined, reservedAt: undefined });
        clusterMap.set(c._id, { ...c, reservedBy: undefined, reservedAt: undefined });
      }
    }

    // 3) dynamic replenishment — Model C
    const ratio = genKgH > 0 ? demandKgH / genKgH : 0;
    const replFracH = Math.min(
      REPLENISHMENT.MAX_FRAC,
      Math.max(REPLENISHMENT.MIN_FRAC, REPLENISHMENT.BASE_FRAC * ratio),
    );
    const unlockKg = Math.min(world.hiddenKg, world.hiddenKg * replFracH * TICK_GAME_H);
    let collectableKg = world.collectableKg + unlockKg;
    let hiddenKg = world.hiddenKg - unlockKg;

    // 4) keep the map stocked with clusters
    collectableKg = await spawnClusters(
      ctx,
      worldId,
      collectableKg,
      WORLD.ACTIVE_CLUSTER_TARGET,
      clusterMap.size,
    );

    // 5) processing / burning → rewards
    let burnedKg = world.burnedKg;
    for (const p of players) {
      if (p.processing.queuedKg <= 0) continue;
      const burn = Math.min(
        p.processing.queuedKg,
        WORLD.PROCESSING_KG_PER_S * dtReal,
      );
      const queuedKg = p.processing.queuedKg - burn;
      const sol = burn * SOL_PER_KG;
      const tox = burn * WORLD.TOX_PER_KG;
      await ctx.db.patch(p._id, {
        processing: { queuedKg, since: p.processing.since },
        solBalance: p.solBalance + sol,
        toxBalance: p.toxBalance + tox,
        totalBurnedKg: p.totalBurnedKg + burn,
        totalEarnedSol: p.totalEarnedSol + sol,
      });
      burnedKg += burn;
      if (queuedKg === 0) {
        await addEvent(ctx, worldId, "burn", `Burn complete — ${sol.toFixed(6)} SOL settled`);
      }
    }

    // 6) world status / collapse
    let status: Doc<"worlds">["status"] =
      pollutionKg >= world.capacityKg
        ? "collapsed"
        : pollutionKg / world.capacityKg >= WORLD.CRITICAL_FRAC
          ? "critical"
          : "safe";
    let newWorldId = worldId;
    if (pollutionKg >= world.capacityKg) {
      await addEvent(
        ctx,
        worldId,
        "collapse",
        "💀 WORLD COLLAPSE — pollution hit 100%. World resets at 22.5%.",
      );
      newWorldId = worldId + 1;
      for (const c of clusterMap.values()) {
        await ctx.db.delete(c._id);
      }
      clusterMap.clear();
      pollutionKg = world.capacityKg * WORLD.RESET_POLLUTION_FRAC;
      collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
      hiddenKg = pollutionKg - collectableKg;
      status = "safe";
      for (const p of players) {
        const bx = p.baseX ?? WORLD.MAP_SIZE / 2;
        const by = p.baseY ?? WORLD.MAP_SIZE / 2;
        await ctx.db.patch(p._id, {
          worldId: newWorldId,
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
      await spawnClusters(ctx, newWorldId, collectableKg, WORLD.ACTIVE_CLUSTER_TARGET, 0);
      await addEvent(ctx, newWorldId, "spawn", `World ${newWorldId} seeded — fresh pool unlocked`);
    }

    await ctx.db.patch(world._id, {
      worldId: newWorldId,
      pollutionKg,
      collectableKg,
      hiddenKg,
      status,
      generationRateKgH: genKgH,
      demandKgH,
      burnedKg,
      activePlayers: active.length,
      resetCount: world.resetCount + (newWorldId !== worldId ? 1 : 0),
      lastTick: now,
    });
  },
});

// ---------------------------------------------------------------------------
// queries (public — used by landing page and game)
// ---------------------------------------------------------------------------

export const worldState = query({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    if (!world) return null;
    const [clusters, players] = await Promise.all([
      ctx.db
        .query("wasteClusters")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
      ctx.db
        .query("players")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
    ]);
    return {
      world,
      clusterCount: clusters.length,
      activePlayers: players.filter((p) => p.hasBase).length,
      totalPlayers: players.length,
    };
  },
});

export const clusters = query({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    if (!world) return [];
    return ctx.db
      .query("wasteClusters")
      .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
      .collect();
  },
});

export const events = query({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worlds").first();
    if (!world) return [];
    const all = await ctx.db
      .query("worldEvents")
      .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
      .collect();
    return all
      .sort((a, b) => b.at - a.at)
      .slice(0, 40)
      .map((e) => ({ type: e.type, message: e.message, at: e.at }));
  },
});
