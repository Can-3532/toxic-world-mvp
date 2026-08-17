// TOXIC WORLD — pure engine math (Sprint 2.4 test harness core).
// No Convex imports on purpose: the SAME functions run inside the world tick
// (`world.ts`) and in the headless tests (`tests/engine.test.ts`), so the
// harness validates the real production formulas, not a copy.
//
// This module is the TS equivalent of the Python simulation oracle: the
// design doc (Sprint 1) mandates that the simulation engine stays available
// as a reference for the production server. `tests/engineSim.ts` builds a
// deterministic oracle simulator out of these functions.

import { REPLENISHMENT, WORLD } from "./gameParams";

// ---------------------------------------------------------------------------
// 1. Waste invariant (Global Waste accounting)
// ---------------------------------------------------------------------------
//
// Mass balance: every kg that entered the world (seed + generation) is either
// still in the atmosphere (pollution) or has been burned.
//   pollutionKg + burnedKg == initialWasteKg + generatedKg
//
// Pool conservation: the tracked recoverable pools (hidden + collectable +
// materialized clusters + player-held cargo/storage/processing) must equal
// the recoverable portion of the atmosphere (pollution − generated), because
// generation is not yet recoverable and burned waste left the system.
//   hidden + collectable + clusters + cargo + storage + processing
//     == pollutionKg − generatedKg

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

export function checkWasteInvariant(w: WasteLedger) {
  const massBalance =
    w.pollutionKg + w.burnedKg - w.initialWasteKg - w.generatedKg;
  const poolBalance =
    w.hiddenKg +
    w.collectableKg +
    w.clusterKg +
    w.cargoKg +
    w.storageKg +
    w.processingKg -
    (w.pollutionKg - w.generatedKg);
  // Design-doc form (initial + generated == hidden + collectable + cargo +
  // storage + processing + burned). Reported for reference only: it assumes
  // generation flows directly into the pools and clusters are not separately
  // materialized, so it deviates in the production engine.
  const userFormula =
    w.hiddenKg +
    w.collectableKg +
    w.cargoKg +
    w.storageKg +
    w.processingKg +
    w.burnedKg -
    (w.initialWasteKg + w.generatedKg);
  return { massBalance, poolBalance, userFormula };
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
// 6. Batch/Reservation allocation
// ---------------------------------------------------------------------------
// The engine's runtime allocation is "nearest unclaimed cluster, reserved
// while traveling/collecting" (spatial + reservation). The design freeze's
// Batch/Reservation model is provided here as the reference oracle: robots are
// processed in ascending level order (low-level floor access) in batches, each
// taking its nearest unclaimed cluster.

export interface ClusterLike {
  x: number;
  y: number;
  kg: number;
  reservedBy?: unknown;
}

/** Nearest cluster with kg > 0 and no reservation — the exact rule the tick's
 * idle robot uses (world.ts stepRobot). Returns the cluster + distance. */
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
}
export interface BatchCluster {
  id: string | number;
  x: number;
  y: number;
  kg: number;
}

/**
 * Batch/Reservation reference model (freeze v0.3):
 * - robots sorted by ascending level, so low-level players get floor access;
 * - processed in batches; each robot in the batch reserves its nearest
 *   unclaimed cluster;
 * - returns Map<robotId, clusterId> of successful reservations.
 */
export function batchAllocation(
  robots: BatchRobot[],
  clusters: BatchCluster[],
  batchSize = 20,
): Map<string | number, string | number> {
  const sorted = [...robots].sort((a, b) => a.level - b.level);
  const available = [...clusters];
  const assignments = new Map<string | number, string | number>();
  for (let i = 0; i < sorted.length; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);
    for (const robot of batch) {
      let bestIdx = -1;
      let bestD = Infinity;
      for (let j = 0; j < available.length; j++) {
        const c = available[j];
        if (c.kg <= 0) continue;
        const d = Math.hypot(robot.x - c.x, robot.y - c.y);
        if (d < bestD) {
          bestD = d;
          bestIdx = j;
        }
      }
      if (bestIdx >= 0) {
        assignments.set(robot.id, available[bestIdx].id);
        available.splice(bestIdx, 1);
      }
    }
  }
  return assignments;
}
