// TOXIC WORLD — DETERMINISTIC ORACLE SIMULATOR (Sprint 2.4 → 2.11).
//
// Mirrors `world.ts`'s runTick step-for-step using the SAME pure functions the
// production tick calls (engine.ts / economy.ts / protection.ts), so the
// headless tests validate the real production formulas, not a copy:
//
//   1. protection idle check (AFK detection)         applyIdleCheck
//   2. base generation (sealed bases emit nothing)   isSealed
//   3. robots (spatial movement, battery, demand)    batchAllocation + robotDemands
//   4. dynamic replenishment Model C                 replenishmentModelC
//   5. cluster spawning (deducts from collectable)   — deterministic sizes
//   6. burn → TOX (normal / zone), idempotent        computeBurnSlice + advanceBurn
//   7. world status / collapse (protection matrix)   worldStatus + collapseSeed + onWorldCollapse
//   8. Emergency Launch completion                   launchDue (treasury −15%, spill)
//
// Everything is deterministic (no Math.random): cluster spawn sizes use a
// fixed stride, travel/collect/unload times come from the shared constants,
// and `now` is caller-supplied. The invariant checkers at the end of each tick
// are what the harness asserts on.
//
// NOTE: Convex-independent by design — imports only the pure modules, so the
// same file runs under `bun test`.

import {
  batchAllocation,
  checkWasteInvariant,
  replenishmentModelC,
  robotDemands,
  worldStatus,
} from "../src/convex/engine";
import {
  advanceBurn,
  computeBurnSlice,
  type BurnSlice,
} from "../src/convex/economy";
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
} from "../src/convex/protection";
import {
  PROTECTION,
  ROBOT,
  UPGRADES,
  WORLD,
  batteryForTrip,
} from "../src/convex/gameParams";

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60;
const DT_REAL = WORLD.TICK_SECONDS;

// SPRINT 2.11 fix — unique cluster ids. The original `c${worldId}-${out.length}
// -${i}` scheme starts `out.length` at 0 for EVERY spawn call (freshWorld and
// each tick's fresh `spawned` array), so every batch generated the SAME ids.
// The per-tick `Map` rebuild then dropped all but the last batch — ~11,850 kg
// (one spawn batch) vanished from the pool every tick, which read as a large
// Layer-2 drift in every whole-world scenario. Production uses real DB ids
// (world.ts `ctx.db.insert("wasteClusters")`), so this was sim-only; a
// monotonically increasing module counter restores uniqueness.
let simClusterSeq = 0;
function nextClusterId(worldId: number): string {
  simClusterSeq += 1;
  return `c${worldId}-${simClusterSeq}`;
}

export type SimRobotState =
  | "idle"
  | "to_cluster"
  | "collecting"
  | "to_base"
  | "unloading"
  | "recharging";

export interface SimRobot {
  state: SimRobotState;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  departAt: number;
  arriveAt?: number;
  busyUntil?: number;
  targetClusterId: string | number | null;
  battery: number;
  cargoKg: number;
  auto: boolean;
  totalTrips: number;
}

export interface SimPlayer {
  id: string | number;
  hasBase: boolean;
  baseX: number;
  baseY: number;
  storageKg: number;
  totalCollectedKg: number;
  totalBurnedKg: number;
  toxBalance: number;
  toxFromNormal: number;
  toxFromZone: number;
  solBalance: number;
  processing: {
    queuedKg: number;
    since: number;
    sessionId?: string;
    sliceIndex: number;
  };
  levels: { cargo: number; recharge: number; battery: number; storage: number };
  lastActiveAt: number;
  protection: Protection;
  robot: SimRobot;
}

export interface SimCluster {
  id: string | number;
  x: number;
  y: number;
  kg: number;
  reservedBy?: string | number | null;
}

export interface SimWorld {
  worldId: number;
  capacityKg: number;
  pollutionKg: number;
  collectableKg: number;
  hiddenKg: number;
  burnedKg: number;
  generatedKg: number;
  seedPollutionKg: number;
  status: "safe" | "critical" | "collapsed";
  generationRateKgH: number;
  demandKgH: number;
  treasuryTox: number;
  resetCount: number;
  tickIndex: number;
  lastTick: number;
}

