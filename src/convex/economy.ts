// TOXIC WORLD — v0.4 reward economy (pure, unit-testable).
// No Convex imports here on purpose: the same functions run inside the world
// engine (`world.ts`) and in the headless economy tests (`tests/economy.test.ts`).

import { BURN_ZONE_MULTIPLIER, TOX_PER_TON } from "./gameParams";

export type BurnKind = "normal" | "burn_zone";

// --- reward formulas (Design Freeze v0.4) ------------------------------

/** Normal burn: burned_kg / 1000 * 500  => 500 TOX per ton. */
export function normalBurnTox(burnedKg: number): number {
  return (burnedKg / 1000) * TOX_PER_TON;
}

/** Burn Zone burn: normal × 1.2  => 600 TOX per ton. */
export function burnZoneTox(burnedKg: number): number {
  return normalBurnTox(burnedKg) * BURN_ZONE_MULTIPLIER;
}

/** Reward for a burn slice; multiplier decided SERVER-SIDE by zone state. */
export function burnRewardTox(burnedKg: number, zoneActive: boolean): number {
  return zoneActive ? burnZoneTox(burnedKg) : normalBurnTox(burnedKg);
}

// --- exactly-once burn accounting ---------------------------------------

export type BurnSlice = {
  sessionId: string; // unique per processing session (queueProcessing)
  queuedKg: number; // kg still queued in the burner
  sliceIndex: number; // integer slice counter — idempotency key component
};

/**
 * Unique reward ledger key per burn slice. A slice is identified by
 * (processing session, slice index) — the same waste can never be rewarded
 * twice, and a normal + Burn Zone double-reward on the same unit is
 * impossible because the key does not depend on the multiplier.
 */
export function rewardKey(sessionId: string, sliceIndex: number): string {
  return `${sessionId}:${sliceIndex}`;
}

/** The reward a given burn slice would produce (before idempotency check). */
export function computeBurnSlice(
  state: BurnSlice,
  burnKg: number,
  zoneActive: boolean,
): { key: string; kg: number; tox: number; kind: BurnKind } {
  return {
    key: rewardKey(state.sessionId, state.sliceIndex),
    kg: burnKg,
    tox: burnRewardTox(burnKg, zoneActive),
    kind: zoneActive ? "burn_zone" : "normal",
  };
}

/**
 * Advance the burner state after a slice.
 * - Normal case (not yet rewarded): credit + sliceIndex++.
 * - alreadyRewarded (duplicate tick / ledger key exists): burn the kg from the
 *   queue WITHOUT crediting, but still advance sliceIndex so the next slice
 *   gets a fresh key — this is what makes concurrent double-ticks harmless.
 */
export function advanceBurn(
  state: BurnSlice,
  burnKg: number,
  alreadyRewarded: boolean,
): BurnSlice {
  return {
    sessionId: state.sessionId,
    queuedKg: Math.max(0, state.queuedKg - burnKg),
    sliceIndex: alreadyRewarded ? state.sliceIndex : state.sliceIndex + 1,
  };
}

// --- global waste accounting ---------------------------------------------

/** Burning removes waste from the world 1:1 (kg) — identical for normal and Burn Zone. */
export function applyBurnToPollution(pollutionKg: number, burnKg: number): number {
  return Math.max(0, pollutionKg - burnKg);
}

// --- progression ROI (validation helpers) --------------------------------

/** Game hours to accumulate `cumulativeTox` at a given TOX/hour rate. */
export function hoursToReach(toxPerHour: number, cumulativeTox: number): number {
  return toxPerHour > 0 ? cumulativeTox / toxPerHour : Infinity;
}
