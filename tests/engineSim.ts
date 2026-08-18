// TOXIC WORLD — Deterministic Engine Simulation Oracle (CANONICAL API)
// Mirrors src/convex/world.ts + engine.ts + economy.ts + protection.ts
// step-for-step for headless testing without Convex.
//
// This is the SINGLE source of truth for all test suites. Every test file
// (engine.test.ts, economy.test.ts, economyValidation.test.ts,
// storageBatteryValidation.test.ts, protectionValidation.test.ts,
// protectionEconomyValidation.test.ts) imports from this module.

import {
  BURN_ZONE,
  BURN_ZONE_MULTIPLIER,
  PROTECTION,
  ROBOT,
  TOX_PER_TON,
  UPGRADES,
  WORLD,
  batteryForTrip,
} from "../src/convex/gameParams";
import {
  type Protection,
  isSealed,
  onWorldCollapse,
  keepsHeldOnCollapse,
  drainMultiplier,
  collapseSeed,
  proportionalPreserve,
  applyIdleCheck,
} from "../src/convex/protection";
import {
  replenishmentModelC,
  robotDemands,
  worldStatus,
  batchAllocation,
} from "../src/convex/engine";
import {
  computeBurnSlice,
  advanceBurn,
  applyBurnToPollution,
  type BurnSlice,
} from "../src/convex/economy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimCluster {
  id: string | number;
  x: number;
  y: number;
  kg: number;
  reservedBy?: string | number;
}

export interface SimRobot {
  state:
    | "idle"
    | "to_cluster"
    | "collecting"
    | "to_base"
    | "unloading"
    | "recharging";
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  departAt: number;
  targetClusterId?: string | number;
  battery: number;
  cargoKg: number;
  arriveAt?: number;
  busyUntil?: number;
  auto: boolean;
  totalTrips: number;
}

export interface SimPlayer {
  id: string | number;
  worldId: number;
  hasBase: boolean;
  baseX: number;
  baseY: number;
  solBalance: number;
  toxBalance: number;
  totalCollectedKg: number;
  totalBurnedKg: number;
  toxFromNormal: number;
  toxFromZone: number;
  storageKg: number;
  processing: {
    queuedKg: number;
    since: number;
    sessionId?: string;
    sliceIndex: number;
  };
  levels: {
    cargo: number;
    recharge: number;
    battery: number;
    storage: number;
  };
  lastActiveAt: number;
  protection: Protection;
  robot: SimRobot;
}

export interface SimWorld {
  worldId: number;
  capacityKg: number;
  pollutionKg: number;
  collectableKg: number;
  hiddenKg: number;
  status: "safe" | "critical" | "collapsed";
  generationRateKgH: number;
  demandKgH: number;
  burnedKg: number;
  activePlayers: number;
  seedPollutionKg: number;
  generatedKg: number;
  invariantSkewKg: number;
  tickIndex: number;
  treasuryTox: number;
  lastTick: number;
}

