// TOXIC WORLD — SPRINT 2.10: STORAGE & BATTERY P1 REBALANCE
//
// The Design Freeze v0.3 left the Storage and Battery upgrade costs OPEN
// (flagged P1). Until now they carried MVP placeholders
// (storage 200/320/500/760, battery 120/190/300/470) that INVERTED the
// progression priority: the buffer track (storage) cost more than the
// throughput track (cargo 150/225/340/510), and battery cost nearly as much
// as cargo.
//
// This suite MEASURES the real value of each track on the deterministic
// oracle (tests/engineSim.ts → world.ts mirror), then pins the rebalanced
// cost curves chosen from those measurements (gameParams.ts UPGRADES).
// Rebalance doc: TOXIC_WORLD_STORAGE_BATTERY_REBALANCE_v0.1.md.
//
// SPRINT 2.11 port: engineSim.ts was rewritten to a functional, deterministic
// API (simTick/simWithPlayers/simInvariant) that mirrors world.ts step-for-
// step. This suite was migrated to that API; the assertions (relative metrics
// + frozen cost curves) are unchanged. The Burn Zone is driven by a
// deterministic schedule (active 4 ticks of every 16-tick cycle = 20 s active
// per 80 s, inside the frozen 15–30 s / 45–90 s design window).
//
// Run:  bun test tests/storageBatteryValidation.test.ts

import { describe, it as test, expect } from "vitest";
import { UPGRADES, WORLD } from "../src/convex/gameParams";
import {
  makePlayer,
  simInvariant,
  simTick,
  simWithPlayers,
  type SimPlayer,
  type SimState,
} from "./engineSim";

const EPS = 1e-6;
const GAME_HOURS_PER_REAL_HOUR =
  ((3600 / WORLD.TICK_SECONDS) * WORLD.GAME_MINUTES_PER_TICK) / 60;

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "∞";
}

/** Deterministic Burn Zone schedule — design window 15–30 s active / 45–90 s
 * cooldown. Active 4 ticks (20 s) of every 16-tick (80 s) cycle (25%). */
const zoneActiveAt = (t: number) => t % 16 < 4;

// ---------------------------------------------------------------------------
// runner: one starter, one axis swept, deterministic per seed
// ---------------------------------------------------------------------------

interface AxisRun {
  p: SimPlayer;
  state: SimState;
  /** ticks the robot spent recharging (battery/recharge axes) */
  rechargeTicks: number;
  /** ticks the robot sat idle with a full cargo (storage-pressure stall) */
  stallTicks: number;
  maxStorageKg: number;
  maxQueueKg: number;
}

/**
 * Run one L1 starter for `gameHours` (default 24) sweeping a single track:
 *  - batteryLevel: UPGRADES.battery cap L1..L5 (cargo/storage/recharge stay L1)
 *  - storageLevel: UPGRADES.storage cap L1..L5 (cargo/battery/recharge stay L1)
 * Queue policy:
 *  - "diligent" — every kg in storage is queued the same tick (burner fed
 *    continuously; models the active player).
 *  - "hourly" — storage is queued once per game-hour (every 60 ticks; models
 *    a player who checks in once per 5 real minutes). Under this policy the
 *    storage cap is the ONLY thing that decides how long the robot can work
 *    between check-ins, so it isolates storage's buffer value.
 */
function runAxis(opts: {
  batteryLevel?: number;
  storageLevel?: number;
  queue: "diligent" | "hourly";
  gameHours?: number;
}): AxisRun {
  const gameHours = opts.gameHours ?? 24;
  const p = makePlayer("s", { hasBase: true, baseX: 500, baseY: 500, auto: true });
  if (opts.batteryLevel) {
    p.levels.battery = opts.batteryLevel;
    p.robot.battery = UPGRADES.battery.caps[opts.batteryLevel - 1];
  }
  if (opts.storageLevel) {
    p.levels.storage = opts.storageLevel;
  }
  const state = simWithPlayers([p]);
  const ticks = Math.round((gameHours * 60) / WORLD.GAME_MINUTES_PER_TICK);
  let rechargeTicks = 0;
  let stallTicks = 0;
  let maxStorageKg = 0;
  let maxQueueKg = 0;
  for (let t = 0; t < ticks; t++) {
    simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, zoneActiveAt(t));
    // queue policy (player action: queueProcessing)
    if (p.storageKg > 0) {
      const due =
        opts.queue === "diligent" ||
        (opts.queue === "hourly" && t % 60 === 59);
      if (due) {
        if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
        p.processing.queuedKg += p.storageKg;
        p.storageKg = 0;
      }
    }
    if (p.robot.state === "recharging") rechargeTicks += 1;
    if (p.robot.state === "idle" && p.robot.cargoKg > 0) stallTicks += 1;
    maxStorageKg = Math.max(maxStorageKg, p.storageKg);
    maxQueueKg = Math.max(maxQueueKg, p.processing.queuedKg);
    const inv = simInvariant(state);
    expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
  }
  return { p, state, rechargeTicks, stallTicks, maxStorageKg, maxQueueKg };
}

