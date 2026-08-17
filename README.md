# TOXIC WORLD — MVP (Freebuff Web build)

Multiplayer survival/economy game: players buy a base, send a spatial robot into
a **global waste pool**, haul clusters back, and **burn** them for **TOX**.
Only burning removes waste from the world; at 100% pollution the world collapses
and resets at 22.5%.

> **Design Freeze v0.4 (economy change):** burn rewards are TOX-only — the old
> SOL burn reward (`$10/ton`) is removed. Normal burn = **500 TOX/ton**, active
> Burn Zone = **600 TOX/ton (×1.2)**. SOL exists only on the entry side (mock
> 0.1 SOL base purchase).

This repository is the **web MVP** implementation: a Convex server-side world
engine + React frontend. The Python simulation engine and the FastAPI/WebSocket
backend from the design docs are **not** part of this repo (see handoff report).

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite 7 + TypeScript + Tailwind v4 + shadcn/ui + Framer Motion |
| Routing | React Router v7 (`react-router`) |
| Backend | Convex serverless functions (queries / mutations / cron) |
| Database | Convex document DB (dev deployment) |
| Auth | Convex Auth — email OTP + anonymous |
| Realtime | Convex reactive queries (not WebSocket) |
| Blockchain | **Not implemented** — mock economy ledger only |
| Package manager | Bun |

## Project structure

```
src/
  main.tsx                     # router + providers (routes: /, /auth, /game)
  pages/
    Landing.tsx                # public landing w/ live world telemetry
    Game.tsx                   # protected game page (RequireAuth)
    Auth.tsx                   # sign-in (email OTP / guest)
    NotFound.tsx
    Dashboard.tsx              # UNUSED template leftover (not routed)
  components/
    game/
      WorldMap.tsx             # map: clusters, base, animated robot
      Panels.tsx               # Base/Robot/Upgrades/World tabs
      format.ts                # display helpers
    RequireAuth.tsx
    ui/                        # shadcn registry
  convex/
    schema.ts                  # tables: users, worlds, wasteClusters, players, worldEvents, burnZones, rewardLedger
    gameParams.ts              # economy constants (Design Freeze v0.4) — shared w/ frontend
    economy.ts                 # pure v0.4 reward formulas + idempotency keys (unit-tested)
    engine.ts                  # pure engine math: invariant, Model C, pollution %, status, allocation (shared w/ tick + tests)
    world.ts                   # world engine: tick, seed, burn-zone lifecycle, queries, invariant telemetry
    game.ts                    # player mutations + queries
    crons.ts                   # toxic-world-tick (every 2 s) — MUST be named crons.ts
    harness.ts                 # Sprint 2.4 QA: live invariantAudit + one-time reanchorInvariant
    auth.ts / auth.config.ts / http.ts / users.ts / auth/emailOtp.ts
tests/
  economy.test.ts              # v0.4 reward formulas, idempotency, pollution accounting, progression ROI
  engineSim.ts                 # deterministic headless oracle simulator (same engine.ts/economy.ts functions)
  engine.test.ts               # Sprint 2.4 production engine test harness (10 scenarios, incl. 10k-player scale)
```

## Local setup

```bash
bun install
```

The Freebuff Web platform runs the Vite dev server and the Convex dev process in
managed background sessions — do **not** start/kill dev servers yourself.

Verification (the same checks the platform runs after every change):

```bash
# Convex codegen + push (only needed when touching src/convex/)
bun convex dev --once

# Typecheck whole project
bun tsc -b --noEmit

# Full production build (optional, heavy)
bun run build
```

## Environment variables

See `.env.example` (or `docs/ENV_VARIABLES.md` if the platform blocks the
`.env.example` filename). In Freebuff Web, secrets go in the **Keys / API keys**
UI, never in committed files. Real Solana vars (`COINBASE_COMMERCE_*`,
`SOLANA_TREASURY_PRIVATE_KEY`) are **planned, not used** by any code yet.

## Time model — TWO AXES (formal, Sprint 2.8)

