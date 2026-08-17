// TOXIC WORLD — deterministic headless oracle simulator (Sprint 2.4 → 2.6).
//
// Mirrors the production world tick (`src/convex/world.ts`) step-for-step
// using the SAME pure functions the tick calls (`engine.ts`, `economy.ts`,
// `gameParams.ts`), so the headless tests validate the real production math —
// not a copy. Uses a seeded RNG so every scenario is reproducible.
//
// Deliberately NOT imported by any Convex function; runs under `bun test`
// only. Mirrors world.ts as of Sprint 2.6, including the sharded robot and
// burn loops (WORLD.ROBOTS_PER_TICK).

import {
  batchAllocation,
  checkWasteInvariant,
  replenishmentModelC,
  robotDemands,
  worldStatus,
} from "../src/convex/engine";
import {
  advanceBurn,
  applyBurnToPollution,
  computeBurnSlice,
} from "../src/convex/economy";
import {
  BURN_ZONE,
  BURN_ZONE_MULTIPLIER,
  ROBOT,
  UPGRADES,
  WORLD,
  batteryForTrip,
} from "../src/convex/gameParams";

export type RobotState =
  | "idle"
  | "to_cluster"
  | "collecting"
  | "to_base"
  | "unloading"
  | "recharging";
export type WorldStatus = "safe" | "critical" | "collapsed";

export interface SimRobot {
  state: RobotState;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  departAt: number;
  targetClusterId: string | null;
  battery: number;
  cargoKg: number;
  arriveAt: number;
  busyUntil: number;
  auto: boolean;
  totalTrips: number;
}

export interface SimProcessing {
  queuedKg: number;
  since: number;
  sessionId: string | null;
  sliceIndex: number;
}

export interface SimLevels {
  cargo: number;
  recharge: number;
  battery: number;
  storage: number;
}

export interface SimPlayer {
  id: string;
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
  processing: SimProcessing;
  levels: SimLevels;
  robot: SimRobot;
}

export interface SimCluster {
  id: string;
  x: number;
  y: number;
  kg: number;
  reservedBy: string | null;
}

export interface SimWorld {
  worldId: number;
  capacityKg: number;
  pollutionKg: number;
  collectableKg: number;
  hiddenKg: number;
  status: WorldStatus;
  generationRateKgH: number;
  demandKgH: number;
  burnedKg: number;
  seedPollutionKg: number;
  generatedKg: number;
  invariantSkewKg: number;
  tickIndex: number;
}

export interface SimZone {
  status: "active" | "inactive";
  x: number;
  y: number;
  spawnedAt: number;
  expiresAt: number;
  nextSpawnAt: number;
  multiplier: number;
}

// --- seeded RNG (mulberry32) ------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- factories ---------------------------------------------------------------

export interface MakePlayerOptions {
  base?: boolean;
  level?: number;
  x?: number;
  y?: number;
  auto?: boolean;
  storageKg?: number;
  queuedKg?: number;
  sol?: number;
  tox?: number;
  worldId?: number;
}

export function makePlayer(
  id: string,
  opts: MakePlayerOptions = {},
): SimPlayer {
  const level = opts.level ?? 1;
  const bx = opts.x ?? WORLD.MAP_SIZE / 2;
  const by = opts.y ?? WORLD.MAP_SIZE / 2;
  return {
    id,
    worldId: opts.worldId ?? 0,
    hasBase: opts.base ?? false,
    baseX: opts.base ?? false ? bx : WORLD.MAP_SIZE / 2,
    baseY: opts.base ?? false ? by : WORLD.MAP_SIZE / 2,
    solBalance: opts.sol ?? 0,
    toxBalance: opts.tox ?? 0,
    totalCollectedKg: 0,
    totalBurnedKg: 0,
    toxFromNormal: 0,
    toxFromZone: 0,
    storageKg: opts.storageKg ?? 0,
    processing: {
      queuedKg: opts.queuedKg ?? 0,
      since: 0,
      sessionId: null,
      sliceIndex: 0,
    },
    levels: { cargo: level, recharge: level, battery: level, storage: level },
    robot: {
      state: "idle",
      x: bx,
      y: by,
      fromX: bx,
      fromY: by,
      departAt: 0,
      targetClusterId: null,
      battery: UPGRADES.battery.caps[level - 1],
      cargoKg: 0,
      arriveAt: 0,
      busyUntil: 0,
      auto: opts.auto ?? true,
      totalTrips: 0,
    },
  };
}

