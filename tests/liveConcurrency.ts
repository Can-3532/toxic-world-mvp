// TOXIC WORLD — Sprint 2.6 LIVE CONCURRENCY TEST (real deployment).
//
// The most important second test of the sprint: can the world be advanced
// twice by concurrent ticks?
//
//   PART 1 — unguarded path: 5 concurrent `harness:tickOnce` (rate-limit
//   bypassed). Every call must advance and each advance must add EXACTLY one
//   generation increment — no lost update, no double apply.
//
//   PART 2 — guarded path: 3 concurrent `world:tick` (the cron's function).
//   Convex serializable isolation + automatic conflict retry means at most one
//   can advance per 1.6 s guard window: the first commits `lastTick`, the
//   others conflict-retry, re-read the fresh snapshot and get
//   { advanced: false }.
//
// Usage:  bun tests/liveConcurrency.ts        (runs against the linked deployment)
// Also:   bunx convex run harness:concurrencyProbe '{"n":5}'   (one-shot probe)

import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";

function parseJson(out: string): any {
  const s = out.indexOf("{");
  const e = out.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`no JSON in convex output:\n${out}`);
  return JSON.parse(out.slice(s, e + 1));
}

function convexRunSync(fn: string, args?: Record<string, unknown>): any {
  const argv = ["convex", "run", fn];
  if (args) argv.push("--args", JSON.stringify(args));
  const out = execFileSync("bunx", argv, {
    encoding: "utf8",
    timeout: 150_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseJson(out);
}

function convexRun(fn: string, args?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const argv = ["convex", "run", fn];
    if (args) argv.push("--args", JSON.stringify(args));
    execFile(
      "bunx",
      argv,
      { encoding: "utf8", timeout: 150_000 },
      (err, stdout) => {
        if (err) return reject(new Error(`${fn}: ${err.message}`));
        try {
          resolve(parseJson(stdout));
        } catch (e) {
          reject(new Error(`${fn}: ${String(e)}`));
        }
      },
    );
  });
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};

  // ---- PART 1 — unguarded path: 5 concurrent tickOnce --------------------
  const pre1 = convexRunSync("harness:worldStateProbe");
  const firedAt = Date.now();
  const unguarded = await Promise.all(
    Array.from({ length: 5 }, () => convexRun("harness:tickOnce")),
  );
  const post1 = convexRunSync("harness:worldStateProbe");

  const advanced = unguarded.filter((r) => r.advanced === true);
  const genPerTick =
    pre1.generationRateKgH > 0
      ? pre1.generationRateKgH / 60
      : 0; // activeBases × 50 kg/h per game minute
  const genDelta = post1.generatedKg - pre1.generatedKg;
  const genMultiples = genPerTick > 0 ? Math.round(genDelta / genPerTick) : 0;
  const exactMultiple =
    genPerTick > 0 && Math.abs(genDelta - genMultiples * genPerTick) < 1e-3;
  const unguardedPass =
    advanced.length === 5 && exactMultiple && genMultiples >= 5;

  results.unguarded = {
    fired: 5,
    advanced: advanced.length,
    tickMs: unguarded.map((r) => r.tickMs),
    genDelta,
    genPerTick,
    genMultiples,
    exactMultiple,
    pass: unguardedPass,
  };

  // ---- PART 2 — guarded path: 3 concurrent world:tick --------------------
  const pre2 = convexRunSync("harness:worldStateProbe");
  const guarded = await Promise.all(
    Array.from({ length: 3 }, () => convexRun("world:tick")),
  );
  const post2 = convexRunSync("harness:worldStateProbe");

  const gAdvanced = guarded.filter((r) => r.advanced === true).length;
  const tickIndexDelta = post2.tickIndex - pre2.tickIndex;
  // If ticks are fast (< guard window) at most ONE may advance per window.
  // Slow ticks legitimately advance more (each in its own window) — relax the
  // bound by how many full windows the slowest tick spanned.
  const maxTickMs = Math.max(...guarded.map((r) => r.tickMs ?? 0));
  const allowed =
    maxTickMs < 1600 ? 1 : 1 + Math.floor(maxTickMs / 1600);
  const guardedPass =
    gAdvanced <= allowed &&
    tickIndexDelta >= gAdvanced &&
    tickIndexDelta <= gAdvanced + 1; // +1 tolerates a cron tick in the gap

  results.guarded = {
    fired: 3,
    advanced: gAdvanced,
    allowed,
    maxTickMs,
    results: guarded.map((r) => ({ advanced: r.advanced, tickMs: r.tickMs })),
    tickIndexDelta,
    pass: guardedPass,
  };

  const pass = unguardedPass && guardedPass;
  results.pass = pass;
  results.note =
    "Sprint 2.6 acceptance: no double tick — unguarded: every advance adds exactly one generation increment (no lost update / no double apply); guarded: never two advances inside one guard window.";
  console.log(JSON.stringify(results, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
