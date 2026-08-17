// TOXIC WORLD — economy & world parameters (Design Freeze v0.3)
// Pure constants, safe to import from both the Convex backend and the frontend.

// Time model: the world ticks every TICK_SECONDS real seconds and each tick
// advances GAME_MINUTES_PER_TICK game minutes (30x compression). All throughput
// numbers below follow the design doc in kg per GAME hour.

export const WORLD = {
  CAPACITY_KG: 10_000_000, // 10,000 ton world capacity
  INITIAL_POLLUTION_FRAC: 0.5, // World 0 starts at 50%
  RESET_POLLUTION_FRAC: 0.225, // World 1+ starts at 22.5%
  INITIAL_COLLECTABLE_FRAC: 0.1, // 10% of global waste starts collectable
  CRITICAL_FRAC: 0.9, // 90% => critical, no countdown
  COLLAPSE_FRAC: 1, // 100% => world collapse
  BASE_GEN_KG_H: 50, // starter base generation (kg / game hour)
  REWARD_USD_PER_TON: 10, // $10 / ton burn reward reference
  SOL_PRICE_USD: 150, // display SOL price used to convert rewards
  BASE_PRICE_SOL: 0.1, // base purchase price
  GENESIS_GRANT_SOL: 0.1, // demo grant so the loop is playable end-to-end
  TOX_PER_KG: 1, // burn yield for the upgrade currency
  MAP_SIZE: 1000, // map is 1000 x 1000 units
  TICK_SECONDS: 2, // real seconds between world ticks
  GAME_MINUTES_PER_TICK: 1, // game minutes advanced per tick
  ACTIVE_CLUSTER_TARGET: 500, // clusters kept alive on the map
  CLUSTER_MIN_KG: 150,
  CLUSTER_MAX_KG: 900,
  MAX_CLUSTER_SPAWNS_PER_TICK: 25,
  PROCESSING_KG_PER_S: 2, // burn rate (kg / real second)
  DEMAND_REF_KG_H: 42, // starter robot throughput reference (kg / game hour)
} as const;

// Replenishment — Dynamic Model C (Design Freeze v0.3)
// ratio = activeRobotDemand / totalBaseGeneration
// replenishment = clip(0.05 * ratio, 0.05, 0.09)  [fraction of hidden pool / game hour]
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

// Upgrade tracks — costs are from Design Freeze v0.3, effects tuned for the
// spatial engine. costs[L] = TOX price to go from level L to L+1 (costs[5] unused).
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

// Derived: reward per kg burned (USD $10/ton at SOL_PRICE_USD)
export const SOL_PER_KG = WORLD.REWARD_USD_PER_TON / 1000 / WORLD.SOL_PRICE_USD;
export const USD_PER_KG = WORLD.REWARD_USD_PER_TON / 1000;

// Battery required for a round trip of `dist` units (1 unit = 1 m)
export function batteryForTrip(dist: number): number {
  const travel = (dist / ROBOT.SPEED_M_S) * ROBOT.DRAIN_MOVING; // outbound
  return 2 * travel + ROBOT.COLLECT_TIME_S * ROBOT.DRAIN_COLLECTING + ROBOT.BATTERY_SAFETY_MARGIN;
}