export interface SimState {
  world: SimWorld;
  players: SimPlayer[];
  clusters: SimCluster[];
  /** reward ledger keys — mirrors the rewardLedger table's exactly-once rail */
  ledger: Set<string>;
}

export interface TickResult {
  state: SimState;
  invariantMass: number; // Layer 1 residual
  invariantPool: number; // Layer 2 residual
  events: { type: string; message: string }[];
}

// ---------------------------------------------------------------------------
// helpers (mirror world.ts)
// ---------------------------------------------------------------------------

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const capOf = (p: SimPlayer, track: "cargo" | "recharge" | "battery" | "storage") =>
  (UPGRADES[track] as { caps?: number[]; rates?: number[] }).caps
    ? (UPGRADES[track] as { caps: number[] }).caps[p.levels[track] - 1]
    : (UPGRADES[track] as { rates: number[] }).rates[p.levels[track] - 1];

export const cargoCap = (p: SimPlayer) => capOf(p, "cargo");
export const storageCap = (p: SimPlayer) => capOf(p, "storage");
export const batteryCap = (p: SimPlayer) => capOf(p, "battery");

/** Deterministic cluster spawn — deducts from collectable (world.ts spawnClusters).
 * Pushes into `out` (the live DB array) and returns the leftover pool mass. */
function spawnClusters(
  out: SimCluster[],
  availableKg: number,
  target: number,
  current: number,
  worldId: number,
  seed = 0,
): number {
  let remaining = availableKg;
  let spawned = 0;
  let i = seed;
  while (
    current + spawned < target &&
    remaining >= WORLD.CLUSTER_MIN_KG &&
    spawned < WORLD.MAX_CLUSTER_SPAWNS_PER_TICK
  ) {
    const size = Math.min(
      WORLD.CLUSTER_MIN_KG + ((i * 37) % (WORLD.CLUSTER_MAX_KG - WORLD.CLUSTER_MIN_KG)),
      remaining,
    );
    out.push({
      id: nextClusterId(worldId),
      x: 100 + ((i * 211) % 800),
      y: 100 + ((i * 97) % 800),
      kg: size,
    });
    remaining -= size;
    spawned++;
    i++;
  }
  return remaining;
}

function resetRobotToBase(p: SimPlayer, now: number, battery: number): SimRobot {
  return {
    state: "idle",
    x: p.baseX,
    y: p.baseY,
    fromX: p.baseX,
    fromY: p.baseY,
    departAt: now,
    targetClusterId: null,
    battery,
    cargoKg: 0,
    auto: true, // world.ts launch completion re-arms the robot
    totalTrips: 0,
  };
}

// ---------------------------------------------------------------------------
// the tick (mirrors world.ts runTick, protection-aware since Sprint 2.11)
// ---------------------------------------------------------------------------

