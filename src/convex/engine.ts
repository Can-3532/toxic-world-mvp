// TOXIC WORLD — pure engine math (Sprint 2.4 test harness core, Sprint 2.5
// consistency spec). No Convex imports on purpose: the SAME functions run
// inside the world tick (`world.ts`) and in the headless tests
// (`tests/engine.test.ts`), so the harness validates the real production
// formulas, not a copy.
//
// This module is the TS equivalent of the Python simulation oracle: the
// design doc (Sprint 1) mandates that the simulation engine stays available
// as a reference for the production server. `tests/engineSim.ts` builds a
// deterministic oracle simulator out of these functions.

import { REPLENISHMENT, WORLD } from "./gameParams";

// ---------------------------------------------------------------------------
// 1. Waste accounting — OFFICIAL TWO-LAYER INVARIANT (Backend Technical
//    Specification, Sprint 2.5). This supersedes the old single-equation
//    "physical invariant" (initial + generated == hidden + collectable +
//    cargo + storage + processing + burned), which assumed generation flows
//    directly into the pools and is formally RETIRED.
// ---------------------------------------------------------------------------
//
//  LAYER 1 — PRIMARY MASS INVARIANT (what entered == what remains/left)
//    seedPollutionKg + generatedKg == pollutionKg + burnedKg
//
//  LAYER 2 — SECONDARY POOL INVARIANT (recoverable holdings partition the
//    recoverable portion of the atmosphere; each kg sits in EXACTLY ONE
//    bucket — cluster / cargo / storage / processing holdings never double-
//    count the same mass):
//    hiddenKg + collectableKg + clusterKg + cargoKg + storageKg + processingKg
//      == pollutionKg − generatedKg
//
//  Why the subtraction: freshly generated waste enters the atmosphere, not
//  the recoverable pools, and burned waste has left the system entirely.

export interface WasteLedger {
  initialWasteKg: number;
  generatedKg: number;
  pollutionKg: number;
  burnedKg: number;
  hiddenKg: number;
  collectableKg: number;
  clusterKg: number;
  cargoKg: number;
  storageKg: number;
  processingKg: number;
}

/** Layer 1 + Layer 2 residuals — both must be ~0 after every tick. */
export function checkWasteInvariant(w: WasteLedger) {
  // Layer 1: primary mass invariant
  const massBalance =
    w.pollutionKg + w.burnedKg - w.initialWasteKg - w.generatedKg;
  // Layer 2: secondary pool invariant (disjoint holdings, never double-counted)
  const poolBalance =
    w.hiddenKg +
    w.collectableKg +
    w.clusterKg +
    w.cargoKg +
    w.storageKg +
    w.processingKg -
    (w.pollutionKg - w.generatedKg);
  return { massBalance, poolBalance };
}

// ---------------------------------------------------------------------------
// 2. Pollution fraction (frontend shows pollution / capacity × 100)
// ---------------------------------------------------------------------------

export function pollutionFrac(pollutionKg: number, capacityKg: number): number {
  return (pollutionKg / capacityKg) * 100;
}

// ---------------------------------------------------------------------------
// 3. Dynamic Replenishment — Model C (Design Freeze v0.3, unchanged in v0.4)
// ---------------------------------------------------------------------------
// ratio = active robot demand / total base generation
// replenishment = clip(0.05 × ratio, 0.05, 0.09)

export function replenishmentModelC(genKgH: number, demandKgH: number): number {
  const ratio = genKgH > 0 ? demandKgH / genKgH : 0;
  return Math.min(
    REPLENISHMENT.MAX_FRAC,
    Math.max(REPLENISHMENT.MIN_FRAC, REPLENISHMENT.BASE_FRAC * ratio),
  );
}

// ---------------------------------------------------------------------------
// 4. World status thresholds (critical 90%, collapse 100%)
// ---------------------------------------------------------------------------

export type WorldStatus = "safe" | "critical" | "collapsed";

export function worldStatus(
  pollutionKg: number,
  capacityKg: number,
): WorldStatus {
  if (pollutionKg >= capacityKg) return "collapsed";
  if (pollutionKg / capacityKg >= WORLD.CRITICAL_FRAC) return "critical";
  return "safe";
}

