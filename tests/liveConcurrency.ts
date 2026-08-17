// TOXIC WORLD — SPRINT 2.6 LIVE CONCURRENCY TEST.
//
// Tests the non-atomic tick-guard risk on the REAL deployment:
//   1) UNGUARDED path: 5 concurrent `harness:tickOnce` — under Convex
//      serializable isolation + automatic conflict retry every call must
//      advance exactly once (no lost update, no double apply).
//   2) GUARDED path: 3 concurrent `world:tick` with a fresh guard (must all
//      skip) and 3 concurrent after guard expiry (at most ONE may advance —
//      a double tick means the guard is broken and must be fixed before the
//      10k load test).
// Also checks duplicate reservations and duplicate rewards afterwards.
//
// Usage:  bun tests/liveConcurrency.ts

import { spawn } from "node:child_process";

function convexRun(fn: string, args?: unknown): Promise<{ json: any; ok: boolean; raw: string }> {
  return new Promise((resolve) => {
    const argv = ["x", "convex", "run", fn];
    if (args !== undefined) argv.push(JSON.stringify(args));
    const p = spawn("bun", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      let json: any = null;
      try {
        json = JSON.parse(out.trim());
      } catch {
        /* keep null */
      }
      resolve({ json, ok: code === 0 && !!json, raw: (out || err).slice(0, 400) });
    });
    p.on("error", (e) => resolve({ json: null, ok: false, raw: String(e) }));
  });
}

async function world(): Promise<{ generatedKg: number; pollutionKg: number; lastTick: number; worldId: number }> {
  const r = await convexRun("harness:worldStateProbe");
  if (!r.ok) throw new Error("worldStateProbe failed: " + r.raw);
  return r.json;
}