export function simTick(state: SimState, now: number, zoneActive = false): TickResult {
  const events: TickResult["events"] = [];
  const world = { ...state.world };
  // SPRINT 2.11 port fix — mutate the player docs IN PLACE (like world.ts,
  // which reads the docs once and patches them). The original clone-per-tick
  // approach left every caller-held player reference stale: the 2.8/2.10
  // suites hold `p` and apply their queue policy to it between ticks, and
  // with clones that policy operated on dead objects (zero TOX ever earned).
  const players = state.players;
  const clusterMap = new Map(state.clusters.map((c) => [String(c.id), { ...c }]));
  const mutClusters = () => [...clusterMap.values()];

  // 1) protection idle check (AFK). Only bases can go AFK; patches applied.
  const prots = new Map<string, Protection>();
  for (const p of players) {
    const base = p.protection ?? { state: "normal" };
    prots.set(String(p.id), p.hasBase ? applyIdleCheck(base, p.lastActiveAt, now) : base);
    p.protection = prots.get(String(p.id))!;
  }

  // 2) base generation — sealed (locked/launching) bases emit nothing; AFK
  //    bases stay on autopilot (Sprint 2.9 collapse-matrix model).
  const generating = players.filter(
    (p) => p.hasBase && !isSealed(prots.get(String(p.id))!.state),
  );
  const genKgH = generating.length * WORLD.BASE_GEN_KG_H;
  world.pollutionKg = Math.min(
    world.capacityKg,
    world.pollutionKg + genKgH * TICK_GAME_H,
  );
  const criticalNow = world.pollutionKg / world.capacityKg >= WORLD.CRITICAL_FRAC;
  world.generatedKg = (world.generatedKg ?? 0) + genKgH * TICK_GAME_H;
  let seedPollutionKg = world.seedPollutionKg ?? world.pollutionKg + world.burnedKg;

  // 3) robots — batch/reservation plan (level-ordered floor access) then step.
  const batchAssignments = batchAllocation(
    players
      .filter(
        (p) =>
          p.hasBase &&
          !isSealed(prots.get(String(p.id))!.state) &&
          p.robot.auto &&
          p.robot.state === "idle" &&
          p.robot.cargoKg < cargoCap(p),
      )
      .map((p) => ({
        id: p.id,
        x: p.robot.x,
        y: p.robot.y,
        level: p.levels.cargo,
        battery: p.robot.battery,
      })),
    mutClusters()
      .filter((c) => c.kg > 0 && !c.reservedBy)
      .map((c) => ({ id: c.id, x: c.x, y: c.y, kg: c.kg })),
    WORLD.BATCH_SIZE,
    { tripCost: (_r, d) => batteryForTrip(d) },
  );

  let demandKgH = 0;
  for (const p of players) {
    const prot = prots.get(String(p.id))!;
    if (isSealed(prot.state)) continue; // parked — no demand, no drain
    const drainMult = drainMultiplier(prot, now, criticalNow);
    const isActive = stepRobot(p, clusterMap, batchAssignments, now, drainMult);
    if (isActive) demandKgH += WORLD.DEMAND_REF_KG_H;
  }
  // release stale reservations (robot no longer targeting its cluster)
  for (const c of clusterMap.values()) {
    if (!c.reservedBy) continue;
    const owner = players.find((p) => String(p.id) === String(c.reservedBy));
    const stillTargeting =
      owner &&
      String(owner.robot.targetClusterId) === String(c.id) &&
      (owner.robot.state === "to_cluster" || owner.robot.state === "collecting");
    if (!stillTargeting) {
      c.reservedBy = undefined;
    }
  }

  // 4) dynamic replenishment — Model C
  const replFracH = replenishmentModelC(genKgH, demandKgH);
  const unlockKg = Math.min(world.hiddenKg, world.hiddenKg * replFracH * TICK_GAME_H);
  let collectableKg = world.collectableKg + unlockKg;
  world.hiddenKg -= unlockKg;

  // 5) keep the map stocked with clusters (new clusters join the live DB array
  //    but are only visible to later steps/ticks — mirrors world.ts)
  const spawned: SimCluster[] = [];
  collectableKg = spawnClusters(spawned, collectableKg, WORLD.ACTIVE_CLUSTER_TARGET, clusterMap.size, world.worldId);

  // 6) processing / burning → TOX-only rewards (v0.4), exactly-once per slice
  let burnedKg = world.burnedKg;
  let pollutionKg = world.pollutionKg;
  for (const p of players) {
    if (p.processing.queuedKg <= 0) continue;
    const sessionId = p.processing.sessionId ?? `${p.id}:${p.processing.since || now}`;
    const sliceIndex = p.processing.sliceIndex ?? 0;
    const burnKg = Math.min(p.processing.queuedKg, WORLD.PROCESSING_KG_PER_S * DT_REAL);
    const state0: BurnSlice = { sessionId, queuedKg: p.processing.queuedKg, sliceIndex };
    const slice = computeBurnSlice(state0, burnKg, zoneActive);
    const alreadyRewarded = state.ledger.has(slice.key);
    const next = advanceBurn(state0, burnKg, alreadyRewarded);
    p.processing = {
      queuedKg: next.queuedKg,
      since: p.processing.since,
      sessionId,
      sliceIndex: next.sliceIndex,
    };
    if (!alreadyRewarded) {
      state.ledger.add(slice.key);
      p.toxBalance += slice.tox;
      // Sprint 2.11 port: mirror the player-doc counters world.ts writes
      // (totalBurnedKg / toxFromNormal / toxFromZone) so the 2.8/2.10 suites
      // can decompose normal vs Burn Zone earnings.
      p.totalBurnedKg += burnKg;
      p.toxFromNormal += slice.kind === "normal" ? slice.tox : 0;
      p.toxFromZone += slice.kind === "burn_zone" ? slice.tox : 0;
      pollutionKg = Math.max(0, pollutionKg - burnKg);
      burnedKg += burnKg;
      if (next.queuedKg === 0) {
        events.push({
          type: "burn",
          message: `Burn complete — +${slice.tox.toFixed(2)} TOX (${slice.kind === "burn_zone" ? "Burn Zone ×1.2" : "normal"})`,
        });
      }
    }
  }
  world.pollutionKg = pollutionKg;
  world.burnedKg = burnedKg;

  // 7) world status / collapse — protection matrix (Sprint 2.11 doc §3)
  let status = worldStatus(world.pollutionKg, world.capacityKg);
  let newWorldId = world.worldId;
  let treasuryTox = world.treasuryTox ?? PROTECTION.TREASURY_SEED_TOX;
  if (world.pollutionKg >= world.capacityKg) {
    events.push({
      type: "collapse",
      message: "💀 WORLD COLLAPSE — pollution hit 100%. World resets at 22.5%.",
    });
    newWorldId = world.worldId + 1;
    clusterMap.clear();
    status = "safe";
    // collapse fate per state (doc §3): normal → wiped; afk → auto-lock keeps;
    // locked/launching → keeps. Preserved holdings come out of the new seed.
    let carriedKg = 0;
    for (const p of players) {
      const prot = p.hasBase
        ? onWorldCollapse(prots.get(String(p.id))!, now)
        : prots.get(String(p.id))!;
      prots.set(String(p.id), prot);
      p.protection = prot;
      if (p.hasBase && keepsHeldOnCollapse(prot.state)) {
        carriedKg += p.storageKg + p.robot.cargoKg + p.processing.queuedKg;
      }
    }
    const seed = collapseSeed(world.capacityKg, carriedKg);
    world.pollutionKg = seed.pollutionKg;
    world.hiddenKg = seed.hiddenKg;
    collectableKg = seed.collectableKg;
    world.burnedKg = 0;
    world.generatedKg = 0;
    seedPollutionKg = world.pollutionKg; // re-anchor Layer 1 for the new cycle
    for (const p of players) {
      const prot = prots.get(String(p.id))!;
      const keep = p.hasBase && keepsHeldOnCollapse(prot.state);
      const held = keep
        ? proportionalPreserve(carriedKg, seed.preservedKg, {
            storage: p.storageKg,
            cargo: p.robot.cargoKg,
            processing: p.processing.queuedKg,
          })
        : { storage: 0, cargo: 0, processing: 0 };
      p.worldId = newWorldId;
      p.storageKg = held.storage;
      p.processing = {
        queuedKg: held.processing,
        since: now,
        sessionId: keep ? p.processing.sessionId : undefined,
        sliceIndex: keep ? p.processing.sliceIndex : 0,
      };
      p.robot = {
        ...p.robot,
        state: "idle",
        targetClusterId: null,
        x: p.baseX,
        y: p.baseY,
        fromX: p.baseX,
        fromY: p.baseY,
        cargoKg: held.cargo,
        battery: batteryCap(p),
      };
    }
    collectableKg = spawnClusters(spawned, collectableKg, WORLD.ACTIVE_CLUSTER_TARGET, 0, newWorldId, 7);
    events.push({ type: "spawn", message: `World ${newWorldId} seeded — fresh pool unlocked` });
  }

  // 8) Emergency Launch completion (5 real-min countdown). Base −1, Robot −1,
  //    fee in TOX, treasury −15% (mock), mock re-entry SOL grant, stockpile
  //    spills back into the recoverable pool.
  for (const p of players) {
    const prot = prots.get(String(p.id))!;
    if (prot.state !== "launching" || !launchDue(prot.launchAt, now)) continue;
    treasuryTox = Math.max(0, treasuryTox * (1 - PROTECTION.TREASURY_BURN_FRAC));
    collectableKg += p.storageKg + p.robot.cargoKg + p.processing.queuedKg;
    p.hasBase = false;
    p.storageKg = 0;
    p.processing = { queuedKg: 0, since: now, sessionId: undefined, sliceIndex: 0 };
    p.toxBalance = Math.max(0, p.toxBalance - PROTECTION.LAUNCH_FEE_TOX);
    p.solBalance += WORLD.BASE_PRICE_SOL; // MOCK re-entry grant
    p.robot = resetRobotToBase(p, now, batteryCap(p));
    p.protection = {
      ...prot,
      state: "normal",
      lockedAt: undefined,
      lockReason: undefined,
      launchAt: undefined,
    };
    events.push({
      type: "launch",
      message: "🚀 Emergency Launch — base destroyed (TOX fee + treasury −15%)",
    });
  }

  world.collectableKg = collectableKg;
  world.generationRateKgH = genKgH;
  world.demandKgH = demandKgH;
  world.status = status;
  // SPRINT 2.11 fix — persist the new world id on collapse (world.ts patches
  // `worldId: newWorldId` on the world doc; without this the sim's worldId
  // stayed 0 forever, so collapse-detecting tests never saw worldId > 0).
  world.worldId = newWorldId;
  world.resetCount =
    state.world.resetCount + (newWorldId > state.world.worldId ? 1 : 0);
  world.lastTick = now;
  world.tickIndex = (world.tickIndex ?? 0) + 1;
  world.treasuryTox = treasuryTox;
  world.seedPollutionKg = seedPollutionKg;

  state.world = world;
  state.players = players;
  state.clusters = [...clusterMap.values(), ...spawned].map((c) => ({ ...c }));

  const massBalance =
    world.pollutionKg +
    world.burnedKg -
    (world.seedPollutionKg ?? seedPollutionKg) -
    world.generatedKg;
  const poolBalance =
    world.hiddenKg +
    world.collectableKg +
    state.clusters.reduce((s, c) => s + c.kg, 0) +
    state.players.reduce(
      (s, p) => s + p.robot.cargoKg + p.storageKg + p.processing.queuedKg,
      0,
    ) -
    (world.pollutionKg - world.generatedKg);

  return { state, invariantMass: massBalance, invariantPool: poolBalance, events };
}