/** Reset values after a world collapse (World 1+ starts at 22.5%, 10% collectable). */
export function collapseResetValues(capacityKg: number) {
  const pollutionKg = capacityKg * WORLD.RESET_POLLUTION_FRAC;
  const collectableKg = pollutionKg * WORLD.INITIAL_COLLECTABLE_FRAC;
  return {
    pollutionKg,
    collectableKg,
    hiddenKg: pollutionKg - collectableKg,
  };
}

// ---------------------------------------------------------------------------
// 5. Robot demand predicate (which states count as "active demand")
// ---------------------------------------------------------------------------

export function robotDemands(state: string): boolean {
  return state === "to_cluster" || state === "collecting" || state === "to_base";
}

// ---------------------------------------------------------------------------
// 6. Batch/Reservation allocation (Design Freeze v0.4 — PRODUCTION
//    COMPLIANCE, Sprint 2.5)
// ---------------------------------------------------------------------------
// The production tick (`world.ts`) and the oracle simulator
// (`tests/engineSim.ts`) BOTH call this single function every tick to plan
// reservations for idle, auto robots against unclaimed clusters. Guarantees:
//   - shared pool scarcity: fewer clusters than robots ⇒ some robots wait;
//   - L1/L5 mixed population: robots are processed in ascending level order;
//   - guaranteed floor access: under scarcity low-level robots reserve first;
//   - no duplicate reservation: each cluster is removed after assignment;
//   - deterministic result: level order, tie-broken by robot id.

export interface ClusterLike {
  x: number;
  y: number;
  kg: number;
  reservedBy?: unknown;
}

/** Nearest cluster with kg > 0 and no reservation. Kept as a building block
 * for tests and tooling; the tick itself uses batchAllocation. */
export function selectCluster(
  pos: { x: number; y: number },
  clusters: readonly ClusterLike[],
): { cluster: ClusterLike; distance: number } | null {
  let best: ClusterLike | null = null;
  let bestD = Infinity;
  for (const c of clusters) {
    if (c.kg <= 0 || c.reservedBy) continue;
    const d = Math.hypot(pos.x - c.x, pos.y - c.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? { cluster: best, distance: bestD } : null;
}

export interface BatchRobot {
  id: string | number;
  x: number;
  y: number;
  level: number;
  /** current battery — used with `opts.tripCost` to skip infeasible trips */
  battery?: number;
}
export interface BatchCluster {
  id: string | number;
  x: number;
  y: number;
  kg: number;
}
export interface BatchOptions {
  /** Round-trip battery cost for a robot at a given distance. When provided,
   * a robot only reserves a cluster it can afford; infeasible candidates are
   * skipped in distance order. */
  tripCost?: (robot: BatchRobot, distance: number) => number;
}

/**
 * Batch/Reservation allocation (freeze v0.3/v0.4) — the SINGLE reference the
 * production tick and the harness both use:
 * - robots sorted by ascending level (tie-break: id) ⇒ floor access for L1;
 * - processed in batches of `batchSize`;
 * - each robot takes its NEAREST affordable unclaimed cluster;
 * - returns Map<robotId, clusterId> of successful reservations.
 */
export function batchAllocation(
  robots: BatchRobot[],
  clusters: BatchCluster[],
  batchSize = 20,
  opts: BatchOptions = {},
): Map<string | number, string | number> {
  const sorted = [...robots].sort(
    (a, b) => a.level - b.level || (String(a.id) < String(b.id) ? -1 : 1),
  );
  const available = [...clusters];
  const assignments = new Map<string | number, string | number>();
  for (let i = 0; i < sorted.length; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);
    for (const robot of batch) {
      const candidates = available
        .map((c, j) => ({ j, d: Math.hypot(robot.x - c.x, robot.y - c.y) }))
        .filter((x) => available[x.j].kg > 0)
        .sort((a, b) => a.d - b.d);
      let chosen = -1;
      for (const cand of candidates) {
        if (
          opts.tripCost &&
          robot.battery != null &&
          robot.battery < opts.tripCost(robot, cand.d)
        ) {
          continue; // nearest cluster too far for the battery — try next
        }
        chosen = cand.j;
        break;
      }
      if (chosen >= 0) {
        assignments.set(robot.id, available[chosen].id);
        available.splice(chosen, 1); // no duplicate reservation
      }
    }
  }
  return assignments;
}
