// TOXIC WORLD — Sprint 2.4 oracle simulator (headless, deterministic).
//
// Mirrors src/convex/world.ts tick step-for-step, but calls the SAME pure
// functions the production tick calls (engine.ts, economy.ts, gameParams.ts)
// so the harness validates the real engine math on reproducible inputs.
// No Convex imports — runs under `bun test`.

import {
  BURN_ZONE,
  BURN_ZONE_MULTIPLIER,
  REPLENISHMENT,
  ROBOT,
  UPGRADES,
  WORLD,
  batteryForTrip,
} from "../src/convex/gameParams";
import {
  checkWasteInvariant,
  replenishmentModelC,
  robotDemands,
  selectCluster,
  worldStatus,
  type ClusterLike,
} from "../src/convex/engine";
import {
  advanceBurn,
  applyBurnToPollution,
  computeBurnSlice,
} from "../src/convex/economy";

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60;
const TICK_MS = WORLD.TICK_SECONDS * 1000;

// deterministic PRNG (mulberry32) — repeatable scenarios
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimPlayer {
  id: number;
  worldId: number;
  hasBase: boolean;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  departAt: number;
  arriveAt: number;
  busyUntil: number;
  targetClusterId: number | null;
  state: "idle" | "to_cluster" | "collecting" | "to_base" | "unloading" | "recharging";
  battery: number;
  cargoKg: number;
  storageKg: number;
  queuedKg: number;
  sessionId: string | null;
  sliceIndex: number;
  auto: boolean;
  autoQueue: boolean; // simulate the player hitting "process storage"
  totalTrips: number;
  totalCollectedKg: number;
  totalBurnedKg: number;
  toxBalance: number;
  toxFromNormal: number;
  toxFromZone: number;
  levels: { cargo: number; recharge: number; battery: number; storage: number };
}

export interface SimCluster {
  id: number;
  x: number;
  y: number;
  kg: number;
  reservedBy: number | null;
}

export interface SimZone {
  status: "active" | "inactive";
  x: number;
  y: number;
  spawnedAt: number;
  expiresAt: number;
  nextSpawnAt: number;
}

export interface SimWorld {
  worldId: number;
  capacityKg: number;
  seedPollutionKg: number;
  pollutionKg: number;
  hiddenKg: number;
  collectableKg: number;
  burnedKg: number;
  generatedKg: number;
  status: "safe" | "critical" | "collapsed";
  resetCount: number;
  tickCount: number;
  lastTick: number;
  players: SimPlayer[];
  clusters: SimCluster[];
  zone: SimZone | null;
  ledger: Set<string>;
  events: string[];
  rng: () => number;
  invariantHistory: { tick: number; massBalance: number; poolBalance: number }[];
  /** per-tick demand (kg/h) — active robots × DEMAND_REF, like the tick */
  demandHistory: number[];
}

export interface SimOptions {
  players?: number;
  seed?: number;
  capacityKg?: number;
  auto?: boolean;
  autoQueue?: boolean;
  levels?: Partial<SimPlayer["levels"]>;
  /** initial processing queue (kg) for every player */
  queuedKg?: number;
  /** initial pollution override (kg) — for collapse / critical scenarios */
  pollutionKg?: number;
  /** fraction of players that are "active" (auto robots) — activity scenarios */
  activeFraction?: number;
  /** cluster target (defaults to WORLD.ACTIVE_CLUSTER_TARGET) */
  clusterTarget?: number;
}

const level = (v?: number) => (v && v >= 1 && v <= 5 ? v : 1);