/** Port of world.ts stepRobot (spatial movement, battery, cargo, demand). */
function stepRobot(
  p: SimPlayer,
  clusterMap: Map<string, { id: string | number; x: number; y: number; kg: number; reservedBy?: string | number | null }>,
  assignments: Map<string | number, string | number>,
  now: number,
  drainMult: number,
): boolean {
  if (!p.hasBase) return false;
  const base = { x: p.baseX, y: p.baseY };
  const r = p.robot;
  const bCap = batteryCap(p);
  const rechargeRate = capOf(p, "recharge");
  const cCap = cargoCap(p);

  const releaseReservation = () => {
    if (r.targetClusterId != null) {
      const c = clusterMap.get(String(r.targetClusterId));
      if (c && String(c.reservedBy) === String(p.id)) c.reservedBy = undefined;
      r.targetClusterId = null;
    }
  };
  const goHome = (fromX: number, fromY: number) => {
    r.state = "to_base";
    r.fromX = fromX;
    r.fromY = fromY;
    r.departAt = now;
    r.arriveAt = now + (dist(base, { x: fromX, y: fromY }) / ROBOT.SPEED_M_S) * 1000;
  };

  switch (r.state) {
    case "idle": {
      if (r.cargoKg > 0 && p.storageKg < storageCap(p)) {
        const unload = Math.min(r.cargoKg, storageCap(p) - p.storageKg);
        r.cargoKg -= unload;
        p.storageKg += unload;
        p.totalCollectedKg += unload;
      }
      if (r.auto && r.cargoKg < cCap) {
        const assigned = assignments.get(p.id);
        const target = assigned ? clusterMap.get(String(assigned)) : undefined;
        if (target && target.kg > 0) {
          const bestD = dist(r, target);
          target.reservedBy = p.id;
          r.state = "to_cluster";
          r.targetClusterId = target.id;
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
      const target = r.targetClusterId != null ? clusterMap.get(String(r.targetClusterId)) : undefined;
      const dest = target ?? base;
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * DT_REAL * drainMult);
      const total = (r.arriveAt ?? now) - r.departAt;
      if (total > 0) {
        const t = Math.min(1, (now - r.departAt) / total);
        r.x = r.fromX + (dest.x - r.fromX) * t;
        r.y = r.fromY + (dest.y - r.fromY) * t;
      }
      const returnBattery =
        (dist(base, r) / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING + ROBOT.BATTERY_SAFETY_MARGIN;
      if (!target || target.kg <= 0 || r.battery <= returnBattery) {
        releaseReservation();
        goHome(r.x, r.y);
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
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_COLLECTING * DT_REAL * drainMult);
      if (now >= (r.busyUntil ?? now)) {
        const target = r.targetClusterId != null ? clusterMap.get(String(r.targetClusterId)) : undefined;
        if (target && target.kg > 0) {
          const amount = Math.min(cCap - r.cargoKg, target.kg);
          r.cargoKg += amount;
          target.kg -= amount;
          if (target.kg <= 0) {
            clusterMap.delete(String(target.id));
          }
          r.totalTrips += 1;
        }
        releaseReservation();
        goHome(target ? target.x : r.x, target ? target.y : r.y);
      }
      break;
    }
    case "to_base": {
      r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * DT_REAL * drainMult);
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
        const space = storageCap(p) - p.storageKg;
        const unload = Math.min(r.cargoKg, space);
        p.storageKg += unload;
        p.totalCollectedKg += unload;
        r.cargoKg -= unload;
        r.state = r.battery < bCap * ROBOT.LOW_BATTERY_FRAC ? "recharging" : "idle";
      }
      break;
    }
    case "recharging": {
      r.battery = Math.min(bCap, r.battery + rechargeRate * DT_REAL);
      if (r.battery >= bCap) {
        r.battery = bCap;
        r.state = "idle";
      }
      break;
    }
  }
  return robotDemands(r.state);
}