Every mechanic is anchored to exactly ONE time axis. `1 game hour = 60 ticks
= 5 real minutes` (12× compression since Sprint 2.7 B; was 30× at 2 s/tick).

| Axis | Granularity | Mechanics | Anchored to |
|---|---|---|---|
| **REAL TIME** | 1 real second | Robot movement (m/s), battery drain/recharge, burn rate (kg/s) | `ROBOT.*`, `WORLD.PROCESSING_KG_PER_S` |
| **GAME TIME** | 1 tick = 1 game minute | Base generation, pollution economy, replenishment (Model C), demand | `WORLD.BASE_GEN_KG_H`, `REPLENISHMENT`, `DEMAND_REF_KG_H` (all kg per game hour) |

Conversions (5 s tick, 1 game-min/tick): `1 game-h = 60 ticks = 5 real-min`;
**kg/real-h = 12 × kg/game-h**; real-h times = game-h / 12.

- REAL-anchored rates are invariant across tick cadence changes: a robot's
  trip time, battery spend and the burner's 2 kg/s never depend on tick length.
- GAME-anchored rates (generation 50 kg/game-h, replenishment clip, demand
  reference 42 kg/game-h) are applied per tick via `GAME_MINUTES_PER_TICK/60`,
  so changing `TICK_SECONDS` does NOT change the per-game-hour economy.
- The burner slice per tick is REAL-anchored (kg/s × tick length): 10 kg/tick
  at 5 s ⇒ 600 kg/game-h and 7,200 kg/real-h.

## The game loop (server-side)

1. Every 5 s the cron `toxic-world-tick` calls `api.world.tick` (1 tick = 1 game
   minute — Sprint 2.7 B; was 2 s, which a 10k tick (~3.2 s) overflowed).
2. Bases generate `50 kg/h` each → `pollutionKg` (global waste).
3. Robots (spatial: position/speed/battery/cargo) travel to clusters
   (150–900 kg), collect up to cargo capacity, return, unload to storage.
4. `queueProcessing` moves storage into the burner; the tick burns `2 kg/s`
   → credits TOX only (500 TOX/ton; 600 TOX/ton while the random **Burn Zone**
   is active), written exactly-once to the `rewardLedger` (`sessionId:sliceIndex`
   keys).
5. Dynamic replenishment (Model C) unlocks hidden waste into the collectable pool.
6. `pollution >= 90%` → critical; `>= 100%` → collapse → world resets at 22.5% (World 1+).

## Tests

```bash
bun test tests/                 # all 69 tests (26 economy + 29 engine + 14 economy-validation), 3,686 assertions
bun test tests/engine.test.ts   # production engine test harness (Sprint 2.4 + 2.5 + 2.6)
bun test tests/economy.test.ts  # v0.4 reward formulas, idempotency, pollution accounting
bun test tests/economyValidation.test.ts  # Sprint 2.8: 5 s-tick economy (two time axes)

# Live invariant audit against the deployed Convex engine (read-only):
bunx convex run harness:invariantAudit
```

### Sprint 2.4 engine test harness (`tests/engine.test.ts`)

The headless harness validates the production engine math on the **same pure
functions the tick calls** (`engine.ts`, `economy.ts`, `gameParams.ts`), via a
deterministic oracle simulator (`tests/engineSim.ts`) that mirrors `world.ts`
step-for-step. Coverage:

1. **Waste invariant** — every tick: `pollution + burned == seed + generated`
   (mass balance) and pool conservation; also verified live via
   `world.invariantSkewKg` after every production tick.
2. **Pollution** — `pollution/capacity × 100` matches state at 0–100%.
3. **Dynamic Replenishment Model C** — `clip(0.05 × demand/generation, 5%, 9%)`.
4. **Batch Allocation** — low-level base access, high-level pool consumption,
   mixed populations, no double-reservation.