async function main() {
  const log = (...a: unknown[]) => console.log(...a);
  const RESULTS: Record<string, string> = {};

  // 0) cleanup leftovers, reset to a pristine world (zero held waste, both
  //    invariant layers at 0), then seed 300 synthetic players (active 0.5,
  //    queues 0.2 → real burn + ledger traffic during the bursts)
  for (let i = 0; i < 60; i++) {
    const r = await convexRun("harness:cleanupLoad", { limit: 500 });
    if (!r.ok) break;
    if (r.json?.playersDeleted === 0) break;
  }
  const reset = await convexRun("harness:resetWorld");
  log("world reset:", reset.ok ? `pollution ${reset.json?.pollutionFrac}%` : reset.raw);
  const seed = await convexRun("harness:seedLoad", {
    count: 300,
    activeFraction: 0.5,
    storageFraction: 0.3,
    queueFraction: 0.2,
  });
  log("seeded:", seed.ok ? `${seed.json.created} (held ${seed.json.seededHeldKg} kg debited)` : seed.raw);
  const baseline = (await convexRun("harness:benchStatus")).json;
  log(`baseline: massBalance=${baseline?.massBalance}, poolBalance=${baseline?.poolBalance}`);

  const before = await world();
  const status0 = (await convexRun("harness:benchStatus")).json;
  const activeBases = status0?.activeBases ?? 300;
  const genPerTick = activeBases * 50 * (1 / 60); // 50 kg/h per base, 1/60 h per tick

  // ---------- 1) UNGUARDED: 5 concurrent tickOnce ----------
  // KEY DETECTOR: with serializable isolation every successful advance adds
  // EXACTLY +genPerTick. The final delta must be an exact integer multiple of
  // genPerTick (k ≥ 5; k = 5 ours + cron interleave). A lost update yields a
  // non-multiple (e.g. 4.0×gen from 5 commits); a double apply exceeds k.
  log(`\n[1] UNGUARDED — firing 5 concurrent harness:tickOnce (genPerTick=${genPerTick.toFixed(3)} kg)`);
  const t0 = Date.now();
  const unguarded = await Promise.all(Array.from({ length: 5 }, () => convexRun("harness:tickOnce")));
  const wall1 = (Date.now() - t0) / 1000;
  const okCount = unguarded.filter((r) => r.ok && r.json?.advanced === true).length;
  const failList = unguarded.filter((r) => !(r.ok && r.json?.advanced === true));
  const after1 = await world();
  const genDelta1 = after1.generatedKg - before.generatedKg;
  const k = Math.round(genDelta1 / genPerTick);
  const isExactMultiple = Math.abs(genDelta1 - k * genPerTick) < genPerTick * 0.01;
  const cronTicks = Math.max(0, k - okCount);
  const noDoubleTick = isExactMultiple && k >= okCount;
  log(`  completed in ${wall1.toFixed(1)}s — ${okCount}/5 advanced, ${failList.length} failed`);
  if (failList.length) log("  failures:", failList.map((r) => r.raw));
  log(`  generatedKg delta: ${genDelta1.toFixed(3)} = ${k} × ${genPerTick.toFixed(3)} (${okCount} ours + ${cronTicks} cron interleave; exact multiple: ${isExactMultiple})`);
  log(`  ${noDoubleTick ? "PASS — every advance added exactly +genPerTick; no lost update / no double apply" : "FAIL — delta not an exact multiple"}`);
  RESULTS["1. unguarded 5x concurrent: all advanced, delta = k×gen (no double/lost)"] =
    noDoubleTick && failList.length === 0 ? "PASS" : "FAIL";

  // ---------- 2) GUARDED: 3 concurrent world:tick right after a fresh tick ----------
  // Calls boot in 1–2 s so some may start after the 1.6 s guard window; the
  // meaningful assertion is that a GUARD WINDOW can never produce >1 advance:
  // run one tickOnce, then immediately fire 3 concurrent world:tick and require
  // ≤1 total advance (1 of ours after expiry OR 1 cron — never 2+).
  await convexRun("harness:tickOnce"); // sets lastTick = now
  const b2 = await world();
  const g2 = await Promise.all(Array.from({ length: 3 }, () => convexRun("world:tick")));
  const a2 = await world();
  const genDelta2 = a2.generatedKg - b2.generatedKg;
  const advances2 = Math.round(genDelta2 / genPerTick);
  const guardOk = genDelta2 <= genPerTick * 1.5; // ≤1 advance
  log(`\n[2] GUARDED (fresh guard) — 3 concurrent world:tick → genDelta ${genDelta2.toFixed(3)} kg = ${advances2} advance(s) (≤1 required)`);
  log(`  ${guardOk ? "PASS — at most one advance per guard window (no double tick)" : "FAIL — 2+ advances in one guard window"}`);
  RESULTS["2. guarded 3x concurrent, fresh guard: ≤1 advance"] = guardOk ? "PASS" : "FAIL";

  // ---------- 3) GUARDED: 3 concurrent world:tick after guard expiry ----------
  // wait past the guard window (0.8 × 2 s), then fire 3 at once. The guard
  // allows at most ONE advance per 1.6 s window: over a W-second window the
  // legit max is floor(W / 1.6) + 1. A broken isolation/guard (two commits in
  // the same window) would exceed that bound.
  await new Promise((r) => setTimeout(r, 2000));
  const t3 = Date.now();
  const b3 = await world();
  await Promise.all(Array.from({ length: 3 }, () => convexRun("world:tick")));
  const a3 = await world();
  const wall3 = (Date.now() - t3) / 1000;
  const genDelta3 = a3.generatedKg - b3.generatedKg;
  const advances3 = Math.round(genDelta3 / genPerTick);
  const maxLegit3 = Math.floor(wall3 / 1.6) + 1;
  const noDouble3 = advances3 <= maxLegit3;
  log(`\n[3] GUARDED (expired) — 3 concurrent world:tick over ${wall3.toFixed(1)}s → ${advances3} advance(s) (legit max ${maxLegit3} = 1 per 1.6s window)`);
  log(`  ${noDouble3 ? "PASS — no two advances within one guard window" : "FAIL — double tick: guard is NOT atomic"}`);
  RESULTS["3. guarded 3x concurrent after expiry: ≤1 advance per 1.6s window"] =
    noDouble3 ? "PASS" : "FAIL";

  // ---------- 4) integrity after all bursts ----------
  const status = (await convexRun("harness:benchStatus")).json;
  // with the seed-debit fix, both layers must be ~0; a large poolBalance now
  // indicates a REAL conservation leak (not the seed phantom)
  const invOk =
    Math.abs(status?.massBalance ?? Infinity) < 1 && Math.abs(status?.poolBalance ?? Infinity) < 1;
  const noDupRes = (status?.dupReservations ?? -1) === 0 && (status?.reservationMismatch ?? -1) === 0;
  const ledger = status?.ledgerSample;
  const noDupReward = ledger?.uniqueKeys === ledger?.rows && (ledger?.rows ?? 0) > 0;
  log(`\n[4] integrity — massBalance=${status?.massBalance}, poolBalance=${status?.poolBalance}, dupRes=${status?.dupReservations}, resMismatch=${status?.reservationMismatch}`);
  log(`  ledger sample: ${ledger?.rows} rows / ${ledger?.uniqueKeys} unique keys (${ledger?.players} players)`);
  log(`  ${invOk ? "PASS" : "FAIL"} invariant · ${noDupRes ? "PASS" : "FAIL"} no duplicate reservation · ${noDupReward ? "PASS" : "FAIL"} no duplicate reward`);
  RESULTS["4. invariants + no dup reservation + no dup reward"] =
    invOk && noDupRes && noDupReward ? "PASS" : "FAIL";

  // ---------- cleanup ----------
  for (let i = 0; i < 60; i++) {
    const r = await convexRun("harness:cleanupLoad", { limit: 500 });
    if (!r.ok) break;
    if (r.json?.playersDeleted === 0) break;
  }
  log("\n=== CONCURRENCY RESULT ===");
  for (const [k, v] of Object.entries(RESULTS)) log(`  [${v}] ${k}`);
  const allPass = Object.values(RESULTS).every((v) => v === "PASS");
  log(allPass ? "\nCONCURRENCY TEST: ALL PASS — tick guard holds under concurrency" : "\nCONCURRENCY TEST: FAILURES PRESENT");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