/** Fresh World 0 (pristine baseline: 50% pollution, 10% collectable, 0 generated/burned). */
export function freshWorld(capacityKg = WORLD.CAPACITY_KG, pollutionFrac = WORLD.INITIAL_POLLUTION_FRAC): SimState {
  const pollutionKg = capacityKg * pollutionFrac;
  const collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
  const state: SimState = {
    world: {
      worldId: 0,
      capacityKg,
      pollutionKg,
      collectableKg,
      hiddenKg: pollutionKg - collectableKg,
      burnedKg: 0,
      generatedKg: 0,
      seedPollutionKg: pollutionKg,
      status: "safe",
      generationRateKgH: 0,
      demandKgH: 0,
      treasuryTox: PROTECTION.TREASURY_SEED_TOX,
      resetCount: 0,
      tickIndex: 0,
      lastTick: 0,
    },
    players: [],
    clusters: [],
    ledger: new Set(),
  };
  // spawn the initial cluster set from the collectable pool (mirrors seedWorld)
  state.world.collectableKg = spawnClusters(
    state.clusters,
    collectableKg,
    WORLD.ACTIVE_CLUSTER_TARGET,
    0,
    0,
  );
  return state;
}

export function makePlayer(
  id: string | number,
  opts: Partial<SimPlayer> & { hasBase: boolean },
  now = 0,
): SimPlayer {
  const { auto, hasBase, baseX, baseY, robot, ...rest } = opts;
  const bx = baseX ?? 500;
  const by = baseY ?? 500;
  return {
    id,
    hasBase,
    baseX: bx,
    baseY: by,
    storageKg: 0,
    totalCollectedKg: 0,
    totalBurnedKg: 0,
    toxBalance: 0,
    toxFromNormal: 0,
    toxFromZone: 0,
    solBalance: 0,
    processing: { queuedKg: 0, since: now, sessionId: undefined, sliceIndex: 0 },
    levels: { cargo: 1, recharge: 1, battery: 1, storage: 1 },
    lastActiveAt: now,
    protection: { state: "normal" },
    robot:
      robot ?? {
        state: "idle",
        x: bx,
        y: by,
        fromX: bx,
        fromY: by,
        departAt: 0,
        targetClusterId: null,
        battery: UPGRADES.battery.caps[0],
        cargoKg: 0,
        auto: auto ?? true,
        totalTrips: 0,
      },
    ...rest,
  };
}

