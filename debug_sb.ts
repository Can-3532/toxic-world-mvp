import { UPGRADES, WORLD } from "./src/convex/gameParams";
import { makePlayer, simTick, simWithPlayers, type SimPlayer, type SimState } from "./tests/engineSim";

const zoneActiveAt = (t: number) => t % 16 < 4;
const GAME_HOURS_PER_REAL_HOUR = ((3600 / WORLD.TICK_SECONDS) * WORLD.GAME_MINUTES_PER_TICK) / 60;

function runAxis(opts: { cargoLevel?: number; batteryLevel?: number; storageLevel?: number; rechargeLevel?: number; queue: "diligent" | "hourly"; gameHours?: number }) {
  const gameHours = opts.gameHours ?? 24;
  const p = makePlayer("s", { hasBase: true, baseX: 500, baseY: 500, auto: true });
  if (opts.cargoLevel) { p.levels.cargo = opts.cargoLevel; }
  if (opts.batteryLevel) { p.levels.battery = opts.batteryLevel; p.robot.battery = UPGRADES.battery.caps[opts.batteryLevel - 1]; }
  if (opts.storageLevel) { p.levels.storage = opts.storageLevel; }
  if (opts.rechargeLevel) { p.levels.recharge = opts.rechargeLevel; }
  const state = simWithPlayers([p]);
  const ticks = Math.round((gameHours * 60) / WORLD.GAME_MINUTES_PER_TICK);
  let rechargeTicks = 0, stallTicks = 0, maxStorageKg = 0, maxQueueKg = 0;
  for (let t = 0; t < ticks; t++) {
    simTick(state, 1_000_000 + t * WORLD.TICK_SECONDS * 1000, zoneActiveAt(t));
    if (p.storageKg > 0) {
      const due = opts.queue === "diligent" || (opts.queue === "hourly" && t % 60 === 59);
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
  }
  return { p, state, rechargeTicks, stallTicks, maxStorageKg, maxQueueKg };
}

const fmt = (n: number) => Number.isFinite(n) ? n.toFixed(2) : "∞";
const gameH = 24;

console.log("── CARGO AXIS (storage/battery/recharge L1, diligent queue) ──");
console.log("  Lv | burned kg/game-h | TOX/game-h");
for (let lv = 1; lv <= 5; lv++) {
  const { p } = runAxis({ cargoLevel: lv, queue: "diligent" });
  console.log(`  L${lv} | ${fmt(p.totalBurnedKg / gameH).padStart(16)} | ${fmt(p.toxBalance / gameH)}`);
}

console.log("── STORAGE AXIS (cargo/battery/recharge L1, HOURLY check-in) ──");
console.log("  Lv | cap | stall % | burned kg/game-h");
for (let lv = 1; lv <= 5; lv++) {
  const { p, stallTicks, maxStorageKg } = runAxis({ storageLevel: lv, queue: "hourly" });
  console.log(`  L${lv} | ${UPGRADES.storage.caps[lv - 1]} | ${fmt((stallTicks / (gameH * 60)) * 100).padStart(8)}% | ${fmt(p.totalBurnedKg / gameH).padStart(16)} | maxStorage=${fmt(maxStorageKg)}`);
}

console.log("── BATTERY AXIS (diligent queue, recharge L1) ──");
console.log("  Lv | cap | recharge % | burned kg/game-h");
for (let lv = 1; lv <= 5; lv++) {
  const { p, rechargeTicks } = runAxis({ batteryLevel: lv, queue: "diligent" });
  console.log(`  L${lv} | ${UPGRADES.battery.caps[lv - 1]} | ${fmt((rechargeTicks / (gameH * 60)) * 100).padStart(8)}% | ${fmt(p.totalBurnedKg / gameH)}`);
}

console.log("── RECHARGE AXIS (diligent queue, battery L1) ──");
console.log("  Lv | rate | recharge % | burned kg/game-h");
for (let lv = 1; lv <= 5; lv++) {
  const { p, rechargeTicks } = runAxis({ rechargeLevel: lv, queue: "diligent" });
  console.log(`  L${lv} | ${UPGRADES.recharge.rates[lv - 1]} | ${fmt((rechargeTicks / (gameH * 60)) * 100).padStart(8)}% | ${fmt(p.totalBurnedKg / gameH)}`);
}

// Progression ROI at new starter rate (79.98 TOX/game-h from protection test)
const rate = 1919.5 / 24;
console.log(`\n── PROGRESSION ROI @ ${rate.toFixed(2)} TOX/game-h (new baseline 1,919.5/day) ──`);
const tracks: Record<string, number[]> = { Cargo: UPGRADES.cargo.costs, Storage: UPGRADES.storage.costs, Battery: UPGRADES.battery.costs, Recharge: UPGRADES.recharge.costs };
for (const [name, costs] of Object.entries(tracks)) {
  const step = costs.map((c) => c / rate);
  const cum = step.reduce((a, v) => a + v, 0);
  console.log(`  ${name}: L2..L5 = ${step.map((s) => fmt(s)).join(" / ")} game-h (cum ${fmt(cum)} game-h = ${fmt(cum / 12)} real-h)`);
}
console.log(`  TOTAL sink 3,365 TOX → ${fmt(3365 / 1919.5)} game-days`);