export function createSimWorld(opts: SimOptions = {}): SimWorld {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);
  const capacityKg = opts.capacityKg ?? WORLD.CAPACITY_KG;
  const pollutionKg =
    opts.pollutionKg ?? capacityKg * WORLD.INITIAL_POLLUTION_FRAC;
  const collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
  const count = opts.players ?? 20;
  const activeFraction = opts.activeFraction ?? 1;
  const levels = opts.levels ?? {};

  const world: SimWorld = {
    worldId: 0,
    capacityKg,
    seedPollutionKg: pollutionKg,
    pollutionKg,
    hiddenKg: pollutionKg - collectableKg,
    collectableKg,
    burnedKg: 0,
    generatedKg: 0,
    status: "safe",
    resetCount: 0,
    tickCount: 0,
    lastTick: 0,
    players: [],
    clusters: [],
    zone: null,
    ledger: new Set(),
    events: [],
    rng,
    invariantHistory: [],
    demandHistory: [],
  };

  for (let i = 0; i < count; i++) {
    const lv = {
      cargo: level(levels.cargo),
      recharge: level(levels.recharge),
      battery: level(levels.battery),
      storage: level(levels.storage),
    };
    const bx = 120 + rng() * (WORLD.MAP_SIZE - 240);
    const by = 120 + rng() * (WORLD.MAP_SIZE - 240);
    const auto = rng() < activeFraction;
    world.players.push({
      id: i,
      worldId: 0,
      hasBase: true,
      baseX: bx,
      baseY: by,
      x: bx,
      y: by,
      fromX: bx,
      fromY: by,
      departAt: 0,
      arriveAt: 0,
      busyUntil: 0,
      targetClusterId: null,
      state: "idle",
      battery: UPGRADES.battery.caps[lv.battery - 1],
      cargoKg: 0,
      storageKg: 0,
      queuedKg: opts.queuedKg ?? 0,
      sessionId: null,
      sliceIndex: 0,
      auto: opts.auto ?? auto,
      autoQueue: opts.autoQueue ?? true,
      totalTrips: 0,
      totalCollectedKg: 0,
      totalBurnedKg: 0,
      toxBalance: 0,
      toxFromNormal: 0,
      toxFromZone: 0,
      levels: lv,
    });
  }

  // seed the map with clusters, mirroring spawnClusters
  const target = opts.clusterTarget ?? WORLD.ACTIVE_CLUSTER_TARGET;
  spawnClusters(world, target, 0);
  return world;
}

function spawnClusters(w: SimWorld, target: number, _current: number): void {
  let spawned = 0;
  while (
    w.clusters.length < target &&
    w.collectableKg >= WORLD.CLUSTER_MIN_KG &&
    spawned < WORLD.MAX_CLUSTER_SPAWNS_PER_TICK
  ) {
    const size = Math.min(
      WORLD.CLUSTER_MIN_KG + w.rng() * (WORLD.CLUSTER_MAX_KG - WORLD.CLUSTER_MIN_KG),
      w.collectableKg,
    );
    w.clusters.push({
      id: w.clusters.length,
      x: w.rng() * WORLD.MAP_SIZE,
      y: w.rng() * WORLD.MAP_SIZE,
      kg: size,
      reservedBy: null,
    });
    w.collectableKg -= size;
    spawned += 1;
  }
}

const batteryCapOf = (p: SimPlayer) =>
  UPGRADES.battery.caps[p.levels.battery - 1];
const cargoCapOf = (p: SimPlayer) => UPGRADES.cargo.caps[p.levels.cargo - 1];
const storageCapOf = (p: SimPlayer) =>
  UPGRADES.storage.caps[p.levels.storage - 1];