export interface MakePlayersOptions {
  seed?: number;
  autoFraction?: number;
  storageFraction?: number;
  queueFraction?: number;
  levelPool?: number[];
  worldId?: number;
}

/** n synthetic players, L1–L5 mix, random bases (seeded). */
export function makePlayers(n: number, opts: MakePlayersOptions = {}): SimPlayer[] {
  const rng = mulberry32(opts.seed ?? 1);
  const autoFraction = opts.autoFraction ?? 0.5;
  const storageFraction = opts.storageFraction ?? 0.3;
  const queueFraction = opts.queueFraction ?? 0.2;
  const levelPool = opts.levelPool ?? [1, 1, 1, 2, 3, 5]; // 50% L1, ~17% L5
  const players: SimPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const level = levelPool[Math.floor(rng() * levelPool.length)];
    const bx = 120 + rng() * (WORLD.MAP_SIZE - 240);
    const by = 120 + rng() * (WORLD.MAP_SIZE - 240);
    players.push(
      makePlayer(`p${i}`, {
        base: true,
        level,
        x: bx,
        y: by,
        auto: rng() < autoFraction,
        storageKg:
          rng() < storageFraction
            ? Math.floor(rng() * UPGRADES.storage.caps[level - 1])
            : 0,
        queuedKg:
          rng() < queueFraction ? 10 + Math.floor(rng() * 40) : 0,
        sol: rng() < 0.5 ? WORLD.BASE_PRICE_SOL : 0,
        tox: Math.floor(rng() * 300),
        worldId: opts.worldId,
      }),
    );
  }
  return players;
}

export function makeCluster(id: string, x: number, y: number, kg: number): SimCluster {
  return { id, x, y, kg, reservedBy: null };
}

export interface MakeWorldOptions {
  pollutionKg?: number;
  capacityKg?: number;
  seedPollutionKg?: number;
}

export function makeWorld(opts: MakeWorldOptions = {}): SimWorld {
  const capacityKg = opts.capacityKg ?? WORLD.CAPACITY_KG;
  const pollutionKg = opts.pollutionKg ?? capacityKg * WORLD.INITIAL_POLLUTION_FRAC;
  const collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
  return {
    worldId: 0,
    capacityKg,
    pollutionKg,
    collectableKg,
    hiddenKg: pollutionKg - collectableKg,
    status: worldStatus(pollutionKg, capacityKg),
    generationRateKgH: 0,
    demandKgH: 0,
    burnedKg: 0,
    seedPollutionKg: opts.seedPollutionKg ?? pollutionKg,
    generatedKg: 0,
    invariantSkewKg: 0,
    tickIndex: 0,
  };
}

// --- the simulator ------------------------------------------------------------