/**
 * Create a sim state seeded with the given players, debiting any held mass
 * (storage / queue / cargo) from the world's collectable pool — mirrors
 * `harness:seedLoad` (Sprint 2.6): seeded holdings are REAL recoverable pool
 * mass, and without the debit Layer 2 reads them as phantom drift.
 */
export function simWithPlayers(players: SimPlayer[]): SimState {
  const s = freshWorld();
  const heldKg = players.reduce(
    (a, p) => a + p.storageKg + p.processing.queuedKg + p.robot.cargoKg,
    0,
  );
  if (heldKg > 0) {
    s.world.collectableKg = Math.max(0, s.world.collectableKg - heldKg);
  }
  s.players.push(...players);
  return s;
}

/**
 * Deterministic synthetic players (mirrors `harness:seedLoad` shapes, no RNG):
 * level pool 50% L1 / ~33% L2-3 / ~17% L5, striped positions and holdings.
 * `seed` is accepted for call-compat with the Sprint 2.8/2.10 suites and only
 * shifts the striping; the result is fully deterministic either way.
 */
export function makePlayers(
  count: number,
  opts: {
    seed?: number;
    autoFraction?: number;
    storageFraction?: number;
    queueFraction?: number;
    levelPool?: number[];
  } = {},
): SimPlayer[] {
  const autoFraction = opts.autoFraction ?? 0.5;
  const storageFraction = opts.storageFraction ?? 0.3;
  const queueFraction = opts.queueFraction ?? 0.2;
  const levelPool = opts.levelPool ?? [1, 1, 1, 2, 3, 5];
  const off = opts.seed ?? 0;
  const now = 0;
  const out: SimPlayer[] = [];
  for (let i = 0; i < count; i++) {
    const lv = levelPool[(i * 7 + off) % levelPool.length];
    const bx = 120 + ((i * 211 + off * 13) % (WORLD.MAP_SIZE - 240));
    const by = 120 + ((i * 97 + off * 29) % (WORLD.MAP_SIZE - 240));
    const storageKg =
      (i + off) % 10 < storageFraction * 10
        ? Math.floor(((i * 29 + off) % UPGRADES.storage.caps[lv - 1]) + 1)
        : 0;
    const queuedKg =
      (i * 3 + off) % 10 < queueFraction * 10
        ? 10 + ((i * 31 + off) % 40)
        : 0;
    out.push(
      makePlayer(i, {
        hasBase: true,
        baseX: bx,
        baseY: by,
        storageKg,
        processing: {
          queuedKg,
          since: now,
          sessionId: undefined,
          sliceIndex: 0,
        },
        levels: { cargo: lv, recharge: lv, battery: lv, storage: lv },
        auto: (i + off) % 10 < autoFraction * 10,
        robot: {
          state: "idle",
          x: bx,
          y: by,
          fromX: bx,
          fromY: by,
          departAt: 0,
          targetClusterId: null,
          battery: UPGRADES.battery.caps[lv - 1],
          cargoKg: 0,
          auto: (i + off) % 10 < autoFraction * 10,
          totalTrips: 0,
        },
      }, now),
    );
  }
  return out;
}