function stepRobot(
  w: SimWorld,
  p: SimPlayer,
  clusterMap: Map<number, SimCluster>,
  now: number,
  dtReal: number,
): boolean {
  if (!p.hasBase) return false;
  const base = { x: p.baseX, y: p.baseY };
  const bCap = batteryCapOf(p);
  const cCap = cargoCapOf(p);
  const sCap = storageCapOf(p);
  const rechargeRate = UPGRADES.recharge.rates[p.levels.recharge - 1];

  const releaseReservation = () => {
    if (p.targetClusterId != null) {
      const c = clusterMap.get(p.targetClusterId);
      if (c && c.reservedBy === p.id) c.reservedBy = null;
      p.targetClusterId = null;
    }
  };
  const goHome = (fromX: number, fromY: number) => {
    p.state = "to_base";
    p.fromX = fromX;
    p.fromY = fromY;
    p.departAt = now;
    p.arriveAt =
      now +
      (Math.hypot(base.x - fromX, base.y - fromY) / ROBOT.SPEED_M_S) * 1000;
  };

  switch (p.state) {
    case "idle": {
      if (p.cargoKg > 0 && p.storageKg < sCap) {
        const unload = Math.min(p.cargoKg, sCap - p.storageKg);
        p.cargoKg -= unload;
        p.storageKg += unload;
        p.totalCollectedKg += unload;
      }
      if (p.auto && p.cargoKg < cCap) {
        const found = selectCluster(p, [...clusterMap.values()]);
        if (found) {
          const c = found.cluster as SimCluster;
          const d = found.distance;
          if (p.battery >= batteryForTrip(d)) {
            c.reservedBy = p.id;
            p.state = "to_cluster";
            p.targetClusterId = c.id;
            p.fromX = p.x;
            p.fromY = p.y;
            p.departAt = now;
            p.arriveAt = now + (d / ROBOT.SPEED_M_S) * 1000;
          } else if (p.battery < bCap) {
            p.state = "recharging";
          }
        }
      }
      break;
    }
    case "to_cluster": {
      const target = p.targetClusterId != null ? clusterMap.get(p.targetClusterId) : undefined;
      const dest = target ?? base;
      p.battery = Math.max(0, p.battery - ROBOT.DRAIN_MOVING * dtReal);
      const total = (p.arriveAt ?? now) - p.departAt;
      if (total > 0) {
        const t = Math.min(1, (now - p.departAt) / total);
        p.x = p.fromX + (dest.x - p.fromX) * t;
        p.y = p.fromY + (dest.y - p.fromY) * t;
      }
      const returnBattery =
        (Math.hypot(base.x - p.x, base.y - p.y) / ROBOT.SPEED_M_S) *
          ROBOT.DRAIN_MOVING +
        ROBOT.BATTERY_SAFETY_MARGIN;
      if (!target || target.kg <= 0 || p.battery <= returnBattery) {
        releaseReservation();
        goHome(p.x, p.y);
        break;
      }
      if (now >= (p.arriveAt ?? Infinity)) {
        p.x = target.x;
        p.y = target.y;
        p.state = "collecting";
        p.busyUntil = now + ROBOT.COLLECT_TIME_S * 1000;
      }
      break;
    }
    case "collecting": {
      p.battery = Math.max(0, p.battery - ROBOT.DRAIN_COLLECTING * dtReal);
      if (now >= (p.busyUntil ?? now)) {
        const target = p.targetClusterId != null ? clusterMap.get(p.targetClusterId) : undefined;
        if (target && target.kg > 0) {
          const amount = Math.min(cCap - p.cargoKg, target.kg);
          p.cargoKg += amount;
          target.kg -= amount;
          if (target.kg <= 0) clusterMap.delete(target.id);
          p.totalTrips += 1;
        }
        releaseReservation();
        goHome(target ? target.x : p.x, target ? target.y : p.y);
      }
      break;
    }
    case "to_base": {
      p.battery = Math.max(0, p.battery - ROBOT.DRAIN_MOVING * dtReal);
      const total = (p.arriveAt ?? now) - p.departAt;
      if (total > 0) {
        const t = Math.min(1, (now - p.departAt) / total);
        p.x = p.fromX + (base.x - p.fromX) * t;
        p.y = p.fromY + (base.y - p.fromY) * t;
      }
      if (now >= (p.arriveAt ?? Infinity)) {
        p.x = base.x;
        p.y = base.y;
        p.state = "unloading";
        p.busyUntil = now + ROBOT.UNLOAD_TIME_S * 1000;
      }
      break;
    }
    case "unloading": {
      if (now >= (p.busyUntil ?? now)) {
        const space = sCap - p.storageKg;
        const unload = Math.min(p.cargoKg, space);
        p.storageKg += unload;
        p.totalCollectedKg += unload;
        p.cargoKg -= unload;
        p.state = p.battery < bCap * ROBOT.LOW_BATTERY_FRAC ? "recharging" : "idle";
        if (p.autoQueue && p.storageKg > 0) {
          // simulate the player's queueProcessing action
          const hasSession = p.queuedKg > 0 && !!p.sessionId;
          p.queuedKg += p.storageKg;
          p.storageKg = 0;
          if (!hasSession) p.sessionId = `sim:${p.id}:${p.worldId}:${w.tickCount}`;
          if (!hasSession) p.sliceIndex = 0;
        }
      }
      break;
    }
    case "recharging": {
      p.battery = Math.min(bCap, p.battery + rechargeRate * dtReal);
      if (p.battery >= bCap) {
        p.battery = bCap;
        p.state = "idle";
      }
      break;
    }
  }
  return robotDemands(p.state);
}