const TICK_GAME_H = WORLD.GAME_MINUTES_PER_TICK / 60;

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class Sim {
  world: SimWorld;
  players: SimPlayer[];
  clusters: SimCluster[];
  zone: SimZone;
  /** reward keys ever credited — mirrors the rewardLedger table */
  ledgerKeys: Set<string>;
  /** inputs + output of the last batchAllocation (parity checks) */
  lastAllocation: { robots: Parameters<typeof batchAllocation>[0]; clusters: Parameters<typeof batchAllocation>[1] };
  lastAssignments: Map<string | number, string | number>;

  private rng: () => number;
  private nextClusterId = 0;

  constructor(opts: {
    players?: SimPlayer[];
    world?: MakeWorldOptions;
    clusters?: SimCluster[];
    zone?: Partial<SimZone>;
    seed?: number;
  } = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.world = makeWorld(opts.world ?? {});
    this.players = opts.players ?? [];
    this.clusters = opts.clusters ?? [];
    // normal worlds start with the collectable pool partially materialized;
    // write back the post-spawn balance (mirrors seedWorld's load-bearing fix)
    if (opts.clusters === undefined) {
      this.world.collectableKg = this.spawnClusters(
        this.world.collectableKg,
        WORLD.ACTIVE_CLUSTER_TARGET,
        0,
      );
    } else {
      // explicit clusters are pool mass too — debit them from collectable so
      // Layer 2 (pool invariant) stays balanced at construction
      const clusterKg = this.clusters.reduce((s, c) => s + c.kg, 0);
      this.world.collectableKg = Math.max(0, this.world.collectableKg - clusterKg);
    }
    // seeded player-held waste (storage / processing / cargo) is also real
    // pool mass — debit it from collectable, mirroring harness:seedLoad
    const heldKg = this.players.reduce(
      (s, p) => s + p.storageKg + p.processing.queuedKg + p.robot.cargoKg,
      0,
    );
    this.world.collectableKg = Math.max(0, this.world.collectableKg - heldKg);
    this.zone = {
      status: "inactive",
      x: 0,
      y: 0,
      spawnedAt: 0,
      expiresAt: 0,
      nextSpawnAt: Number.MAX_SAFE_INTEGER,
      multiplier: BURN_ZONE_MULTIPLIER,
      ...opts.zone,
    };
    this.ledgerKeys = new Set();
    this.lastAllocation = { robots: [], clusters: [] };
    this.lastAssignments = new Map();
  }

  cargoCap(p: SimPlayer): number {
    return UPGRADES.cargo.caps[p.levels.cargo - 1];
  }
  storageCap(p: SimPlayer): number {
    return UPGRADES.storage.caps[p.levels.storage - 1];
  }
  batteryCap(p: SimPlayer): number {
    return UPGRADES.battery.caps[p.levels.battery - 1];
  }

  clusterById(id: string): SimCluster | null {
    return this.clusters.find((c) => c.id === id) ?? null;
  }

  private spawnClusters(availableKg: number, target: number, current: number): number {
    let remaining = availableKg;
    let spawned = 0;
    while (
      current + spawned < target &&
      remaining >= WORLD.CLUSTER_MIN_KG &&
      spawned < WORLD.MAX_CLUSTER_SPAWNS_PER_TICK
    ) {
      const size = Math.min(
        WORLD.CLUSTER_MIN_KG +
          this.rng() * (WORLD.CLUSTER_MAX_KG - WORLD.CLUSTER_MIN_KG),
        remaining,
      );
      this.clusters.push({
        id: `c${this.nextClusterId++}`,
        x: this.rng() * WORLD.MAP_SIZE,
        y: this.rng() * WORLD.MAP_SIZE,
        kg: size,
        reservedBy: null,
      });
      remaining -= size;
      spawned += 1;
    }
    return remaining;
  }

  private stepZone(now: number): boolean {
    const z = this.zone;
    if (z.status === "inactive" && now >= z.nextSpawnAt) {
      z.status = "active";
      z.x = 120 + this.rng() * (WORLD.MAP_SIZE - 240);
      z.y = 120 + this.rng() * (WORLD.MAP_SIZE - 240);
      z.spawnedAt = now;
      z.expiresAt =
        now +
        (BURN_ZONE.MIN_ACTIVE_S +
          this.rng() * (BURN_ZONE.MAX_ACTIVE_S - BURN_ZONE.MIN_ACTIVE_S)) *
          1000;
    } else if (z.status === "active" && now >= z.expiresAt) {
      z.status = "inactive";
      z.nextSpawnAt =
        now +
        (BURN_ZONE.MIN_COOLDOWN_S +
          this.rng() * (BURN_ZONE.MAX_COOLDOWN_S - BURN_ZONE.MIN_COOLDOWN_S)) *
          1000;
    }
    return z.status === "active";
  }

  private stepRobot(
    p: SimPlayer,
    now: number,
    dtReal: number,
    assignments: Map<string | number, string | number>,
  ): boolean {
    if (!p.hasBase) return false;
    const base = { x: p.baseX, y: p.baseY };
    const r = p.robot;
    const bCap = this.batteryCap(p);
    const rechargeRate = UPGRADES.recharge.rates[p.levels.recharge - 1];
    const cCap = this.cargoCap(p);

    const releaseReservation = () => {
      if (r.targetClusterId) {
        const c = this.clusterById(r.targetClusterId);
        if (c && c.reservedBy === p.id) c.reservedBy = null;
        r.targetClusterId = null;
      }
    };
    const goHome = (fromX: number, fromY: number) => {
      r.state = "to_base";
      r.fromX = fromX;
      r.fromY = fromY;
      r.departAt = now;
      r.arriveAt =
        now + (dist(base, { x: fromX, y: fromY }) / ROBOT.SPEED_M_S) * 1000;
    };

    switch (r.state) {
      case "idle": {
        if (r.cargoKg > 0 && p.storageKg < this.storageCap(p)) {
          const unload = Math.min(r.cargoKg, this.storageCap(p) - p.storageKg);
          r.cargoKg -= unload;
          p.storageKg += unload;
          p.totalCollectedKg += unload;
        }
        if (r.auto && r.cargoKg < cCap) {
          const assigned = assignments.get(p.id);
          const target = assigned
            ? this.clusterById(String(assigned))
            : null;
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
        const target = r.targetClusterId ? this.clusterById(r.targetClusterId) : null;
        const dest = target ?? base;
        r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * dtReal);
        const total = (r.arriveAt || now) - r.departAt;
        if (total > 0) {
          const t = Math.min(1, (now - r.departAt) / total);
          r.x = r.fromX + (dest.x - r.fromX) * t;
          r.y = r.fromY + (dest.y - r.fromY) * t;
        }
        const returnBattery =
          (dist(base, r) / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING +
          ROBOT.BATTERY_SAFETY_MARGIN;
        if (!target || target.kg <= 0 || r.battery <= returnBattery) {
          releaseReservation();
          goHome(r.x, r.y);
          break;
        }
        if (now >= (r.arriveAt || Infinity)) {
          r.x = target.x;
          r.y = target.y;
          r.state = "collecting";
          r.busyUntil = now + ROBOT.COLLECT_TIME_S * 1000;
        }
        break;
      }
      case "collecting": {
        r.battery = Math.max(0, r.battery - ROBOT.DRAIN_COLLECTING * dtReal);
        if (now >= (r.busyUntil || now)) {
          const target = r.targetClusterId ? this.clusterById(r.targetClusterId) : null;
          if (target && target.kg > 0) {
            const amount = Math.min(cCap - r.cargoKg, target.kg);
            r.cargoKg += amount;
            target.kg -= amount;
            if (target.kg <= 0) {
              this.clusters = this.clusters.filter((c) => c.id !== target.id);
            }
            r.totalTrips += 1;
          }
          releaseReservation();
          goHome(target ? target.x : r.x, target ? target.y : r.y);
        }
        break;
      }
      case "to_base": {
        r.battery = Math.max(0, r.battery - ROBOT.DRAIN_MOVING * dtReal);
        const total = (r.arriveAt || now) - r.departAt;
        if (total > 0) {
          const t = Math.min(1, (now - r.departAt) / total);
          r.x = r.fromX + (base.x - r.fromX) * t;
          r.y = r.fromY + (base.y - r.fromY) * t;
        }
        if (now >= (r.arriveAt || Infinity)) {
          r.x = base.x;
          r.y = base.y;
          r.state = "unloading";
          r.busyUntil = now + ROBOT.UNLOAD_TIME_S * 1000;
        }
        break;
      }
      case "unloading": {
        if (now >= (r.busyUntil || now)) {
          const space = this.storageCap(p) - p.storageKg;
          const unload = Math.min(r.cargoKg, space);
          p.storageKg += unload;
          p.totalCollectedKg += unload;
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
    return robotDemands(r.state);
  }

  /** One world tick — mirrors world.ts runTick step-for-step. */
  tick(now: number): void {
    const dtReal = WORLD.TICK_SECONDS;
    const w = this.world;
    const players = this.players;

    // 1) base generation → pollution
    const active = players.filter((p) => p.hasBase);
    const genKgH = active.length * WORLD.BASE_GEN_KG_H;
    let pollutionKg = Math.min(w.capacityKg, w.pollutionKg + genKgH * TICK_GAME_H);
    let generatedKg = w.generatedKg + genKgH * TICK_GAME_H;
    let seedPollutionKg = w.seedPollutionKg;

    // 2) robots — sharded (Sprint 2.6)
    const shardCount = Math.max(1, Math.ceil(players.length / WORLD.ROBOTS_PER_TICK));
    const shardIndex = w.tickIndex % shardCount;

    const robotCandidates = players
      .map((p, i) => ({ p, i }))
      .filter(
        ({ p, i }) =>
          i % shardCount === shardIndex &&
          p.hasBase &&
          p.robot.auto &&
          p.robot.state === "idle" &&
          p.robot.cargoKg < this.cargoCap(p),
      )
      .map(({ p }) => ({
        id: p.id,
        x: p.robot.x,
        y: p.robot.y,
        level: p.levels.cargo,
        battery: p.robot.battery,
      }));
    const unclaimedClusters = this.clusters
      .filter((c) => c.kg > 0 && !c.reservedBy)
      .map((c) => ({ id: c.id, x: c.x, y: c.y, kg: c.kg }));

    this.lastAllocation = { robots: robotCandidates, clusters: unclaimedClusters };
    const assignments = batchAllocation(robotCandidates, unclaimedClusters, WORLD.BATCH_SIZE, {
      tripCost: (_r, d) => batteryForTrip(d),
    });
    this.lastAssignments = assignments;

    let demandKgH = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (i % shardCount !== shardIndex) {
        if (robotDemands(p.robot.state)) demandKgH += WORLD.DEMAND_REF_KG_H;
        continue;
      }
      const isActive = this.stepRobot(p, now, dtReal, assignments);
      if (isActive) demandKgH += WORLD.DEMAND_REF_KG_H;
    }

    // stale reservation cleanup
    for (const c of this.clusters) {
      if (!c.reservedBy) continue;
      const owner = players.find((p) => p.id === c.reservedBy);
      const stillTargeting =
        owner &&
        owner.robot.targetClusterId === c.id &&
        (owner.robot.state === "to_cluster" || owner.robot.state === "collecting");
      if (!stillTargeting) c.reservedBy = null;
    }

    // 3) dynamic replenishment — Model C
    const replFracH = replenishmentModelC(genKgH, demandKgH);
    const unlockKg = Math.min(w.hiddenKg, w.hiddenKg * replFracH * TICK_GAME_H);
    let collectableKg = w.collectableKg + unlockKg;
    let hiddenKg = w.hiddenKg - unlockKg;

    // 4) keep the map stocked
    collectableKg = this.spawnClusters(
      collectableKg,
      WORLD.ACTIVE_CLUSTER_TARGET,
      this.clusters.length,
    );

    // 5) burn zone lifecycle
    const zoneActive = this.stepZone(now);

    // 6) processing / burning → TOX-only rewards (v0.4, sharded in 2.6)
    let burnedKg = w.burnedKg;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.processing.queuedKg <= 0) continue;
      if (i % shardCount !== shardIndex) continue;

      const sessionId =
        p.processing.sessionId ?? `${p.id}:${p.processing.since || now}`;
      const sliceIndex = p.processing.sliceIndex;

      const burnKg = Math.min(
        p.processing.queuedKg,
        WORLD.PROCESSING_KG_PER_S * dtReal,
      );
      const slice = computeBurnSlice(
        { sessionId, queuedKg: p.processing.queuedKg, sliceIndex },
        burnKg,
        zoneActive,
      );

      const alreadyRewarded = this.ledgerKeys.has(slice.key);
      const next = advanceBurn(
        { sessionId, queuedKg: p.processing.queuedKg, sliceIndex },
        burnKg,
        alreadyRewarded,
      );
      p.processing.queuedKg = next.queuedKg;
      p.processing.sliceIndex = next.sliceIndex;
      p.processing.sessionId = sessionId;

      if (!alreadyRewarded) {
        this.ledgerKeys.add(slice.key);
        p.toxBalance += slice.tox;
        p.totalBurnedKg += burnKg;
        if (slice.kind === "normal") p.toxFromNormal += slice.tox;
        else p.toxFromZone += slice.tox;
        pollutionKg = applyBurnToPollution(pollutionKg, burnKg);
        burnedKg += burnKg;
      }
    }

    // 7) status / collapse
    let status = worldStatus(pollutionKg, w.capacityKg);
    let newWorldId = w.worldId;
    if (pollutionKg >= w.capacityKg) {
      newWorldId = w.worldId + 1;
      this.clusters = [];
      pollutionKg = w.capacityKg * WORLD.RESET_POLLUTION_FRAC;
      collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
      hiddenKg = pollutionKg - collectableKg;
      status = "safe";
      // re-anchor the waste invariant for the new world cycle (mirrors world.ts)
      burnedKg = 0;
      generatedKg = 0;
      seedPollutionKg = pollutionKg;
      for (const p of players) {
        const bx = p.baseX;
        const by = p.baseY;
        p.worldId = newWorldId;
        p.storageKg = 0;
        p.processing = { queuedKg: 0, since: now, sessionId: null, sliceIndex: 0 };
        p.robot = {
          ...p.robot,
          state: "idle",
          targetClusterId: null,
          x: bx,
          y: by,
          fromX: bx,
          fromY: by,
          cargoKg: 0,
          battery: this.batteryCap(p),
        };
      }
      collectableKg = this.spawnClusters(
        collectableKg,
        WORLD.ACTIVE_CLUSTER_TARGET,
        0,
      );
    }

    const invariantSkewKg = Math.abs(
      pollutionKg + burnedKg - seedPollutionKg - generatedKg,
    );

    w.worldId = newWorldId;
    w.pollutionKg = pollutionKg;
    w.collectableKg = collectableKg;
    w.hiddenKg = hiddenKg;
    w.status = status;
    w.generationRateKgH = genKgH;
    w.demandKgH = demandKgH;
    w.burnedKg = burnedKg;
    w.generatedKg = generatedKg;
    w.seedPollutionKg = seedPollutionKg;
    w.invariantSkewKg = invariantSkewKg;
    w.tickIndex += 1;
  }

  /** Two-layer waste invariant over the CURRENT state (Layer 1 + Layer 2). */
  invariant() {
    return checkWasteInvariant({
      initialWasteKg: this.world.seedPollutionKg,
      generatedKg: this.world.generatedKg,
      pollutionKg: this.world.pollutionKg,
      burnedKg: this.world.burnedKg,
      hiddenKg: this.world.hiddenKg,
      collectableKg: this.world.collectableKg,
      clusterKg: this.clusters.reduce((s, c) => s + c.kg, 0),
      cargoKg: this.players.reduce((s, p) => s + p.robot.cargoKg, 0),
      storageKg: this.players.reduce((s, p) => s + p.storageKg, 0),
      processingKg: this.players.reduce((s, p) => s + p.processing.queuedKg, 0),
    });
  }
}
