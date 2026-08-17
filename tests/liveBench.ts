// TOXIC WORLD — Sprint 2.6 LIVE-DB LOAD & CONCURRENCY BENCHMARK DRIVER.
//
// Seeds synthetic players on the REAL Convex deployment, drives unthrottled
// ticks, measures latency (p50/p95/p99), audits both invariant layers,
// duplicate reservations and reward-key uniqueness, then cleans up.
//
// Usage (from project root, quota-frugal — always clean up immediately):
//   bun tests/liveBench.ts 1000 5 0.5 0.3 0.2      # count ticks active storage queue
//   bun tests/liveBench.ts 10000 5 0.5 0.05 0.05   # 10k (watch the op budget)
//   bun tests/liveBench.ts 100 3 --no-reset        # no clean-world reset first
//
// Exit code: 0 PASS, 1 ERROR (deployment unreachable / seed failure),
//            2 FAIL (invariant or reservation checks failed).

import { execFileSync } from "node:child_process";

const [countRaw = "1000", ticksRaw = "5", activeRaw = "0.5", storageRaw = "0.3", queueRaw = "0.2", ...rest] =
  process.argv.slice(2);
const noReset = rest.includes("--no-reset");
const count = Number(countRaw);
const ticks = Number(ticksRaw);
const activeFraction = Number(activeRaw);
const storageFraction = Number(storageRaw);
const queueFraction = Number(queueRaw);

const CHUNK = 2000;
const CLEANUP_LIMIT = 500;

function parseJson(out: string): any {
  const s = out.indexOf("{");
  const e = out.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`no JSON in convex output:\n${out}`);
  return JSON.parse(out.slice(s, e + 1));
}

function convexRun(fn: string, args?: Record<string, unknown>): any {
  const argv = ["convex", "run", fn];
  if (args) argv.push("--args", JSON.stringify(args));
  const out = execFileSync("bunx", argv, {
    encoding: "utf8",
    timeout: 150_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseJson(out);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const report: Record<string, unknown> = {
  count,
  ticks,
  activeFraction,
  storageFraction,
  queueFraction,
  startedAt: new Date().toISOString(),
};

function cleanup(): { loops: number; deleted: number } {
  let loops = 0;
  let deleted = 0;
  while (loops < 200) {
    const r = convexRun("harness:cleanupLoad", { limit: CLEANUP_LIMIT });
    deleted += r.playersDeleted;
    loops++;
    if (r.playersDeleted === 0) break;
  }
  return { loops, deleted };
}

try {
  // 1) clean-world baseline (unless --no-reset)
  if (!noReset) {
    const r = convexRun("harness:resetWorld");
    report.reset = {
      worldId: r.worldId,
      pollutionFrac: r.pollutionFrac,
      invariantSkewKg: r.invariantSkewKg,
    };
  }

  // 2) seed in chunks (each mutation stays under the write budget)
  let created = 0;
  for (let i = 0; i < count; i += CHUNK) {
    const r = convexRun("harness:seedLoad", {
      count: Math.min(CHUNK, count - i),
      activeFraction,
      storageFraction,
      queueFraction,
    });
    created += r.created;
  }
  report.seeded = created;

  // 3) warmup tick (first tick pays cold-start cost, excluded from stats)
  convexRun("harness:tickOnce");

  // 4) measured ticks
  const latencies: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = convexRun("harness:tickOnce");
    latencies.push(r.tickMs);
  }
  latencies.sort((a, b) => a - b);
  report.tickLatencyMs = {
    samples: latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies[latencies.length - 1] ?? 0,
    avg: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0,
  };

  // 5) live audit
  const status = convexRun("harness:benchStatus");
  report.status = status;

  const invariantPass =
    Math.abs(status.massBalance) < 0.1 && Math.abs(status.poolBalance) < 0.1;
  const reservationPass =
    status.dupReservations === 0 && status.reservationMismatch === 0;
  const ledgerPass = status.ledgerSample.uniqueKeys === status.ledgerSample.rows;
  const pass = invariantPass && reservationPass && ledgerPass;
  report.pass = pass;
  report.checks = {
    invariantPass,
    reservationPass,
    ledgerPass,
  };

  // 6) cleanup (always — even on failed checks)
  report.cleanup = cleanup();
} catch (e: any) {
  report.error = String(e?.message ?? e);
  try {
    report.cleanup = cleanup();
  } catch {
    // deployment may be unreachable — cleanup is best-effort
  }
} finally {
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.error ? 1 : report.pass ? 0 : 2);
}