5. **Burn reward** — normal 500 TOX/t, Burn Zone 600 TOX/t, pollution drops 1:1.
6. **Idempotency** — the same session/slice can never credit TOX twice.
7. **World Collapse** — 99.999% → 100% → reset at 22.5%, post-collapse freeze.
8. **Critical recovery** — from 90%, burn > generation ⇒ pollution falls.
9. **Active/inactive** — 100 / 75 / 50 / 25% robot activity scaling.
10. **Scale** — 10 / 100 / 1,000 / 10,000 players; invariant holds at every
    scale; per-tick timings recorded.

```bash
# One-time repair for worlds created before Sprint 2.4 (adds the telemetry
# fields seedPollutionKg/generatedKg from first principles):
bunx convex run harness:reanchorInvariant
```

### Sprint 2.8 — time compression & economy validation (5 s tick)

Measured by `bun test tests/economyValidation.test.ts` (deterministic oracle
sim — same pure functions as the engine; 14 tests, green). Both axes explicit:

| Quantity (starter, measured) | GAME TIME | REAL TIME |
|---|---|---|
| Base generation | 50 kg/game-h | 600 kg/real-h |
| Burner capacity | 600 kg/game-h (10 kg/tick) | 7,200 kg/real-h (2 kg/s) |
| Starter collection (emergent) | **174.4 kg/game-h** | 2,092.6 kg/real-h |
| Starter TOX | **92.0 TOX/game-h** | 1,103.4 TOX/real-h |
| 24-hour TOX | **2,206.7** | 26,480.4 |

Starter → Cargo upgrades (measured; old design targets in parens):

| | L2 | L3 | L4 | L5 |
|---|---|---|---|---|
| game-h | **1.63** (7.8) | **4.08** (19.6) | **7.78** (37.3) | **13.32** (63.9) |
| real-h | **0.14** | **0.34** | **0.65** | **1.11** |

Findings:
1. **5 s tick preserves the per-game-hour economy.** Every per-tick delta is
   `GAME_MINUTES_PER_TICK`-anchored and identical to the 2 s-tick world; Model C
   verified tick-for-tick (`clip(0.05×demand/gen, 5%, 9%)`), hidden pool drains
   monotonically, both invariants hold every tick at machine precision.
2. **Measured starter throughput ≈ 174 kg/game-h ≈ 4× the design's 38.34 kg/h
   reference** → upgrades are ~4.8× faster in game-hours. Consequence: the
   Model C demand reference (42 kg/game-h) is far below real demand, so the
   demand/gen ratio sits at the **5% floor** in practice — replenishment is
   effectively floor-rate. Design follow-up (not a bug): re-anchor the demand
   reference to measured throughput, or keep 42 deliberately as a scarcity
   lever. A live starter measurement is recommended before rebalancing.
3. **Burn Zone unchanged by the tick change:** ~39 spawns/real-h (avg interval
   92 s), active 26.5% of real time, starter encounter ≈ 34% of burned TOX.
4. **Pollution worst-case** (synthetic players don't auto-queue, so burns are
   one-time): 10K → collapse ≈ 10.3 game-h (0.86 real-h); 1K → ≈ 102.7 game-h
   (8.6 real-h). Live players queueing steadily burn far more → slower
   collapse; the numbers are an upper bound.
5. **Storage (starter):** fill ≈ 0.35 game-h, ~8.8 unloads/game-h, processing
   backlog ≤ 20 kg (burner clears a full 60 kg storage in 30 real-s).

### Sprint 2.7 — tick architecture (A/B/C decision)

- **A — production benchmark: BLOCKED at credentials.** No production
  deployment exists for this project and this environment authenticates with a
  deploy key (`CONVEX_DEPLOY_KEY`) that cannot create deployments (interactive
  `convex login` is not possible here). Runbook once a prod deployment exists
  (create it in the Convex dashboard, or supply a prod deploy key):
  `CONVEX_DEPLOYMENT=<prod-url> bunx convex deploy`, then the same bench with
  `bunx convex run ... --prod` (see README top-level bench commands).
