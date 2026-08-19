import { v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  BURN_ZONE,
  BURN_ZONE_MULTIPLIER,
  MANUAL,
  PROTECTION,
  ROBOT,
  UPGRADES,
  WORLD,
  batteryForTrip,
} from "./gameParams";
import {
  applyIdleCheck,
  collapseSeed,
  drainMultiplier,
  isSealed,
  keepsHeldOnCollapse,
  launchDue,
  onWorldCollapse,
  proportionalPreserve,
  type Protection,
} from "./protection";
import {
  advanceBurn,
  applyBurnToPollution,
  computeBurnSlice,
  type BurnSlice,
} from "./economy";
import {
  batchAllocation,
  checkWasteInvariant,
  replenishmentModelC,
  robotDemands,
  worldStatus,
} from "./engine";
import { batteryCap, cargoCap, storageCap } from "./game";

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60; // game hours per tick
const LEDGER_KEEP_PER_PLAYER = 500;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function formatKg(kg: number): string {
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${Math.round(kg)} kg`;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

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

/** Create the pristine World 0 (Sprint 2.5 clean baseline). */
export async function seedWorld(
  ctx: MutationCtx,
  now: number,
): Promise<Doc<"worlds">> {
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
    seedPollutionKg: pollutionKg,
    generatedKg: 0,
    invariantSkewKg: 0,
    tickIndex: 0,
    treasuryTox: PROTECTION.TREASURY_SEED_TOX,
  });
  const remaining = await spawnClusters(
    ctx,
    0,
    collectableKg,
    WORLD.ACTIVE_CLUSTER_TARGET,
    0,
  );
  await ctx.db.patch(id, { collectableKg: remaining });
  const world = (await ctx.db.get(id)) as Doc<"worlds">;
  await addEvent(
    ctx,
    0,
    "spawn",
    `World 0 seeded — ${(WORLD.INITIAL_POLLUTION_FRAC * 100).toFixed(0)}% pollution, 10% collectable`,
  );
  return world;
}

// ---------------------------------------------------------------------------
// robot state machine (one player per call) — AUTO MODE ONLY
// Manual mode robots are controlled by client mutations, not the tick.
// ---------------------------------------------------------------------------

type ClusterMap = Map<Id<"wasteClusters">, Doc<"wasteClusters">>;

async function stepRobot(
  ctx: MutationCtx,
  p: Doc<"players">,
  clusterMap: ClusterMap,
  now: number,
  dtReal: number,
  drainMult: number,
  assignments: Map<string | number, string | number>,
): Promise<boolean> {
  if (!p.hasBase) return false;
  const base = { x: p.baseX ?? WORLD.MAP_SIZE / 2, y: p.baseY ?? WORLD.MAP_SIZE / 2 };
  const r = { ...p.robot };
  const pl = { ...p };

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
      if (r.cargoKg > 0 && pl.storageKg < storageCap(p)) {
        const unload = Math.min(r.cargoKg, storageCap(p) - pl.storageKg);
        r.cargoKg -= unload;
        pl.storageKg += unload;
        pl.totalCollectedKg += unload;
      }
      if (r.auto && r.cargoKg < cCap) {
        const assigned = assignments.get(p._id);
        const target = assigned
          ? (clusterMap.get(assigned as Id<"wasteClusters">) as
              | Doc<"wasteClusters">
              | undefined)
          : undefined;
        if (target && target.kg > 0) {
          const bestD = dist(r, target);
          await ctx.db.patch(target._id, { reservedBy: p._id, reservedAt: now });
          clusterMap.set(target._id, { ...target, reservedBy: p._id, reservedAt: now });
          r.state = "to_cluster";
          r.targetClusterId = target._id;
          r.fromX = r.x;
          r.fromY = r.y;
          r.departAt = now;
          r.arriveAt = now + (bestD / ROBOT.SPEED_M_S) * 1000;
        } else if (r.battery < bCap) {
          r.state = "recharging";
        }
      }
      break;
    }
    case "to_cluster": {
      const target = r.targetClusterId ? clusterMap.get(r.targetClusterId) : undefined;
      const dest = target ?? base;
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * dtReal * drainMult);
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
      break;
    }
    case "collecting": {
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_COLLECTING * dtReal * drainMult);
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
      break;
    }
    case "to_base": {
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * dtReal * drainMult);
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
    // "driving" state is handled by client mutations — tick should not step it
    case "driving": {
      // Manual mode robots: only handle recharge when parked at base
      const distToBase = dist(r, base);
      if (distToBase <= MANUAL.BASE_DEPOSIT_RANGE) {
        const rechargeRate = UPGRADES.recharge.rates[p.levels.recharge - 1];
        const newBattery = Math.min(bCap, r.battery + rechargeRate * dtReal);
        if (newBattery !== r.battery) {
          r.battery = newBattery;
          await ctx.db.patch(p._id, {
            robot: { ...r, battery: newBattery },
          });
        }
      }
      return false; // manual robots don't generate demand through the tick
    }
  }

  const changed =
    pl.storageKg !== p.storageKg ||
    pl.totalCollectedKg !== p.totalCollectedKg ||
    JSON.stringify(r) !== JSON.stringify(p.robot);
  if (changed) {
    await ctx.db.patch(p._id, {
      storageKg: pl.storageKg,
      totalCollectedKg: pl.totalCollectedKg,
      robot: r,
    });
  }
  return robotDemands(r.state);
}

// ---------------------------------------------------------------------------
// burn zone lifecycle
// ---------------------------------------------------------------------------

async function stepBurnZone(
  ctx: MutationCtx,
  worldId: number,
  now: number,
): Promise<Doc<"burnZones"> | null> {
  let zone = await ctx.db
    .query("burnZones")
    .withIndex("by_world", (q) => q.eq("worldId", worldId))
    .first();
  if (!zone) {
    const id = await ctx.db.insert("burnZones", {
      worldId,
      status: "inactive",
      x: 0,
      y: 0,
      spawnedAt: 0,
      expiresAt: 0,
      nextSpawnAt: now + rand(BURN_ZONE.MIN_COOLDOWN_S, BURN_ZONE.MAX_COOLDOWN_S) * 1000,
      multiplier: BURN_ZONE_MULTIPLIER,
    });
    return (await ctx.db.get(id)) as Doc<"burnZones">;
  }

  if (zone.status === "inactive" && now >= zone.nextSpawnAt) {
    const x = rand(120, WORLD.MAP_SIZE - 120);
    const y = rand(120, WORLD.MAP_SIZE - 120);
    const expiresAt = now + rand(BURN_ZONE.MIN_ACTIVE_S, BURN_ZONE.MAX_ACTIVE_S) * 1000;
    await ctx.db.patch(zone._id, { status: "active", x, y, spawnedAt: now, expiresAt });
    await addEvent(
      ctx,
      worldId,
      "burn_zone",
      `🔥 BURN ZONE ACTIVE at (${Math.round(x)}, ${Math.round(y)}) — ×${BURN_ZONE_MULTIPLIER} TOX`,
    );
    return (await ctx.db.get(zone._id)) as Doc<"burnZones">;
  }

  if (zone.status === "active" && now >= zone.expiresAt) {
    await ctx.db.patch(zone._id, {
      status: "inactive",
      nextSpawnAt: now + rand(BURN_ZONE.MIN_COOLDOWN_S, BURN_ZONE.MAX_COOLDOWN_S) * 1000,
    });
    await addEvent(ctx, worldId, "burn_zone", "Burn Zone expired — rewards back to normal");
    return (await ctx.db.get(zone._id)) as Doc<"burnZones">;
  }

  return zone;
}

// ---------------------------------------------------------------------------
// the world tick — shared body (cron `tick` + Sprint 2.6 load harness)
// ---------------------------------------------------------------------------

/**
 * The world tick body. Shared by the cron-driven `tick` mutation and the
 * Sprint 2.6 load harness.
 */
export async function runTick(ctx: MutationCtx, now: number): Promise<void> {
  const dtReal = WORLD.TICK_SECONDS;

  let world = await ctx.db.query("worlds").first();
  if (!world) {
    world = await seedWorld(ctx, now);
  }
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
    const prots = new Map<Id<"players">, Protection>();
    const afkPatches: { id: Id<"players">; protection: Protection }[] = [];
    for (const p of players) {
      const base = p.protection ?? { state: "normal" };
      const prot = p.hasBase
        ? applyIdleCheck(base, p.lastActiveAt ?? p._creationTime, now)
        : base;
      prots.set(p._id, prot);
      if ((p.protection?.state ?? "normal") !== prot.state) {
        afkPatches.push({ id: p._id, protection: prot });
      }
    }
    for (const patch of afkPatches) {
      await ctx.db.patch(patch.id, { protection: patch.protection });
    }

    // 1) base generation → pollution
    const active = players.filter((p) => p.hasBase);
    const generating = active.filter((p) => !isSealed(prots.get(p._id)!.state));
    const genKgH = generating.length * WORLD.BASE_GEN_KG_H;
    let pollutionKg = Math.min(
      world.capacityKg,
      world.pollutionKg + genKgH * TICK_GAME_H,
    );
    const criticalNow = pollutionKg / world.capacityKg >= WORLD.CRITICAL_FRAC;
    let generatedKg = (world.generatedKg ?? 0) + genKgH * TICK_GAME_H;
    let seedPollutionKg =
      world.seedPollutionKg ?? world.pollutionKg + world.burnedKg;

    // 2) robots — Sprint 2.6 sharding (SKIP manual mode players)
    const shardCount = Math.max(
      1,
      Math.ceil(players.length / WORLD.ROBOTS_PER_TICK),
    );
    const shardIndex = (world.tickIndex ?? 0) % shardCount;
    // Batch/Reservation: only auto-mode, non-manual, idle robots
    const batchAssignments = batchAllocation(
      players
        .map((p, i) => ({ p, i }))
        .filter(
          ({ p, i }) =>
            i % shardCount === shardIndex &&
            p.hasBase &&
            !(p.manual ?? false) && // SKIP manual mode players
            !isSealed(prots.get(p._id)!.state) &&
            p.robot.auto &&
            p.robot.state === "idle" &&
            p.robot.cargoKg < cargoCap(p),
        )
        .map(({ p }) => ({
          id: p._id,
          x: p.robot.x,
          y: p.robot.y,
          level: p.levels.cargo,
          battery: p.robot.battery,
        })),
      [...clusterMap.values()]
        .filter((c) => c.kg > 0 && !c.reservedBy)
        .map((c) => ({ id: c._id, x: c.x, y: c.y, kg: c.kg })),
      WORLD.BATCH_SIZE,
      { tripCost: (_r, d) => batteryForTrip(d) },
    );
    let demandKgH = 0;
    for (const [i, p] of players.entries()) {
      const sealed = isSealed(prots.get(p._id)!.state);
      if (i % shardCount !== shardIndex) {
        if (!sealed && robotDemands(p.robot.state)) demandKgH += WORLD.DEMAND_REF_KG_H;
        continue;
      }
      if (sealed) continue;
      // Skip manual mode players — they're controlled by client mutations
      if (p.manual ?? false) continue;
      const drainMult = drainMultiplier(prots.get(p._id)!, now, criticalNow);
      const isActive = await stepRobot(
        ctx,
        p,
        clusterMap,
        now,
        dtReal,
        drainMult,
        batchAssignments,
      );
      if (isActive) demandKgH += WORLD.DEMAND_REF_KG_H;
    }

    // release stale reservations
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
    const replFracH = replenishmentModelC(genKgH, demandKgH);
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

    // 5) Burn Zone lifecycle
    const zone = await stepBurnZone(ctx, worldId, now);
    const zoneActive = zone?.status === "active";

    // 5b) Sprint 2.13 — complete storage shipments that have finished transit
    for (const p of players) {
      if (p.shipping?.active && now >= p.shipping.finishAt) {
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
      }
    }

    // 6) processing / burning → TOX-only rewards
    let burnedKg = world.burnedKg;
    for (const [i, p] of players.entries()) {
      if (p.processing.queuedKg <= 0) continue;
      if (i % shardCount !== shardIndex) continue;

      const sessionId = p.processing.sessionId ?? `${p._id}:${p.processing.since || now}`;
      const sliceIndex = p.processing.sliceIndex ?? 0;

      const burnKg = Math.min(p.processing.queuedKg, WORLD.PROCESSING_KG_PER_S * dtReal);
      const state: BurnSlice = { sessionId, queuedKg: p.processing.queuedKg, sliceIndex };
      const slice = computeBurnSlice(state, burnKg, zoneActive);

      const existing = await ctx.db
        .query("rewardLedger")
        .withIndex("by_player", (q) => q.eq("playerId", p._id))
        .filter((q) => q.eq(q.field("key"), slice.key))
        .first();
      const alreadyRewarded = !!existing;

      const next = advanceBurn(state, burnKg, alreadyRewarded);
      const patch: Record<string, unknown> = {
        processing: {
          queuedKg: next.queuedKg,
          since: p.processing.since,
          sessionId,
          sliceIndex: next.sliceIndex,
        },
      };

      if (!alreadyRewarded) {
        await ctx.db.insert("rewardLedger", {
          playerId: p._id,
          worldId,
          key: slice.key,
          kind: slice.kind,
          kg: slice.kg,
          tox: slice.tox,
          at: now,
        });
        patch.toxBalance = p.toxBalance + slice.tox;
        patch.totalBurnedKg = p.totalBurnedKg + burnKg;
        patch.toxFromNormal = (p.toxFromNormal ?? 0) + (slice.kind === "normal" ? slice.tox : 0);
        patch.toxFromZone = (p.toxFromZone ?? 0) + (slice.kind === "burn_zone" ? slice.tox : 0);
        pollutionKg = applyBurnToPollution(pollutionKg, burnKg);
        burnedKg += burnKg;

        if (next.queuedKg === 0) {
          await addEvent(
            ctx,
            worldId,
            "burn",
            `Burn complete — +${slice.tox.toFixed(2)} TOX (${slice.kind === "burn_zone" ? "Burn Zone ×1.2" : "normal"})`,
          );
        }

        const entries = await ctx.db
          .query("rewardLedger")
          .withIndex("by_player", (q) => q.eq("playerId", p._id))
          .collect();
        if (entries.length > LEDGER_KEEP_PER_PLAYER) {
          const sorted = [...entries].sort((a, b) => a._creationTime - b._creationTime);
          for (const old of sorted.slice(0, entries.length - LEDGER_KEEP_PER_PLAYER)) {
            await ctx.db.delete(old._id);
          }
        }
      }

      await ctx.db.patch(p._id, patch);
    }

    // 7) world status / collapse
    let status: Doc<"worlds">["status"] = worldStatus(pollutionKg, world.capacityKg);
    let newWorldId = worldId;
    let treasuryTox = world.treasuryTox ?? PROTECTION.TREASURY_SEED_TOX;
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
      status = "safe";
      let carriedKg = 0;
      for (const p of players) {
        const prot = p.hasBase
          ? onWorldCollapse(prots.get(p._id)!, now)
          : prots.get(p._id)!;
        prots.set(p._id, prot);
        if (p.hasBase && keepsHeldOnCollapse(prot.state)) {
          carriedKg += p.storageKg + p.robot.cargoKg + p.processing.queuedKg;
        }
      }
      const seed = collapseSeed(world.capacityKg, carriedKg);
      pollutionKg = seed.pollutionKg;
      hiddenKg = seed.hiddenKg;
      collectableKg = seed.collectableKg;
      burnedKg = 0;
      generatedKg = 0;
      seedPollutionKg = pollutionKg;
      for (const p of players) {
        const bx = p.baseX ?? WORLD.MAP_SIZE / 2;
        const by = p.baseY ?? WORLD.MAP_SIZE / 2;
        const prot = prots.get(p._id)!;
        const keep = p.hasBase && keepsHeldOnCollapse(prot.state);
        const held = keep
          ? proportionalPreserve(carriedKg, seed.preservedKg, {
              storage: p.storageKg,
              cargo: p.robot.cargoKg,
              processing: p.processing.queuedKg,
            })
          : { storage: 0, cargo: 0, processing: 0 };
        await ctx.db.patch(p._id, {
          worldId: newWorldId,
          protection: prot,
          storageKg: held.storage,
          processing: {
            queuedKg: held.processing,
            since: now,
            sessionId: keep ? p.processing.sessionId : undefined,
            sliceIndex: keep ? p.processing.sliceIndex : 0,
          },
          robot: {
            ...p.robot,
            state: "idle",
            targetClusterId: undefined,
            x: bx,
            y: by,
            fromX: bx,
            fromY: by,
            cargoKg: held.cargo,
            battery: batteryCap(p),
          },
          // Reset manual mode on collapse
          manual: false,
          shipping: { active: false, kg: 0, startAt: 0, finishAt: 0 },
        });
      }
      collectableKg = await spawnClusters(
        ctx,
        newWorldId,
        collectableKg,
        WORLD.ACTIVE_CLUSTER_TARGET,
        0,
      );
      await addEvent(ctx, newWorldId, "spawn", `World ${newWorldId} seeded — fresh pool unlocked`);
    }

    // Sprint 2.11 — Emergency Launch completion
    for (const p of players) {
      const prot = prots.get(p._id)!;
      if (prot.state !== "launching" || !launchDue(prot.launchAt, now)) continue;
      const cx = WORLD.MAP_SIZE / 2;
      treasuryTox = Math.max(0, treasuryTox * (1 - PROTECTION.TREASURY_BURN_FRAC));
      collectableKg += p.storageKg + p.robot.cargoKg + p.processing.queuedKg;
      await ctx.db.patch(p._id, {
        hasBase: false,
        baseX: undefined,
        baseY: undefined,
        storageKg: 0,
        processing: { queuedKg: 0, since: now, sessionId: undefined, sliceIndex: 0 },
        toxBalance: Math.max(0, p.toxBalance - PROTECTION.LAUNCH_FEE_TOX),
        solBalance: p.solBalance + WORLD.BASE_PRICE_SOL,
        robot: {
          state: "idle",
          x: cx,
          y: cx,
          fromX: cx,
          fromY: cx,
          departAt: now,
          targetClusterId: undefined,
          battery: batteryCap(p),
          cargoKg: 0,
          arriveAt: undefined,
          busyUntil: undefined,
          auto: true,
          totalTrips: 0,
        },
        protection: {
          ...prot,
          state: "normal",
          lockedAt: undefined,
          lockReason: undefined,
          launchAt: undefined,
        },
        manual: false,
        shipping: { active: false, kg: 0, startAt: 0, finishAt: 0 },
      });
      await addEvent(
        ctx,
        worldId,
        "launch",
        "🚀 Emergency Launch — base destroyed (TOX fee + treasury −15%)",
      );
    }

    // Sprint 2.4 harness: waste invariant
    const invariantSkewKg = Math.abs(
      pollutionKg + burnedKg - seedPollutionKg - generatedKg,
    );

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
      generatedKg,
      seedPollutionKg,
      invariantSkewKg,
      tickIndex: (world.tickIndex ?? 0) + 1,
      treasuryTox,
    });
}

/**
 * The public world tick, driven by the cron job `toxic-world-tick` (every 5 s).
 */
export const tick = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const world = await ctx.db.query("worlds").first();
    if (!world || now - world.lastTick < WORLD.TICK_SECONDS * 1000 * 0.8) {
      return { advanced: false, tickMs: 0 };
    }
    const t0 = performance.now();
    await runTick(ctx, now);
    return { advanced: true, tickMs: performance.now() - t0 };
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
    const [clusters, players, zone] = await Promise.all([
      ctx.db
        .query("wasteClusters")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
      ctx.db
        .query("players")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .collect(),
      ctx.db
        .query("burnZones")
        .withIndex("by_world", (q) => q.eq("worldId", world.worldId))
        .first(),
    ]);
    return {
      world,
      zone,
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