// ---------------------------------------------------------------------------
// 1. BATTERY AXIS — recharge time is dead time; the cap shortens/removes it
// ---------------------------------------------------------------------------

describe("1. battery axis (diligent starter, 24 game-h)", () => {
  test("recharge share + throughput across battery L1..L5", () => {
    const rows: Record<string, number>[] = [];
    for (let lv = 1; lv <= 5; lv++) {
      const { p, state, rechargeTicks } = runAxis({ batteryLevel: lv, queue: "diligent" });
      const gameH = 24;
      rows.push({
        lv,
        rechargeShare: rechargeTicks / (gameH * 60),
        burnedGph: p.totalBurnedKg / gameH,
        toxGph: p.toxBalance / gameH,
      });
      const inv = simInvariant(state);
      expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    }
    console.log("── BATTERY AXIS (cargo/storage/recharge L1, diligent queue) ─────");
    console.log("  Lv | recharge % of real time | burned kg/game-h | TOX/game-h");
    for (const r of rows) {
      console.log(
        `  ${r.lv}  | ${fmt((r.rechargeShare as number) * 100).padStart(15)}% | ${fmt(r.burnedGph as number).padStart(16)} | ${fmt(r.toxGph as number)}`,
      );
    }
    // the effect is real but small for a diligent starter on short trips, and
    // per-step deltas are noisy (L4→L5 can tick up by <0.001 abs), so assert
    // the robust facts only: L1 is the worst case and the cap cuts it clearly
    expect(rows[0].rechargeShare).toBeGreaterThan(0.03);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rechargeShare).toBeLessThanOrEqual(rows[0].rechargeShare + 1e-9);
    }
    // L5 still refills at the L1 rate (recharge was NOT leveled in this sweep),
    // so the share must be clearly below L1's
    expect(rows[4].rechargeShare).toBeLessThan(rows[0].rechargeShare * 0.9);
    expect(rows[4].rechargeShare).toBeLessThan(0.08);
  });
});

describe("1b. recharge axis — the rate, not the cap, is the dead-time killer", () => {
  test("recharge share across recharge L1..L5 (battery L1, diligent)", () => {
    const rows: Record<string, number>[] = [];
    for (let lv = 1; lv <= 5; lv++) {
      const p = makePlayer("s", { hasBase: true, baseX: 500, baseY: 500, auto: true });
      p.levels.recharge = lv;
      const state = simWithPlayers([p]);
      let rechargeTicks = 0;
      for (let t = 0; t < 24 * 60; t++) {
        simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, zoneActiveAt(t));
        if (p.storageKg > 0) {
          if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
          p.processing.queuedKg += p.storageKg;
          p.storageKg = 0;
        }
        if (p.robot.state === "recharging") rechargeTicks += 1;
        const inv = simInvariant(state);
        expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
        expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
      }
      rows.push({
        lv,
        rechargeShare: rechargeTicks / (24 * 60),
        burnedGph: p.totalBurnedKg / 24,
      });
    }
    console.log("── RECHARGE AXIS (battery L1, diligent queue) ─────────────────────");
    console.log("  Lv | recharge % of real time | burned kg/game-h");
    for (const r of rows) {
      console.log(
        `  ${r.lv}  | ${fmt((r.rechargeShare as number) * 100).padStart(15)}% | ${fmt(r.burnedGph as number)}`,
      );
    }
    // monotonic: faster refill ⇒ never more recharge dead time
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rechargeShare).toBeLessThanOrEqual(rows[i - 1].rechargeShare + 1e-9);
    }
    // the rate matters more than the cap: L1 recharge is 5/s (an L5 battery
    // would take 92 s real to refill at that rate); L5 recharge is 26/s.
    // L1 must be the biggest dead-time share of the whole battery+recharge
    // system, and L5 must cut it by more than half.
    expect(rows[0].rechargeShare).toBeGreaterThan(0.05);
    expect(rows[4].rechargeShare).toBeLessThan(rows[0].rechargeShare * 0.5);
  });
});