- **B — tick frequency redesign: IMPLEMENTED.** `WORLD.TICK_SECONDS 2 → 5`
  (1 game minute per tick unchanged). Per-game-hour rates (generation,
  replenishment, Model C, demand) are anchored to `GAME_MINUTES_PER_TICK` and
  are byte-identical per tick; real-time-anchored rates (battery, travel) are
  unchanged per real second; the real-time-anchored burner slice grew 4 →
  10 kg/tick (same 2 kg/s real). Economy re-tested: `bun test tests/` 55 pass.
  Live 10k dev bench: tick 1.8–3.6 s (p50 ≈ 2.4 s, p95 ≈ 3.6 s), DB ops/tick
  ~200 reads + ~500–1,000 writes, invariants ~1e-10, and the cron now completes
  **exactly every 5.0 s — cron drift eliminated** (pre-B the 2 s schedule
  backed up behind 3.3 s ticks and the world ran at ~60% real-time).
  Trade-off: compression changed 30× → 12× (game progress per real hour is
  2.5× slower); per-game-hour burner throughput 240 → 600 kg/h (same per real
  second).
- **C — sharded world engine: NOT implemented (deferred).** Spatial
  sharding (region-based robot/cluster partitions, per-shard processing)
  remains the scale path for 50k+ players, but B already satisfies the MVP
  (10k tick fits its window) without the migration cost.

### Sprint 2.6 — live-DB load & concurrency test

Tools (live deployment only, quota-frugal — always clean up immediately):

```bash
bun tests/liveConcurrency.ts              # concurrency: 5x unthrottled + guarded double-tick checks
bun tests/liveBench.ts 10000 5 0.5 0.05   # live load: seed N players, N ticks, latency stats, cleanup
bunx convex run harness:concurrencyProbe '{"n":5}'  # one-shot tick-guard atomicity probe
bunx convex run harness:benchStatus       # counts + both invariant layers + dup checks
# cleanup (loop until playersDeleted == 0):
#   bunx convex run harness:cleanupLoad '{"limit":500}'
```

Results (LIVE on `jovial-chickadee-617`, usage limit re-enabled, full sequence
cleanup → reset → concurrency → 10/100/1k/10k benches → audit → cleanup → reset):
- **Headless engine suite: ALL PASS** (`bun test tests/` — 55 tests / 179
  assertions), including the 10k-player scale sim (invariant holds at every
  scale; 10k headless tick ≈ 55 ms).
- **Concurrency: PASS (live).** 5 concurrent unthrottled `tickOnce` — all 5
  advanced, `genDelta = 7 × genPerTick` EXACT (5 ours + 2 cron): no lost
  update, no double apply. 3 concurrent guarded `world:tick` — **0 advanced**
  (all blocked by the fresh guard; only the cron's legitimate 1 advance in the
  4.3 s window). Double-advance is impossible; **no guard fix needed**.
- **Correctness at every scale: PASS.** 10 / 100 / 1,000 / 10,000 players —
  both invariant layers at machine precision (~1e-8 kg), `dupReservations = 0`,
  `reservationMismatch = 0`, ledger keys unique, `genPerTick` exact.
- **Load 10 / 100:** PASS — tick p50 476 ms / 352 ms, p95 664 ms / 959 ms.
- **Load 1,000:** correctness PASS — p50 1.86 s, p95 3.34 s. (The previous
  session's "709 ms @ 1k" does NOT reproduce on this deployment; dev
  deployments are slow per-doc.)
- **Load 10,000 — performance target NOT MET:** 6/6 ticks succeeded with NO
  write-limit errors and NO mutation failures, but tick = **2.8–3.8 s**
  (p50 ≈ 3.4 s, p95/p99 ≈ 3.8 s) vs the < 1 s MVP benchmark. A no-op-write
  skip for unchanged robots (Sprint 2.6 continuation) moved p50 3.4 → 3.1 s
  (kept — fewer writes, less quota pressure) but the cost is dominated by
  Convex dev-deployment per-doc read/write overhead (~10k doc reads + ~800
  writes per tick). Consequence: cron drift at 10k (tick > 2 s cron interval,
  world advances at ~60 % real-time). Paths to < 1 s: prod (non-dev)
  deployment, or splitting the tick into parallel per-shard mutations.