/**
 * Compute the two-layer invariant residuals for a sim state (re-uses the
 * production checkWasteInvariant — the same math simTick asserts internally).
 */
export function simInvariant(state: SimState): {
  massBalance: number;
  poolBalance: number;
} {
  return checkWasteInvariant({
    initialWasteKg: state.world.seedPollutionKg,
    generatedKg: state.world.generatedKg,
    pollutionKg: state.world.pollutionKg,
    burnedKg: state.world.burnedKg,
    hiddenKg: state.world.hiddenKg,
    collectableKg: state.world.collectableKg,
    clusterKg: state.clusters.reduce((a, c) => a + c.kg, 0),
    cargoKg: state.players.reduce((a, p) => a + p.robot.cargoKg, 0),
    storageKg: state.players.reduce((a, p) => a + p.storageKg, 0),
    processingKg: state.players.reduce((a, p) => a + p.processing.queuedKg, 0),
  });
}

/** Advance the sim a fixed number of 5 s ticks and return the final state. */
export function runTicks(
  state: SimState,
  ticks: number,
  zoneActive = false,
): { state: SimState; mass: number; pool: number; events: TickResult["events"] } {
  let mass = 0;
  let pool = 0;
  const events: TickResult["events"] = [];
  let now = state.world.lastTick;
  for (let i = 0; i < ticks; i++) {
    now += DT_REAL * 1000;
    const r = simTick(state, now, zoneActive);
    mass = r.invariantMass;
    pool = r.invariantPool;
    events.push(...r.events);
  }
  return { state, mass, pool, events };
}