function stepZone(w: SimWorld, now: number): boolean {
  if (!w.zone) {
    w.zone = {
      status: "inactive",
      x: 0,
      y: 0,
      spawnedAt: 0,
      expiresAt: 0,
      nextSpawnAt:
        now +
        (BURN_ZONE.MIN_COOLDOWN_S + w.rng() * (BURN_ZONE.MAX_COOLDOWN_S - BURN_ZONE.MIN_COOLDOWN_S)) *
          1000,
    };
  }
  const z = w.zone;
  if (z.status === "inactive" && now >= z.nextSpawnAt) {
    z.status = "active";
    z.x = 120 + w.rng() * (WORLD.MAP_SIZE - 240);
    z.y = 120 + w.rng() * (WORLD.MAP_SIZE - 240);
    z.spawnedAt = now;
    z.expiresAt =
      now +
      (BURN_ZONE.MIN_ACTIVE_S + w.rng() * (BURN_ZONE.MAX_ACTIVE_S - BURN_ZONE.MIN_ACTIVE_S)) *
        1000;
    w.events.push(`burn_zone active ${Math.round(z.x)},${Math.round(z.y)}`);
  } else if (z.status === "active" && now >= z.expiresAt) {
    z.status = "inactive";
    z.nextSpawnAt =
      now +
      (BURN_ZONE.MIN_COOLDOWN_S + w.rng() * (BURN_ZONE.MAX_COOLDOWN_S - BURN_ZONE.MIN_COOLDOWN_S)) *
        1000;
    w.events.push("burn_zone expired");
  }
  return z.status === "active";
}

/** Burn processing for one player — mirrors world.ts §6 exactly. */
export function processPlayerBurn(
  w: SimWorld,
  p: SimPlayer,
  zoneActive: boolean,
  dtReal: number,
): void {
  if (p.queuedKg <= 0) return;
  const sessionId = p.sessionId ?? `sim:${p.id}:${w.tickCount}`;
  const sliceIndex = p.sliceIndex ?? 0;
  const burnKg = Math.min(p.queuedKg, WORLD.PROCESSING_KG_PER_S * dtReal);
  const slice = computeBurnSlice(
    { sessionId, queuedKg: p.queuedKg, sliceIndex },
    burnKg,
    zoneActive,
  );
  const alreadyRewarded = w.ledger.has(slice.key);
  const next = advanceBurn(
    { sessionId, queuedKg: p.queuedKg, sliceIndex },
    burnKg,
    alreadyRewarded,
  );
  p.queuedKg = next.queuedKg;
  p.sliceIndex = next.sliceIndex;
  p.sessionId = sessionId;
  if (!alreadyRewarded) {
    w.ledger.add(slice.key);
    p.toxBalance += slice.tox;
    p.toxFromNormal += slice.kind === "normal" ? slice.tox : 0;
    p.toxFromZone += slice.kind === "burn_zone" ? slice.tox : 0;
    p.totalBurnedKg += burnKg;
    w.pollutionKg = applyBurnToPollution(w.pollutionKg, burnKg);
    w.burnedKg += burnKg;
  }
}