- **Stability: PASS.** 6 consecutive 10k ticks: 2.8–3.8 s, skew ~1e-8 every
  tick, no drift, no quota spike, no failed mutation. Post-cleanup audit back
  at machine precision; `resetWorld` restores the pristine 50% baseline.
- **Tooling fixes during the run:** `cleanupLoad` now respects the 4,096-write
  budget (10k players × ledger rows would exceed it) and only removes the
  synthetic user when truly done; the live drivers pass args positionally
  (this CLI has no `--args`) and retry cleanup on the cron's
  `OptimisticConcurrencyControlFailure` (the world-doc patch races the 2 s
  cron — the mutation is atomic, so retry with backoff is safe).

### Sprint 2.5 — production consistency & clean world

1. **Batch Allocation production compliance** — the tick no longer assigns
   clusters first-come-first-served: idle auto robots are matched to unclaimed
   clusters once per tick via the SAME `batchAllocation` reference the harness
   tests (`engine.ts`): ascending level order (L1 floor access), battery
   feasibility, batch size 20, deterministic (level + id tie-break), no
   duplicate reservation. Tests prove the production result equals the
   reference on identical inputs.
2. **Clean World** — `bunx convex run harness:resetWorld` re-seeds World 0
   pristine (10,000 t capacity, 50% pollution, 10% collectable, generated 0,
   burned 0, legacy residual 0) and wipes world/cluster/event/zone state +
   player-held waste (accounts/balances/upgrades kept). All benchmarks run on
   this baseline. This also fixes the pre-2.5 seed write-back bug that leaked
   ~13.5 t of phantom pool mass (the "legacy drift" seen in Sprint 2.4).
3. **Two-layer invariant spec** — the old single-equation physical invariant
   is retired. Official accounting (verified live by `harness:invariantAudit`):
   Layer 1 `seed + generated == pollution + burned`; Layer 2 `hidden +
   collectable + clusters + cargo + storage + processing == pollution −
   generated`, with the explicit note that pool buckets never double-count the
   same mass. Collapse consistency: player-held waste is lost with the world
   (balances/upgrades carry over), so Layer 2 stays exact on the reset.


## Status (honest)

- **Real:** world engine (cron-driven every 2s), spatial robots, v0.4 TOX economy
  with reward ledger + Burn Zones, persistence, auth, frontend, two-layer
  invariant telemetry per tick (`world.invariantSkewKg`), live audit
  (`harness:invariantAudit`), Batch/Reservation production compliance, clean
  world baseline (`harness:resetWorld`), Sprint 2.6 concurrency-verified tick
  and sharded scaling (`ROBOTS_PER_TICK` + sharded burn), exactly-once burn
  slices (`advanceBurn` contract fix), and a complete headless test suite
  (55 tests) that passes.
- **Blocked (platform):** the dev deployment is DISABLED (usage limit exceeded
  during the previous Sprint 2.6 session) and still holds stranded `LOADTEST`
  players. Re-enable/raise the limit in the Convex dashboard, run
  `harness:cleanupLoad` (loop) to remove the stranded players, then re-run the
  live concurrency + 10k benchmark (`bun tests/liveConcurrency.ts`,
  `bun tests/liveBench.ts 10000 5 0.5 0.05`).
- **Mock:** SOL balance (off-chain ledger) used only for the base purchase. No
  wallet, no Solana transaction.
- **Not implemented:** real settlement, reward outbox for SOL payouts, protection
  systems (Base Lock / AFK / Shield / Emergency Launch), leaderboard pagination,
  live-DB load tests at 10k players (the 10k scale test runs the headless
  oracle sim, not the Convex DB path).

See `TOXIC_WORLD_ENGINEERING_HANDOFF_v0.1.md` for the full engineering handoff,
known risks, and the next-task list.
