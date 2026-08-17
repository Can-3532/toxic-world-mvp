// TOXIC WORLD — economy & world parameters (Design Freeze v0.4)
// Pure constants, safe to import from both the Convex backend and the frontend.
//
// v0.4 economy change (this file is the single source of truth):
//  - SOL burn reward REMOVED. Burn pays out TOX only.
//  - Normal burn  = 500 TOX / ton burned.
//  - Burn Zone    = 600 TOX / ton burned (×1.2 while the zone is ACTIVE).
//  - Financial ROI retired; PROGRESSION ROI (TOX/time) is the KPI.
//  - SOL remains ONLY on the entry/purchase side: 0.1 SOL base purchase,
//    which is SIMULATED/MOCK (no wallet, no transaction).

// Time model: the world ticks every TICK_SECONDS real seconds and each tick
// advances GAME_MINUTES_PER_TICK game minutes (12x compression since Sprint
// 2.7 B — was 30x at 2 s). All game-hour rates (generation, replenishment,
// demand) are anchored to GAME_MINUTES_PER_TICK, so the per-tick deltas are
// IDENTICAL to the pre-2.7 values; only the real-time cadence changed (a 10k
// tick takes ~3.2 s, which fits the 5 s window instead of overflowing the old
// 2 s cron — this killed the Sprint 2.6 cron drift). Real-time-anchored rates
// (battery drain, robot travel, burner kg/s) are unchanged per real second.

export const WORLD = {
  CAPACITY_KG: 10_000_000, // 10,000 ton world capacity
  INITIAL_POLLUTION_FRAC: 0.5, // World 0 starts at 50%
  RESET_POLLUTION_FRAC: 0.225, // World 1+ starts at 22.5%
  INITIAL_COLLECTABLE_FRAC: 0.1, // 10% of global waste starts collectable
  CRITICAL_FRAC: 0.9, // 90% => critical, no countdown
  COLLAPSE_FRAC: 1, // 100% => world collapse
  BASE_GEN_KG_H: 50, // starter base generation (kg / game hour)
  BASE_PRICE_SOL: 0.1, // base purchase price — MOCK (simulated, no tx)
  GENESIS_GRANT_SOL: 0.1, // demo grant so the loop is playable end-to-end — MOCK
  // DEPRECATED (v0.3) — burn no longer pays SOL. Kept only so legacy frontends
  // that reference it still compile; v0.4 code must NOT use this value.
  REWARD_USD_PER_TON: 10,
  TOX_PER_KG: 1, // legacy alias (1 TOX/kg = 1000 TOX/ton); kept for compat
  MAP_SIZE: 1000, // map is 1000 x 1000 units
  // Sprint 2.7 B (tick frequency redesign): 5 real seconds per tick — a 10k
  // tick (~3.2 s) now fits inside the cron window (was 2 s → overflow/drift).
  TICK_SECONDS: 5, // real seconds between world ticks
  GAME_MINUTES_PER_TICK: 1, // game minutes advanced per tick (unchanged)
  ACTIVE_CLUSTER_TARGET: 500, // clusters kept alive on the map
  CLUSTER_MIN_KG: 150,
  CLUSTER_MAX_KG: 900,
  MAX_CLUSTER_SPAWNS_PER_TICK: 25,
  PROCESSING_KG_PER_S: 2, // burn rate (kg / real second)
  // SPRINT 2.9 FREEZE (TOXIC_WORLD_STARTER_ECONOMY_RECALIBRATION_v0.1):
  // DEMAND_REF_KG_H is a DELIBERATE conservative design lever for Model C —
  // it is officially NOT the measured starter throughput (which measures
  // ~174.4 kg/game-h, see STARTER_OBSERVED_THROUGHPUT_KG_H). With the 42
  // reference the demand/gen ratio sits at the 5% replenishment floor in
  // practice; that is the frozen behavior, and re-anchoring it to measured
  // throughput is explicitly deferred to a future balance sprint.
  DEMAND_REF_KG_H: 42,
  // SPRINT 2.9 FREEZE — measured emergent throughput of a lone L1 starter on a
  // stocked map (24 game-h deterministic sim, diligent queue policy).
  // Informational only: Model C uses DEMAND_REF_KG_H, never this value.
  STARTER_OBSERVED_THROUGHPUT_KG_H: 174.4,
  BATCH_SIZE: 20, // Batch/Reservation: robots per allocation batch (Sprint 2.5)
  // Sprint 2.6 scaling: Convex caps one mutation at ~4,096 DB ops, so a tick
  // that patches every robot tops out around 3.5k players. Worlds beyond this
  // step robots in round-robin shards (each robot advances every shardCount
  // ticks) so 10k players fit in the budget. Worlds ≤ this are unchanged.
  ROBOTS_PER_TICK: 2500,
} as const;