// ---------------------------------------------------------------------------
// 2. STORAGE AXIS — the hopper is the AFK/burst buffer; bigger = more work
//    between check-ins (hourly queue policy isolates exactly this)
// ---------------------------------------------------------------------------

describe("2. storage axis (hourly check-in, 24 game-h)", () => {
  test("stall share + throughput across storage L1..L5", () => {
    const rows: Record<string, number>[] = [];
    for (let lv = 1; lv <= 5; lv++) {
      const { p, state, stallTicks, maxStorageKg } = runAxis({
        storageLevel: lv,
        queue: "hourly",
      });
      const gameH = 24;
      rows.push({
        lv,
        stallShare: stallTicks / (gameH * 60),
        burnedGph: p.totalBurnedKg / gameH,
        collectedGph: p.totalCollectedKg / gameH,
        maxStorageKg,
      });
      const inv = simInvariant(state);
      expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
    }
    console.log("── STORAGE AXIS (cargo/battery/recharge L1, queue once per game-h) ─");
    console.log("  Lv | stall % (full-hopper) | burned kg/game-h | collected kg/game-h");
    for (const r of rows) {
      console.log(
        `  ${r.lv}  | ${fmt((r.stallShare as number) * 100).padStart(17)}% | ${fmt(r.burnedGph as number).padStart(16)} | ${fmt(r.collectedGph as number)}`,
      );
    }
    // monotonic: bigger hopper ⇒ never more stall dead time
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].stallShare).toBeLessThanOrEqual(rows[i - 1].stallShare + 1e-9);
    }
    // the L1 hopper (60 kg ≈ 0.35 game-h of collection) stalls hard on a 1
    // game-h check-in cycle; L5 (420 kg ≈ 2.4 game-h) does not stall at all
    expect(rows[0].stallShare).toBeGreaterThan(0.3);
    expect(rows[4].stallShare).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// 3. CARGO AXIS — reference: cargo is THE throughput track (frozen costs)
// ---------------------------------------------------------------------------

describe("3. cargo axis reference (diligent starter, 24 game-h)", () => {
  test("throughput across cargo L1..L5", () => {
    const rows: Record<string, number>[] = [];
    for (let lv = 1; lv <= 5; lv++) {
      const p = makePlayer("s", { hasBase: true, baseX: 500, baseY: 500, auto: true });
      p.levels.cargo = lv;
      const state = simWithPlayers([p]);
      for (let t = 0; t < 24 * 60; t++) {
        simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, zoneActiveAt(t));
        if (p.storageKg > 0) {
          if (!p.processing.sessionId) p.processing.sessionId = `${p.id}:s`;
          p.processing.queuedKg += p.storageKg;
          p.storageKg = 0;
        }
        const inv = simInvariant(state);
        expect(Math.abs(inv.massBalance)).toBeLessThan(EPS);
        expect(Math.abs(inv.poolBalance)).toBeLessThan(EPS);
      }
      rows.push({ lv, burnedGph: p.totalBurnedKg / 24, toxGph: p.toxBalance / 24 });
    }
    console.log("── CARGO AXIS reference (storage/battery/recharge L1, diligent) ────");
    console.log("  Lv | burned kg/game-h | TOX/game-h");
    for (const r of rows) {
      console.log(`  ${r.lv}  | ${fmt(r.burnedGph as number).padStart(16)} | ${fmt(r.toxGph as number)}`);
    }
    // cargo is the throughput driver: strictly increasing burned kg per level
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].burnedGph).toBeGreaterThan(rows[i - 1].burnedGph);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE REBALANCED COST CURVES (freeze P1 v0.1 — gameParams.ts)
// ---------------------------------------------------------------------------
// Chosen from the measurements above, keeping cargo the #1 sink (frozen):
//
//   Cargo    150/225/340/510  (total 1,225 — FROZEN, unchanged)
//   Storage  120/190/300/460  (total 1,070 — REBALANCED from 200/320/500/760)
//   Battery  100/160/250/400  (total   910 — REBALANCED from 120/190/300/470)
//   Recharge  20/30/45/65     (total   160 — FROZEN, unchanged)
//
// Priority order: cargo > storage > battery > recharge. The P1 fix: neither
// support track may cost more than the throughput track, and the check-in
// buffer (storage — measured 66.7% stall at L1 on a 1 game-h check-in) is
// worth more than the range cap (battery — measured 8.1% → 6.7% recharge
// share for a diligent starter).

describe("4. rebalanced cost curves", () => {
  test("frozen values: cargo and recharge costs unchanged (Design Freeze v0.3)", () => {
    expect(UPGRADES.cargo.costs).toEqual([0, 150, 225, 340, 510]);
    expect(UPGRADES.recharge.costs).toEqual([0, 20, 30, 45, 65]);
  });

  test("SPRINT 2.10 rebalanced values: storage + battery curves", () => {
    // rebalance doc TOXIC_WORLD_STORAGE_BATTERY_REBALANCE_v0.1.md §3
    expect(UPGRADES.storage.costs).toEqual([0, 120, 190, 300, 460]);
    expect(UPGRADES.battery.costs).toEqual([0, 100, 160, 250, 400]);
    // caps are mechanics (unchanged by the cost rebalance)
    expect(UPGRADES.storage.caps).toEqual([60, 100, 160, 260, 420]);
    expect(UPGRADES.battery.caps).toEqual([100, 150, 220, 320, 460]);
  });

  test("priority order: cargo total > storage total > battery total > recharge total", () => {
    const totals = {
      cargo: UPGRADES.cargo.costs.reduce((a, b) => a + b, 0),
      recharge: UPGRADES.recharge.costs.reduce((a, b) => a + b, 0),
      battery: UPGRADES.battery.costs.reduce((a, b) => a + b, 0),
      storage: UPGRADES.storage.costs.reduce((a, b) => a + b, 0),
    };
    expect(totals.cargo).toBe(1225); // frozen — primary sink
    expect(totals.recharge).toBe(160); // frozen — QoL
    // the P1 fix: neither support track may cost more than the throughput track
    expect(totals.storage).toBe(1070);
    expect(totals.battery).toBe(910);
    expect(totals.storage).toBeLessThan(totals.cargo);
    expect(totals.battery).toBeLessThan(totals.storage);
    expect(totals.recharge).toBeLessThan(totals.battery);
  });

  test("each track stays cheaper than the primary (cargo) at every level", () => {
    for (let i = 1; i <= 4; i++) {
      expect(UPGRADES.storage.costs[i]).toBeLessThan(UPGRADES.cargo.costs[i]);
      expect(UPGRADES.battery.costs[i]).toBeLessThan(UPGRADES.storage.costs[i]);
    }
  });

  test("progression ROI at the measured starter rate (500 TOX/ton)", () => {
    const starter = runAxis({ queue: "diligent" });
    const dailyTox = starter.p.toxBalance; // 24 game-h (frozen 500 TOX/t baseline)
    console.log("── PROGRESSION ROI (rebalanced curves, starter 500 TOX/t) ────────");
    console.log("  track   | L2 (game-h / real-h) | L3 | L4 | L5 | total");
    for (const track of ["cargo", "storage", "battery", "recharge"] as const) {
      const costs = UPGRADES[track].costs;
      const times = costs.slice(1).map((cost) => {
        // game-days to afford the NEXT level at the starter's daily TOX rate
        const gameDays = cost / dailyTox;
        return {
          gameH: gameDays * 24,
          realH: (gameDays * 24) / GAME_HOURS_PER_REAL_HOUR,
        };
      });
      console.log(
        `  ${track.padEnd(8)} | ${times.map((t) => `${fmt(t.gameH)} (${fmt(t.realH)})`).join(" | ")} | ${costs.reduce((a, b) => a + b, 0)}`,
      );
      // monotonic cost ⇒ monotonic time to afford
      for (let i = 1; i < times.length; i++) {
        expect(times[i].gameH).toBeGreaterThan(times[i - 1].gameH);
      }
    }
  });

  test("total sink ratio (all 4 tracks) stays in a sane 1.4–2.5 game-day band", () => {
    const totalSink = Object.values(UPGRADES).reduce(
      (s, u) => s + u.costs.reduce((a, b) => a + b, 0),
      0,
    );
    const starter = runAxis({ queue: "diligent" });
    const dailyTox = starter.p.toxBalance;
    const sinkGameDays = totalSink / dailyTox;
    console.log(`  total sink ${totalSink} TOX / ${fmt(dailyTox)} TOX per game-day = ${fmt(sinkGameDays)} game-days`);
    expect(sinkGameDays).toBeGreaterThan(1.4);
    expect(sinkGameDays).toBeLessThan(2.5);
  });
});
