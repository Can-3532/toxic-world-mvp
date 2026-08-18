// TOXIC WORLD — SPRINT 2.11 PROTECTION SYSTEMS (pure, unit-testable).
// No Convex imports on purpose: the SAME functions run inside the world tick
// (`world.ts`), the player mutations (`game.ts`) and the headless tests
// (`tests/protectionValidation.test.ts`), so the harness validates the real
// production rules, not a copy. Design: TOXIC_WORLD_PROTECTION_SYSTEMS_v0.1.md.
//
// State machine: normal → afk (12 real h idle) → locked (auto at collapse, or
// voluntary) → launching (Emergency Launch, 5 real min) → normal (base gone).
// Sealed = locked | launching. While sealed: generation OFF, robot parked,
// existing burn queue CONTINUES (anti-deadlock: unlock fee stays earnable),
// storage/cargo/queue preserved across world collapse.

import { PROTECTION, WORLD } from "./gameParams";

export type ProtectionState = "normal" | "afk" | "locked" | "launching";
export type LockReason = "voluntary" | "collapse";

export interface Protection {
  state: ProtectionState;
  lockedAt?: number;
  lockReason?: LockReason;
  shieldUntil?: number;
  launchAt?: number;
}

/** Fresh player protection (legacy-doc fallback too). */
export function protectionDefaults(): Protection {
  return { state: "normal" };
}

/** Is the base sealed? Sealed bases stop generation and park the robot. */
export function isSealed(state: ProtectionState): boolean {
  return state === "locked" || state === "launching";
}

/** 12 real hours since the last player action. */
export function afkDue(lastActiveAt: number, now: number): boolean {
  return now - lastActiveAt >= PROTECTION.AFK_AFTER_MS;
}

/** The tick's idle check: NORMAL bases that crossed 12 h idle → AFK. */
export function applyIdleCheck(
  prot: Protection,
  lastActiveAt: number,
  now: number,
): Protection {
  if (prot.state === "normal" && afkDue(lastActiveAt, now)) {
    return { ...prot, state: "afk" };
  }
  return prot;
}

/** Any player action ends AFK (the caller also refreshes lastActiveAt). */
export function onActivity(prot: Protection): Protection {
  return prot.state === "afk" ? { ...prot, state: "normal" } : prot;
}

/** Toxic Shield buff still running? */
export function shieldActive(shieldUntil: number | undefined, now: number): boolean {
  return shieldUntil != null && now < shieldUntil;
}

/**
 * Field battery-drain multiplier. Only while the world is CRITICAL does an
 * UNSHIELDED, unsealed robot drain ×CRITICAL_DRAIN_MULT (toxic air corrodes
 * exposed units). Sealed robots are parked anyway; recharging at base is safe.
 * The shield never prevents or delays world collapse.
 */
export function drainMultiplier(
  prot: Protection,
  now: number,
  worldCritical: boolean,
): number {
  if (!worldCritical) return 1;
  if (isSealed(prot.state)) return 1;
  if (shieldActive(prot.shieldUntil, now)) return 1;
  return PROTECTION.CRITICAL_DRAIN_MULT;
}

/**
 * Collapse fate of a base (checked at collapse time, tick §7):
 * - afk      → auto-lock (forced, lockReason "collapse") — stockpile kept
 * - locked   → stays locked — stockpile kept
 * - launching→ stays launching — stockpile kept until the launch completes
 * - normal   → unchanged — stockpile WIPED (v0.4 behavior)
 */
export function onWorldCollapse(prot: Protection, now: number): Protection {
  if (prot.state === "afk") {
    return { ...prot, state: "locked", lockedAt: now, lockReason: "collapse" };
  }
  return prot;
}

/** After the collapse transition: does this state keep its held waste? */
export function keepsHeldOnCollapse(state: ProtectionState): boolean {
  return isSealed(state); // afk already became locked via onWorldCollapse
}

/**
 * Emergency Launch countdown complete? (tick checks launching players)
 * On completion the base is destroyed — see world.ts / game.ts docs.
 */
export function launchDue(launchAt: number | undefined, now: number): boolean {
  return launchAt != null && now >= launchAt;
}

// ---------------------------------------------------------------------------
// Collapse mass accounting — keeps the two-layer waste invariant EXACT
// (protection doc §3). Preserved holdings are real recoverable pool mass
// carried into the next cycle, so they must come out of the new world's
// atmosphere seed: recoverable = P0 − preserved.
// ---------------------------------------------------------------------------

export interface CollapseSeed {
  pollutionKg: number; // P0 — unchanged reset seed (capacity × 22.5%)
  hiddenKg: number;
  collectableKg: number; // pre-cluster-spawn value; spawnClusters deducts from it
  preservedKg: number; // min(carriedKg, P0) — cap so the pool can never exceed the seed
}

export function collapseSeed(capacityKg: number, carriedKg: number): CollapseSeed {
  const p0 = capacityKg * WORLD.RESET_POLLUTION_FRAC;
  const preservedKg = Math.min(carriedKg, p0); // a world cannot hold > its seed
  const recoverable = p0 - preservedKg;
  return {
    pollutionKg: p0,
    hiddenKg: recoverable * (1 - WORLD.INITIAL_COLLECTABLE_FRAC),
    collectableKg: recoverable * WORLD.INITIAL_COLLECTABLE_FRAC,
    preservedKg,
  };
}

/**
 * Proportionally scale a kept player's held mass to `preservedKg` when the
 * carried total would exceed the new world's seed (pathological 10k-sealed
 * case). scale == 1 in every normal case (carried ≤ P0).
 */
export function proportionalPreserve(
  carriedKg: number,
  preservedKg: number,
  held: { storage: number; cargo: number; processing: number },
): { storage: number; cargo: number; processing: number } {
  const scale = carriedKg > 0 ? Math.min(1, preservedKg / carriedKg) : 1;
  return {
    storage: held.storage * scale,
    cargo: held.cargo * scale,
    processing: held.processing * scale,
  };
}