export interface SimState {
  world: SimWorld;
  players: SimPlayer[];
  clusters: SimCluster[];
  burnZone: { status: string; x: number; y: number; nextSpawnAt: number; expiresAt: number };
  ledger: Array<{
    playerId: string | number;
    key: string;
    kind: string;
    kg: number;
    tox: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60;

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Seeded PRNG for deterministic cluster generation across test runs
let _rngState = 42;
function seedRng(s: number) { _rngState = s; }
function rand(min: number, max: number) {
  _rngState = (_rngState * 16807 + 0) % 2147483647;
  return min + (_rngState / 2147483647) * (max - min);
}
function rngFrac() {
  _rngState = (_rngState * 16807 + 0) % 2147483647;
  return _rngState / 2147483647;
}

export function storageCap(p: SimPlayer): number {
  return UPGRADES.storage.caps[p.levels.storage - 1];
}

export function cargoCap(p: SimPlayer): number {
  return UPGRADES.cargo.caps[p.levels.cargo - 1];
}

export function batteryCap(p: SimPlayer): number {
  return UPGRADES.battery.caps[p.levels.battery - 1];
}

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

function generateClusters(
  count: number,
  totalKg: number,
): { clusters: SimCluster[]; remainingKg: number } {
  const clusters: SimCluster[] = [];
  let remaining = totalKg;
  for (let i = 0; i < count; i++) {
    const kg = Math.min(
      WORLD.CLUSTER_MIN_KG + rand(0, 1) * (WORLD.CLUSTER_MAX_KG - WORLD.CLUSTER_MIN_KG),
      remaining,
    );
    if (kg < WORLD.CLUSTER_MIN_KG) break;
    clusters.push({
      id: `c${i}`,
      x: 100 + rand(0, 1) * 800,
      y: 100 + rand(0, 1) * 800,
      kg,
    });
    remaining -= kg;
  }
  return { clusters, remainingKg: remaining };
}

/** Create a pristine world at the given pollution fraction. */
export function freshWorld(
  capacityKgOrFrac?: number,
  pollutionFrac?: number,
): SimState {
  // Seed RNG at the start of each freshWorld call for deterministic cluster generation
  seedRng(42);
  let capacityKg = WORLD.CAPACITY_KG;
  let frac = WORLD.INITIAL_POLLUTION_FRAC;
  if (capacityKgOrFrac !== undefined && pollutionFrac !== undefined) {
    capacityKg = capacityKgOrFrac;
    frac = pollutionFrac;
  } else if (capacityKgOrFrac !== undefined) {
    // Single arg: treat as capacity (backward compat)
    capacityKg = capacityKgOrFrac;
    frac = WORLD.INITIAL_POLLUTION_FRAC;
  }
  const pollutionKg = capacityKg * frac;
  const collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
  const { clusters, remainingKg } = generateClusters(
    WORLD.ACTIVE_CLUSTER_TARGET,
    collectableKg,
  );
  return {
    world: {
      worldId: 0,
      capacityKg,
      pollutionKg,
      collectableKg: remainingKg,
      hiddenKg: pollutionKg - collectableKg,
      status: worldStatus(pollutionKg, capacityKg),
      generationRateKgH: 0,
      demandKgH: 0,
      burnedKg: 0,
      activePlayers: 0,
      seedPollutionKg: pollutionKg,
      generatedKg: 0,
      invariantSkewKg: 0,
      tickIndex: 0,
      treasuryTox: PROTECTION.TREASURY_SEED_TOX,
      lastTick: 0,
    },
    players: [],
    clusters,
    burnZone: {
      status: "inactive",
      x: 0,
      y: 0,
      nextSpawnAt: 60_000,
      expiresAt: 0,
    },
    ledger: [],
  };
}

export interface PlayerOpts {
  hasBase?: boolean;
  baseX?: number;
  baseY?: number;
  storageKg?: number;
  queuedKg?: number;
  sessionId?: string;
  sliceIndex?: number;
  toxBalance?: number;
  solBalance?: number;
  lastActiveAt?: number;
  protection?: Protection;
  auto?: boolean;
  cargoKg?: number;
}

export function makePlayer(
  id: string | number,
  opts: PlayerOpts = {},
  since = 1_000_000,
): SimPlayer {
  const cx = WORLD.MAP_SIZE / 2;
  const baseX = opts.baseX ?? cx;
  const baseY = opts.baseY ?? cx;
  return {
    id,
    worldId: 0,
    hasBase: opts.hasBase ?? false,
    baseX,
    baseY,
    solBalance: opts.solBalance ?? WORLD.GENESIS_GRANT_SOL,
    toxBalance: opts.toxBalance ?? 0,
    totalCollectedKg: 0,
    totalBurnedKg: 0,
    toxFromNormal: 0,
    toxFromZone: 0,
    storageKg: opts.storageKg ?? 0,
    processing: {
      queuedKg: opts.queuedKg ?? 0,
      since,
      sessionId: opts.sessionId,
      sliceIndex: opts.sliceIndex ?? 0,
    },
    levels: { cargo: 1, recharge: 1, battery: 1, storage: 1 },
    lastActiveAt: opts.lastActiveAt ?? since,
    protection: opts.protection ?? { state: "normal" },
    robot: {
      state: "idle",
      x: baseX,
      y: baseY,
      fromX: baseX,
      fromY: baseY,
      departAt: 0,
      targetClusterId: undefined,
      battery: UPGRADES.battery.caps[0],
      cargoKg: opts.cargoKg ?? 0,
      arriveAt: undefined,
      busyUntil: undefined,
      auto: opts.auto ?? true,
      totalTrips: 0,
    },
  };
}

export interface MakePlayersOpts {
  seed?: number;
  autoFraction?: number;
  storageFraction?: number;
  queueFraction?: number;
  levelPool?: number[];
}

export function makePlayers(
  count: number,
  opts: MakePlayersOpts = {},
): SimPlayer[] {
  const autoFrac = opts.autoFraction ?? 0.5;
  const storageFrac = opts.storageFraction ?? 0.3;
  const queueFrac = opts.queueFraction ?? 0.2;
  const levelPool = opts.levelPool ?? [1, 1, 1, 2, 3, 5];

  return Array.from({ length: count }, (_, i) => {
    const lv = levelPool[i % levelPool.length];
    const bx = 100 + ((i * 7919) % 800);
    const by = 100 + ((i * 6271) % 800);
    const storageKg =
      rngFrac() < storageFrac
        ? Math.floor(rngFrac() * UPGRADES.storage.caps[lv - 1])
        : 0;
    const queuedKg =
      rngFrac() < queueFrac ? 10 + Math.floor(rngFrac() * 40) : 0;
    return makePlayer(i, {
      hasBase: true,
      baseX: bx,
      baseY: by,
      storageKg,
      queuedKg,
      sessionId: queuedKg > 0 ? `${i}:q` : undefined,
      auto: i / count < autoFrac,
    });
  });
}

export function simWithPlayers(
  players: SimPlayer[],
  capacityKg = WORLD.CAPACITY_KG,
  pollutionFrac = WORLD.INITIAL_POLLUTION_FRAC,
): SimState {
  const state = freshWorld(capacityKg, pollutionFrac);
  const heldKg = players.reduce(
    (a, p) => a + p.storageKg + p.processing.queuedKg + p.robot.cargoKg,
    0,
  );
  if (heldKg > 0) {
    state.world.collectableKg = Math.max(0, state.world.collectableKg - heldKg);
  }
  state.players.push(...players);
  return state;
}

// ---------------------------------------------------------------------------
// Invariant check
// ---------------------------------------------------------------------------

export function simInvariant(state: SimState): {
  massBalance: number;
  poolBalance: number;
} {
  const { world, players, clusters } = state;
  const sums = players.reduce(
    (acc, p) => ({
      cargoKg: acc.cargoKg + p.robot.cargoKg,
      storageKg: acc.storageKg + p.storageKg,
      processingKg: acc.processingKg + p.processing.queuedKg,
    }),
    { cargoKg: 0, storageKg: 0, processingKg: 0 },
  );
  const clusterKg = clusters.reduce((s, c) => s + c.kg, 0);
  const massBalance =
    world.pollutionKg + world.burnedKg - world.seedPollutionKg - world.generatedKg;
  const poolBalance =
    world.hiddenKg +
    world.collectableKg +
    clusterKg +
    sums.cargoKg +
    sums.storageKg +
    sums.processingKg -
    (world.pollutionKg - world.generatedKg);
  return { massBalance, poolBalance };
}

// ---------------------------------------------------------------------------
// Robot step
// ---------------------------------------------------------------------------

function stepRobot(
  p: SimPlayer,
  clusterMap: Map<string | number, SimCluster>,
  now: number,
  dtReal: number,
  drainMult: number,
  assignments: Map<string | number, string | number>,
): boolean {
  if (!p.hasBase) return false;
  const base = { x: p.baseX, y: p.baseY };
  const r = { ...p.robot };
  const bCap = batteryCap(p);
  const rechargeRate = UPGRADES.recharge.rates[p.levels.recharge - 1];
  const cCap = cargoCap(p);
  const sCap = storageCap(p);

  const releaseReservation = () => {
    if (r.targetClusterId) {
      const c = clusterMap.get(r.targetClusterId);
      if (c && c.reservedBy === p.id) c.reservedBy = undefined;
      r.targetClusterId = undefined;
    }
  };

  const goHome = (fromX: number, fromY: number) => {
    r.state = "to_base" as const;
    r.fromX = fromX;
    r.fromY = fromY;
    r.departAt = now;
    r.arriveAt = now + (dist(base, { x: fromX, y: fromY }) / ROBOT.SPEED_M_S) * 1000;
  };

  switch (r.state) {
    case "idle": {
      if (r.cargoKg > 0 && p.storageKg < sCap) {
        const unload = Math.min(r.cargoKg, sCap - p.storageKg);
        r.cargoKg -= unload;
        p.storageKg += unload;
        p.totalCollectedKg += unload;
      }
      if (r.auto && r.cargoKg < cCap) {
        const assigned = assignments.get(p.id);
        const target = assigned ? clusterMap.get(assigned) : undefined;
        if (target && target.kg > 0) {
          const bestD = dist(r, target);
          target.reservedBy = p.id;
          r.state = "to_cluster" as const;
          r.targetClusterId = target.id;
          r.fromX = r.x;
          r.fromY = r.y;
          r.departAt = now;
          r.arriveAt = now + (bestD / ROBOT.SPEED_M_S) * 1000;
        } else if (r.battery < bCap) {
          r.state = "recharging" as const;
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
        (dist(base, r) / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING + ROBOT.BATTERY_SAFETY_MARGIN;
      if (!target || target.kg <= 0 || r.battery <= returnBattery) {
        releaseReservation();
        goHome(r.x, r.y);
        break;
      }
      if (now >= (r.arriveAt ?? Infinity)) {
        r.x = target.x;
        r.y = target.y;
        r.state = "collecting" as const;
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
          target.kg -= amount;
          if (target.kg <= 0) clusterMap.delete(target.id);
          r.totalTrips += 1;
        }
        releaseReservation();
        goHome(target ? target.x : r.x, target ? target.y : r.y);
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
        r.state = "unloading" as const;
        r.busyUntil = now + ROBOT.UNLOAD_TIME_S * 1000;
      }
      break;
    }
    case "unloading": {
      if (now >= (r.busyUntil ?? now)) {
        const space = sCap - p.storageKg;
        const unload = Math.min(r.cargoKg, space);
        p.storageKg += unload;
        p.totalCollectedKg += unload;
        r.cargoKg -= unload;
        r.state = r.battery < bCap * ROBOT.LOW_BATTERY_FRAC ? "recharging" : "idle";
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

  p.robot = r;
  return robotDemands(r.state);
}

// ---------------------------------------------------------------------------
// Full tick
// ---------------------------------------------------------------------------

export interface TickReturn {
  events: Array<{ type: string; message: string }>;
  invariantMass: number;
  invariantPool: number;
}

/** Run a single tick. Returns events and invariant residuals. */
export function simTick(
  state: SimState,
  nowMs: number,
  zoneActive: boolean | ((t: number) => boolean) = false,
): TickReturn {
  const dtReal = WORLD.TICK_SECONDS;
  const { world, players, clusters, burnZone } = state;
  const clusterMap = new Map(clusters.map((c) => [c.id, c]));
  const events: Array<{ type: string; message: string }> = [];

  // 1) AFK detection
  for (const p of players) {
    if (p.hasBase) {
      p.protection = applyIdleCheck(p.protection, p.lastActiveAt, nowMs);
    }
  }

  // 2) Base generation → pollution
  const active = players.filter((p) => p.hasBase);
  const generating = active.filter((p) => !isSealed(p.protection.state));
  const genKgH = generating.length * WORLD.BASE_GEN_KG_H;
  world.pollutionKg = Math.min(world.capacityKg, world.pollutionKg + genKgH * TICK_GAME_H);
  const criticalNow = world.pollutionKg / world.capacityKg >= WORLD.CRITICAL_FRAC;
  world.generatedKg += genKgH * TICK_GAME_H;

  // 3) Batch allocation
  const batchAssignments = batchAllocation(
    players
      .filter(
        (p) =>
          p.hasBase &&
          !isSealed(p.protection.state) &&
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
    [...clusterMap.values()]
      .filter((c) => c.kg > 0 && !c.reservedBy)
      .map((c) => ({ id: c.id, x: c.x, y: c.y, kg: c.kg })),
    WORLD.BATCH_SIZE,
    { tripCost: (_r: { id: string | number }, d: number) => batteryForTrip(d) },
  );

  let demandKgH = 0;
  for (const p of players) {
    if (isSealed(p.protection.state)) continue;
    const drainMult = drainMultiplier(p.protection, nowMs, criticalNow);
    const isActive = stepRobot(p, clusterMap, nowMs, dtReal, drainMult, batchAssignments);
    if (isActive) demandKgH += WORLD.DEMAND_REF_KG_H;
  }

  // Release stale reservations
  for (const c of clusterMap.values()) {
    if (!c.reservedBy) continue;
    const owner = players.find((p) => p.id === c.reservedBy);
    const stillTargeting =
      owner &&
      owner.robot.targetClusterId === c.id &&
      (owner.robot.state === "to_cluster" || owner.robot.state === "collecting");
    if (!stillTargeting) c.reservedBy = undefined;
  }

  // 4) Replenishment
  const replFracH = replenishmentModelC(genKgH, demandKgH);
  const unlockKg = Math.min(world.hiddenKg, world.hiddenKg * replFracH * TICK_GAME_H);
  world.collectableKg += unlockKg;
  world.hiddenKg -= unlockKg;

  // 5) Burn zone
  if (typeof zoneActive === "function") {
    burnZone.status = zoneActive(nowMs) ? "active" : "inactive";
  } else {
    burnZone.status = zoneActive ? "active" : "inactive";
  }
  const zoneIsActive = burnZone.status === "active";

  // 6) Burn processing
  for (const p of players) {
    if (p.processing.queuedKg <= 0) continue;

    const sessionId = p.processing.sessionId ?? `${p.id}:${p.processing.since || nowMs}`;
    const sliceIndex = p.processing.sliceIndex ?? 0;
    const burnKg = Math.min(p.processing.queuedKg, WORLD.PROCESSING_KG_PER_S * dtReal);
    const burnState: BurnSlice = { sessionId, queuedKg: p.processing.queuedKg, sliceIndex };
    const slice = computeBurnSlice(burnState, burnKg, zoneIsActive);

    const existing = state.ledger.find((l) => l.key === slice.key);
    const alreadyRewarded = !!existing;
    const next = advanceBurn(burnState, burnKg, alreadyRewarded);

    p.processing.queuedKg = next.queuedKg;
    p.processing.sliceIndex = next.sliceIndex;
    p.processing.sessionId = sessionId;

    if (!alreadyRewarded) {
      state.ledger.push({
        playerId: p.id,
        key: slice.key,
        kind: slice.kind,
        kg: slice.kg,
        tox: slice.tox,
      });
      p.toxBalance += slice.tox;
      p.totalBurnedKg += burnKg;
      p.toxFromNormal += slice.kind === "normal" ? slice.tox : 0;
      p.toxFromZone += slice.kind === "burn_zone" ? slice.tox : 0;
      world.pollutionKg = applyBurnToPollution(world.pollutionKg, burnKg);
      world.burnedKg += burnKg;
    }
  }

  // 7) World status / collapse
  let status = worldStatus(world.pollutionKg, world.capacityKg);
  let newWorldId = world.worldId;

  if (world.pollutionKg >= world.capacityKg) {
    newWorldId = world.worldId + 1;
    for (const c of clusterMap.values()) clusterMap.delete(c.id);
    status = "safe";
    events.push({ type: "collapse", message: "World collapse" });

    let carriedKg = 0;
    for (const p of players) {
      if (p.hasBase) p.protection = onWorldCollapse(p.protection, nowMs);
      if (p.hasBase && keepsHeldOnCollapse(p.protection.state)) {
        carriedKg += p.storageKg + p.robot.cargoKg + p.processing.queuedKg;
      }
    }

    const seed = collapseSeed(world.capacityKg, carriedKg);
    world.pollutionKg = seed.pollutionKg;
    world.hiddenKg = seed.hiddenKg;
    world.collectableKg = seed.collectableKg;
    world.burnedKg = 0;
    world.generatedKg = 0;
    world.seedPollutionKg = seed.pollutionKg;

    for (const p of players) {
      const keep = p.hasBase && keepsHeldOnCollapse(p.protection.state);
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
        since: nowMs,
        sessionId: keep ? p.processing.sessionId : undefined,
        sliceIndex: keep ? p.processing.sliceIndex : 0,
      };
      p.robot = {
        state: "idle",
        targetClusterId: undefined,
        x: p.baseX,
        y: p.baseY,
        fromX: p.baseX,
        fromY: p.baseY,
        cargoKg: held.cargo,
        battery: batteryCap(p),
        departAt: nowMs,
        arriveAt: undefined,
        busyUntil: undefined,
        auto: true,
        totalTrips: 0,
      };
    }
  }

  // 8) Emergency Launch completion
  for (const p of players) {
    const prot = p.protection;
    if (prot.state !== "launching") continue;
    if (prot.launchAt == null || nowMs < prot.launchAt) continue;

    world.treasuryTox = Math.max(
      0,
      world.treasuryTox * (1 - PROTECTION.TREASURY_BURN_FRAC),
    );
    world.collectableKg += p.storageKg + p.robot.cargoKg + p.processing.queuedKg;

    p.hasBase = false;
    p.baseX = WORLD.MAP_SIZE / 2;
    p.baseY = WORLD.MAP_SIZE / 2;
    p.storageKg = 0;
    p.processing = { queuedKg: 0, since: nowMs, sessionId: undefined, sliceIndex: 0 };
    p.toxBalance = Math.max(0, p.toxBalance - PROTECTION.LAUNCH_FEE_TOX);
    p.solBalance += WORLD.BASE_PRICE_SOL;
    p.robot = {
      state: "idle",
      x: WORLD.MAP_SIZE / 2,
      y: WORLD.MAP_SIZE / 2,
      fromX: WORLD.MAP_SIZE / 2,
      fromY: WORLD.MAP_SIZE / 2,
      departAt: nowMs,
      targetClusterId: undefined,
      battery: batteryCap(p),
      cargoKg: 0,
      arriveAt: undefined,
      busyUntil: undefined,
      auto: true,
      totalTrips: 0,
    };
    p.protection = { state: "normal" };
  }

  // Update world
  world.worldId = newWorldId;
  world.status = status;
  world.generationRateKgH = genKgH;
  world.demandKgH = demandKgH;
  world.activePlayers = active.length;
  world.tickIndex += 1;
  world.lastTick = nowMs;
  world.invariantSkewKg = Math.abs(
    world.pollutionKg + world.burnedKg - world.seedPollutionKg - world.generatedKg,
  );

  state.clusters = [...clusterMap.values()];

  const inv = simInvariant(state);
  return {
    events,
    invariantMass: inv.massBalance,
    invariantPool: inv.poolBalance,
  };
}

// ---------------------------------------------------------------------------
// Run N ticks — canonical API matching all test suites
// ---------------------------------------------------------------------------

export interface RunTicksReturn {
  state: SimState;
  mass: number;
  pool: number;
}

/**
 * Run `count` ticks from the world's lastTick.
 * Returns { state, mass, pool } where mass/pool are the final invariant residuals.
 */
export function runTicks(state: SimState, count: number): RunTicksReturn {
  let now = state.world.lastTick;
  for (let i = 0; i < count; i++) {
    now += WORLD.TICK_SECONDS * 1000;
    simTick(state, now, false);
  }
  const inv = simInvariant(state);
  return { state, mass: inv.massBalance, pool: inv.poolBalance };
}
