// TOXIC WORLD — SPRINT 2.6 LIVE-DB LOAD BENCHMARK DRIVER.
//
// Drives the REAL Convex deployment (not the headless sim): seeds synthetic
// players, runs back-to-back unthrottled ticks (`harness:tickOnce`), records
// engine tick time (user code + DB ops, returned by the mutation) plus wall
// time, and reads `harness:benchStatus` for invariants / duplicate checks.
//
// Usage:
//   bun tests/liveBench.ts <scale> <ticks> [activeFraction] [queueFraction]
//   e.g. bun tests/liveBench.ts 10000 8 0.5 0.05

import { spawnSync } from "node:child_process";

const scale = Number(process.argv[2] ?? 10);
const ticks = Number(process.argv[3] ?? 8);
const activeFraction = Number(process.argv[4] ?? 0.5);
const queueFraction = Number(process.argv[5] ?? (scale >= 10000 ? 0.05 : 0.2));
const SEED_BATCH = scale > 2000 ? 2000 : scale;

function convexRun(fn: string, args?: unknown): { json: any; ok: boolean; raw: string } {
  const argv = ["x", "convex", "run", fn];
  if (args !== undefined) argv.push(JSON.stringify(args));
  const r = spawnSync("bun", argv, { encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  let json: any = null;
  const out = (r.stdout || "").trim();
  try {
    json = JSON.parse(out);
  } catch {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        json = JSON.parse(m[0]);
      } catch {
        /* keep null */
      }
    }
  }
  return { json, ok: r.status === 0 && !!json, raw: (out || r.stderr || "").slice(0, 500) };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

log(`=== LIVE LOAD TEST scale=${scale} ticks=${ticks} active=${activeFraction} queueFrac=${queueFraction} ===`);

// 1) cleanup any leftovers, then reset to a pristine world so both invariant
//    layers start at exactly 0 (benchmarks run on the clean baseline)
for (let i = 0; i < 60; i++) {
  const r = convexRun("harness:cleanupLoad", { limit: 500 });
  if (!r.ok) break;
  if (r.json?.playersDeleted === 0) break;
}
convexRun("harness:resetWorld");

// 2) seed in chunks
const batches = Math.ceil(scale / SEED_BATCH);
let seeded = 0;
for (let i = 0; i < batches; i++) {
  const n = Math.min(SEED_BATCH, scale - i * SEED_BATCH);
  const r = convexRun("harness:seedLoad", {
    count: n,
    activeFraction,
    storageFraction: 0.3,
    queueFraction,
  });
  if (!r.ok) {
    log("SEED FAIL:", r.raw);
    process.exit(1);
  }
  seeded += r.json.created;
}
log(`seeded ${seeded} synthetic players`);

// 3) warmup tick (compiles + moves robots out of idle)
convexRun("harness:tickOnce");

// 4) measured ticks
const tickMs: number[] = [];
const wallMs: number[] = [];
let failures = 0;
const first = convexRun("harness:tickOnce");
let last = first;
for (let i = 0; i < ticks; i++) {
  const w0 = performance.now();
  const r = convexRun("harness:tickOnce");
  const wall = performance.now() - w0;
  if (!r.ok || r.json?.advanced !== true) {
    failures++;
    log(`TICK ${i} FAIL:`, r.raw);
    continue;
  }
  tickMs.push(r.json.tickMs);
  wallMs.push(wall);
  last = r;
}
const sorted = [...tickMs].sort((a, b) => a - b);
const wSorted = [...wallMs].sort((a, b) => a - b);

// 5) status + progression
const status = convexRun("harness:benchStatus").json ?? {};
const genDelta = (last.json?.world?.generatedKg ?? 0) - (first.json?.world?.generatedKg ?? 0);
const polDelta = (last.json?.world?.pollutionKg ?? 0) - (first.json?.world?.pollutionKg ?? 0);
const genPerTick = genDelta / Math.max(1, tickMs.length);
const expectedGenPerTick = (status.activeBases ?? 0) * 50 * (1 / 60);

// 6) cleanup
let deleted = 0;
for (let i = 0; i < 120; i++) {
  const r = convexRun("harness:cleanupLoad", { limit: 500 });
  if (!r.ok) break;
  deleted += r.json?.playersDeleted ?? 0;
  if ((r.json?.playersDeleted ?? 1) === 0) break;
}

// 7) report
console.log("\n=== RESULTS ===");
console.log(JSON.stringify(
  {
    scale,
    ticks: tickMs.length,
    failures,
    tickMs: {
      mean: tickMs.reduce((a, b) => a + b, 0) / Math.max(1, tickMs.length),
      min: sorted[0],
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      p99: pct(sorted, 0.99),
      max: sorted[sorted.length - 1],
    },
    wallMs: {
      mean: wallMs.reduce((a, b) => a + b, 0) / Math.max(1, wallMs.length),
      p50: pct(wSorted, 0.5),
      p95: pct(wSorted, 0.95),
    },
    progression: {
      generatedKgDelta: genDelta,
      genPerTickMeasured: genPerTick,
      genPerTickExpected: expectedGenPerTick,
      pollutionKgDelta: polDelta,
    },
    db: {
      players: status.players,
      syntheticPlayers: status.syntheticPlayers,
      activeBases: status.activeBases,
      autoRobots: status.autoRobots,
      clusters: status.clusters,
      storageKg: status.storageKg,
      queuedKg: status.queuedKg,
    },
    integrity: {
      massBalance: status.massBalance,
      poolBalance: status.poolBalance,
      skewKg: status.skewKg,
      dupReservations: status.dupReservations,
      reservationMismatch: status.reservationMismatch,
      ledgerSample: status.ledgerSample,
    },
    cleanup: { deleted },
  },
  null,
  2,
));