/** Advance the world one tick — mirrors world.ts `tick` mutation. */
export function tickSim(w: SimWorld): void {
  const now = w.lastTick + TICK_MS;
  const dtReal = WORLD.TICK_SECONDS;
  const worldId = w.worldId;

  // 1) base generation → pollution
  const active = w.players.filter((p) => p.hasBase);
  const genKgH = active.length * WORLD.BASE_GEN_KG_H;
  w.pollutionKg = Math.min(w.capacityKg, w.pollutionKg + genKgH * TICK_GAME_H);
  w.generatedKg += genKgH * TICK_GAME_H;

  // 2) robots (spatial state machine)
  const clusterMap = new Map(w.clusters.map((c) => [c.id, c]));
  let demandKgH = 0;
  for (const p of w.players) {
    if (stepRobot(w, p, clusterMap, now, dtReal)) demandKgH += WORLD.DEMAND_REF_KG_H;
  }

  // release stale reservations
  for (const c of clusterMap.values()) {
    if (c.reservedBy == null) continue;
    const owner = w.players.find((p) => p.id === c.reservedBy);
    const stillTargeting =
      owner &&
      owner.targetClusterId === c.id &&
      (owner.state === "to_cluster" || owner.state === "collecting");
    if (!stillTargeting) c.reservedBy = null;
  }

  // 3) dynamic replenishment — Model C
  const replFracH = replenishmentModelC(genKgH, demandKgH);
  const unlockKg = Math.min(
    w.hiddenKg,
    w.hiddenKg * replFracH * TICK_GAME_H,
  );
  w.collectableKg += unlockKg;
  w.hiddenKg -= unlockKg;

  // 4) keep the map stocked
  spawnClusters(w, WORLD.ACTIVE_CLUSTER_TARGET, clusterMap.size);

  // 5) Burn Zone lifecycle
  const zoneActive = stepZone(w, now);

  // 6) processing / burning → TOX-only rewards
  for (const p of w.players) processPlayerBurn(w, p, zoneActive, dtReal);

  // 7) world status / collapse
  w.status = worldStatus(w.pollutionKg, w.capacityKg);
  if (w.status === "collapsed") {
    w.worldId += 1;
    w.resetCount += 1;
    w.pollutionKg = w.capacityKg * WORLD.RESET_POLLUTION_FRAC;
    w.collectableKg = w.pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
    w.hiddenKg = w.pollutionKg - w.collectableKg;
    w.burnedKg = 0;
    w.generatedKg = 0;
    w.seedPollutionKg = w.pollutionKg;
    w.clusters = [];
    for (const p of w.players) {
      p.worldId = w.worldId;
      p.x = p.baseX;
      p.y = p.baseY;
      p.fromX = p.baseX;
      p.fromY = p.baseY;
      p.state = "idle";
      p.targetClusterId = null;
      p.cargoKg = 0;
      p.battery = batteryCapOf(p);
      p.queuedKg = 0;
      p.sessionId = null;
      p.sliceIndex = 0;
    }
    spawnClusters(w, WORLD.ACTIVE_CLUSTER_TARGET, 0);
    w.status = "safe";
    w.events.push(`world ${w.worldId} seeded`);
  }

  w.tickCount += 1;
  w.lastTick = now;

  // 8) waste invariant (mass balance + pool conservation)
  const clusterKg = w.clusters.reduce((s, c) => s + c.kg, 0);
  const cargoKg = w.players.reduce((s, p) => s + p.cargoKg, 0);
  const storageKg = w.players.reduce((s, p) => s + p.storageKg, 0);
  const processingKg = w.players.reduce((s, p) => s + p.queuedKg, 0);
  const inv = checkWasteInvariant({
    initialWasteKg: w.seedPollutionKg,
    generatedKg: w.generatedKg,
    pollutionKg: w.pollutionKg,
    burnedKg: w.burnedKg,
    hiddenKg: w.hiddenKg,
    collectableKg: w.collectableKg,
    clusterKg,
    cargoKg,
    storageKg,
    processingKg,
  });
  w.invariantHistory.push({
    tick: w.tickCount,
    massBalance: inv.massBalance,
    poolBalance: inv.poolBalance,
  });
  w.demandHistory.push(demandKgH);
}

/** Run `ticks` sim ticks, returning elapsed ms. */
export function runSim(w: SimWorld, ticks: number): { ms: number; perTickMs: number } {
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) tickSim(w);
  const ms = performance.now() - t0;
  return { ms, perTickMs: ms / ticks };
}

export type { ClusterLike };