// --- v0.4 reward economy ---------------------------------------------
export const TOX_PER_TON = 500; // 1 ton burned waste = 500 TOX (normal burn)
export const BURN_ZONE_MULTIPLIER = 1.2; // Burn Zone: ×1.2 => 600 TOX / ton

// Burn Zone lifecycle (real seconds) — server-side random schedule
export const BURN_ZONE = {
  MIN_ACTIVE_S: 15,
  MAX_ACTIVE_S: 30,
  MIN_COOLDOWN_S: 45,
  MAX_COOLDOWN_S: 90,
} as const;

// --- Progression ROI validation references (NOT hard-coded gameplay) ---
// Cumulative TOX to reach each Cargo level (L2 150, L3 +225, L4 +340, L5 +510).
export const CARGO_CUMULATIVE_TOX = [150, 375, 715, 1225] as const;

// --- Replenishment — Dynamic Model C (unchanged from v0.3) ------------
export const REPLENISHMENT = {
  BASE_FRAC: 0.05,
  MIN_FRAC: 0.05,
  MAX_FRAC: 0.09,
} as const;

export const ROBOT = {
  SPEED_M_S: 6,
  DRAIN_MOVING: 0.6, // battery per second while moving
  DRAIN_COLLECTING: 0.25, // battery per second while collecting
  COLLECT_TIME_S: 4, // seconds a robot spends scooping a cluster
  UNLOAD_TIME_S: 2,
  LOW_BATTERY_FRAC: 0.3, // below this on arrival => recharge first
  BATTERY_SAFETY_MARGIN: 5, // extra battery kept for the return trip
} as const;

// Upgrade tracks — costs are from Design Freeze v0.3 (UNCHANGED in v0.4).
// costs[L] = TOX price to go from level L to L+1 (costs[5] unused).
export const UPGRADES = {
  cargo: {
    label: "Cargo",
    icon: "package",
    description: "More waste per trip",
    costs: [0, 150, 225, 340, 510],
    caps: [20, 35, 55, 80, 110], // kg per level 1..5
  },
  recharge: {
    label: "Recharge",
    icon: "zap",
    description: "Faster battery refill at base",
    costs: [0, 20, 30, 45, 65],
    rates: [5, 8, 12, 18, 26], // battery per second per level 1..5
  },
  battery: {
    label: "Battery",
    icon: "battery",
    description: "Longer sorties without refuel",
    costs: [0, 120, 190, 300, 470],
    caps: [100, 150, 220, 320, 460], // battery units per level 1..5
  },
  storage: {
    label: "Storage",
    icon: "warehouse",
    description: "More waste held before processing",
    costs: [0, 200, 320, 500, 760],
    caps: [60, 100, 160, 260, 420], // kg per level 1..5
  },
} as const;

export type UpgradeTrack = keyof typeof UPGRADES;

// Battery required for a round trip of `dist` units (1 unit = 1 m)
export function batteryForTrip(dist: number): number {
  const travel = (dist / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING; // outbound
  return 2 * travel + ROBOT.COLLECT_TIME_S * ROBOT.DRAIN_COLLECTING + ROBOT.BATTERY_SAFETY_MARGIN;
}
