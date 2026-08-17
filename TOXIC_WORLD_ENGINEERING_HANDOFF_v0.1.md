# TOXIC WORLD — ENGINEERING HANDOFF v0.1 (economy DESIGN FREEZE v0.4, engine SPRINT 2.5, tick SPRINT 2.7/2.8, recalibration SPRINT 2.9)

Verified against the repository on disk (Freebuff Web / Vly sandbox).
Everything below is grounded in actual files; anything not in the repo is
explicitly marked NOT PRESENT / NOT VERIFIED. Mock vs real is always labeled.

Verification evidence (latest run — Sprint 2.6 continuation):
- `bunx convex dev --once` → exit 0 (`Convex functions ready!`, dev deployment)
- `bunx tsc -b --noEmit` → exit 0
- `bun test tests/` → **55 pass / 0 fail** (179 assertions; economy + engine
  harness). NOTE: the test files referenced by earlier versions of this report
  were MISSING from disk; this continuation recreated them
  (`tests/economy.test.ts`, `tests/engineSim.ts`, `tests/engine.test.ts`,
  `tests/liveBench.ts`, `tests/liveConcurrency.ts`) — the 55-test suite above
  is the real, reproducible result of `bun test tests/`.
- Live clean-world audit: `bunx convex run harness:resetWorld` then
  `harness:invariantAudit` — Layer 1 (mass) = 0, Layer 2 (pool) = 0 at reset
  and at machine precision after real cron ticks (see §7 Sprint 2.5 note)
- Live engine check: `bunx convex run world:worldState` — cron fires every 2 s
  (pollution +0.8333 kg/tick, +25 clusters/tick), Burn Zone observed
  `active ×1.2` at random (x, y) with the event feed recording it

---

## v0.4 ECONOMY CHANGE (supersedes the v0.3 burn-reward sections below)

| Decision | Old (v0.3) | New (v0.4) | Code |
|---|---|---|---|
| Burn reward | SOL + TOX ($10/ton + 1 TOX/kg) | **TOX only** | `src/convex/economy.ts`, `world.ts` §6 |
| Normal burn rate | $10/ton reference | **500 TOX / ton** (`kg/1000 × 500`) | `TOX_PER_TON` |
| Burn Zone | — (new) | random shared zone, **×1.2 = 600 TOX / ton**, active 15–30 s, cooldown 45–90 s | `burnZones` table, `stepBurnZone` |
| Reward ledger | direct field credit, no idempotency | **`rewardLedger` table, key = `sessionId:sliceIndex`, exactly-once** | `rewardLedger`, `economy.rewardKey` |
| SOL balance | burn incremented `solBalance` | burn never touches SOL; SOL only for the **mock** base purchase | `world.ts` §6 (no SOL writes) |
| KPI | financial ROI (~24 h SOL payback) | **Progression ROI** (TOX/time; Cargo L2 ≈ 7.8 h at starter rate) | `CARGO_CUMULATIVE_TOX`, `hoursToReach` |
| Deprecated | — | `totalEarnedSol`, `WORLD.REWARD_USD_PER_TON`, leaderboard `earnedSol` kept but marked DEPRECATED | schema, gameParams, game.ts |

Everything else from Design Freeze v0.3 (spatial robot, Global Waste Pool,
Model C, Batch/Reservation, world capacity/pollution/collapse, upgrade costs)
is **unchanged** in v0.4 — see §13 for the v0.3 compliance matrix.

---

## SPRINT 2.5 — PRODUCTION CONSISTENCY & CLEAN WORLD (supersedes §13 rows below)

| Item | Change | Code | Evidence |
|---|---|---|---|
| Batch Allocation | Production tick now plans reservations via the SAME `batchAllocation` the harness tests (`engine.ts`): level-ordered floor access, battery feasibility, batch size 20, deterministic (level + id tie-break), no duplicate reservation | `world.ts` tick §2, `engine.ts` §6, `tests/engine.test.ts` §4b | tests prove prod result == reference; floor access verified under scarcity |
| Clean World | `harness:resetWorld` re-seeds pristine World 0 (10,000 t, 50%, 10% collectable, generated 0, burned 0, residual 0). **Fixes the pre-2.5 seed write-back bug** (seedWorld never wrote the post-spawn collectable balance back → ~13.5 t of phantom pool mass, the "legacy drift" reported in Sprint 2.4) | `world.ts seedWorld` + collapse branch, `harness.ts resetWorld` | live audit: massBalance 0, poolBalance 0 at reset and after 10 s of cron ticks |
| Invariant spec | Old single-equation physical invariant RETIRED. Official two-layer accounting: **Layer 1** `seed + generated == pollution + burned`; **Layer 2** `hidden + collectable + clusters + cargo + storage + processing == pollution − generated` (pool buckets are disjoint — never double-counted) | `engine.ts` §1, `harness:invariantAudit`, `DATABASE_SCHEMA.md` | live audit + all 64 tests |
| Collapse consistency | Player-held waste (cargo/storage/processing) is lost with the world so Layer 2 stays exact on reset; balances and upgrades carry over | `world.ts` collapse branch + `engineSim.ts` | post-collapse invariant tests |

---

## SPRINT 2.8 — TIME COMPRESSION & ECONOMY VALIDATION (5 s tick)

## TIME MODEL — TWO AXES (official; supersedes the old single-axis wording)

| Axis | Granularity | Mechanics | Anchors |
|---|---|---|---|
| REAL TIME | 1 real second | robot movement (m/s), battery drain/recharge, burner (kg/s) | `ROBOT.*`, `PROCESSING_KG_PER_S` |
| GAME TIME | 1 tick = 1 game minute | base generation, pollution economy, replenishment Model C, demand | `BASE_GEN_KG_H`, `REPLENISHMENT.*`, `DEMAND_REF_KG_H` |

`1 game-h = 60 ticks = 5 real-min`; **kg/real-h = 12 × kg/game-h**; real-h = game-h / 12.
REAL-anchored rates never change with tick length; GAME-anchored rates are
applied per tick via `GAME_MINUTES_PER_TICK/60` and are identical per tick at
any tick length — the 5 s tick (Sprint 2.7 B) preserves the per-game-hour
economy by construction.

Measured results (`bun test tests/economyValidation.test.ts`, 14 tests green):

| Quantity (starter) | GAME TIME | REAL TIME |
|---|---|---|
| Base generation | 50 kg/game-h | 600 kg/real-h |
| Burner capacity | 600 kg/game-h | 7,200 kg/real-h |
| Starter collection (measured emergent) | 174.4 kg/game-h | 2,092.6 kg/real-h |
| Starter TOX | 92.0 TOX/game-h | 1,103.4 TOX/real-h |
| 24-h TOX | 2,206.7 | 26,480.4 |
| Cargo L2 / L3 / L4 / L5 | 1.63 / 4.08 / 7.78 / 13.32 game-h | 0.14 / 0.34 / 0.65 / 1.11 real-h |

Key findings:
1. Per-game-hour economy preserved tick-for-tick under the 5 s tick (Model C
   formula, hidden-pool monotonicity, both invariants — verified every tick).
2. **Measured starter throughput ≈ 174 kg/game-h ≈ 4× the design reference
   (38.34 kg/h)** → upgrades ~4.8× faster in game-hours than the old targets
   (which were based on the 38.34 reference). The Model C demand reference
   (42 kg/game-h) is far below measured demand ⇒ ratio sits at the 5 % floor
   in practice ⇒ replenishment effectively floor-rate. Design decision needed:
   re-anchor the demand reference to measured throughput or keep 42 as a
   deliberate scarcity lever. NOT caused by the tick change (same behavior at
   2 s) — the reference was simply never calibrated against the spatial engine.
3. Burn Zone unchanged: avg interval ≈ 92 s, active ≈ 26.5 % of real time,
   starter encounter ≈ 34 % of burned TOX.
4. Pollution worst-case: 10K → collapse ≈ 10.3 game-h (0.86 real-h); 1K →
   ≈ 102.7 game-h (8.6 real-h). Upper bound — synthetic players don't
   auto-queue (their seeded queues burn once); live players burning steadily
   remove far more.
5. Storage (starter): fill ≈ 0.35 game-h, ~8.8 unloads/game-h, max backlog
   20 kg (burner clears 60 kg in 30 real-s).

## SPRINT 2.9 — STARTER ECONOMY & MODEL C RECALIBRATION (freeze v0.1)

Freeze doc: **`TOXIC_WORLD_STARTER_ECONOMY_RECALIBRATION_v0.1.md`** — the
four Sprint 2.9 values (STARTER_OBSERVED_THROUGHPUT, DEMAND_REFERENCE,
TOX_PER_TON, WORLD_COLLAPSE_TARGET) are frozen there. Code: `gameParams.ts`
(Decision 1 constant split) + `tests/economyValidation.test.ts` (27 tests).

| Decision | Result | Evidence |
|---|---|---|
| 1 — throughput reference | **SEPARATED.** `STARTER_OBSERVED_THROUGHPUT_KG_H = 174.4` (measured 174.38; informational only) is officially NOT the Model C demand reference. `DEMAND_REF_KG_H = 42` remains the deliberate scarcity lever ⇒ demand/gen ratio sits at the 5% replenishment floor (frozen behavior; re-anchor deferred to a balance sprint) | `gameParams.ts` comments + freeze doc §2 |
| 2 — 500 TOX/t | **KEPT.** Sensitivity 250/350/500/650 measured bucket-by-bucket (normal ×tpt, zone ×tpt×1.2; kg split derived from toxFromNormal/toxFromZone): L2 = 3.26/2.33/**1.63**/1.25 game-h, L5 = 26.65/19.03/**13.32**/10.25 game-h, daily TOX (game-day) = 1,103/1,545/**2,207**/2,869, full-tree sink ratio = 3.85/2.75/**1.92**/1.48 game-days. 500 row reproduces the 2.8 baseline to machine precision. Burn split: 174.38 kg/game-h = 126.82 normal + 47.56 zone ⇒ **31.0% of TOX from Burn Zones** | `economyValidation.test.ts` DECISION 2 test + console table |
| 3 — collapse tempo | **Real curve measured; WORLD_COLLAPSE_TARGET left OPEN** (no target forced in 2.9). 1K (diligent auto-queue): net NEGATIVE at every activity level ⇒ never collapses (2.8's 102.7 game-h was the no-queue upper bound; the lower bound is ∞). 5K: 50→90 ≈ 23.2, 90→100 ≈ 5.9 game-h (25–100% activity varies < 10%). 10K: 8.8 + 2.3 game-h ≈ **0.92 real-h total collapse**. Activity independence ⇒ **collection is cluster-limited** (spawn cap 25/tick, 500-cluster target), not activity-limited | `economyValidation.test.ts` DECISION 3 tests |
| 3b — new measured tradeoff | The Sprint 2.6 sharded robot loop (`ROBOTS_PER_TICK = 2500`) throttles per-player collection ~3.3× at 10K (~5.4 kg/game-h/player, shardCount 4) vs 5K (~18 kg/game-h/player, shardCount 2) — the write-budget fix now has a quantified throughput cost at high population. Flagged in freeze doc §4 finding 4 | collapse matrix collection column |

## SPRINT 2.7 — TICK ARCHITECTURE (A/B/C decision, measured on dev)

| Item | Result | Evidence |
|---|---|---|
| A — production benchmark | **BLOCKED at credentials**: no prod deployment exists; env authenticates with `CONVEX_DEPLOY_KEY`, which cannot create deployments (needs interactive `convex login` / dashboard). Runbook in NEXT IMMEDIATE TASK | `convex deployment create` error |
| B — tick frequency redesign | **IMPLEMENTED**: `WORLD.TICK_SECONDS 2 → 5` (1 game min/tick). Game-hour rates unchanged per tick (`GAME_MINUTES_PER_TICK`-anchored); real-second rates unchanged (battery/travel/burner kg/s); burner slice per tick 4 → 10 kg. Economy re-tested: 55 tests green | `gameParams.ts`, `tests/engine.test.ts` (expectations now derived from constants) |
| B — live 10k (dev, 5 s tick) | tick 1,779–3,644 ms (p50 ≈ 2.4 s, p95 ≈ 3.6 s); DB ops/tick ≈ 200 reads + 476–976 writes; invariants ~1e-10; skew 9.3e-10 | `harness:tickOnce` counters + `benchStatus` |
| B — cron drift | **ELIMINATED**: completions exactly 5.0 s apart (ticks 22→23→24→25→26); pre-B the 2 s cron backed up behind 3.3 s ticks (world ran ~60% real-time, lastTickAge 4.4–7.1 s) | `worldStateProbe` cadence sampling |
| B — economy deltas to re-review | compression 30× → 12× (game progress per real hour 2.5× slower — real-time progression identical because burn/generation scale together); per-game-hour burner throughput 240 → 600 kg/h (same 2 kg/s real) — storage pressure per game hour rises; flag for design sign-off | constants + tests |
| C — sharded world engine | **DEFERRED (not implemented)**: spatial region shards for robots/clusters remain the 50k+ scale path; B satisfies the MVP (10k tick fits its window) without the migration | decision report |
| Instrumentation | `harness:tickOnce` now returns `dbReadOps` / `dbWriteOps` (query/get = read op, insert/patch/delete = write op) for dev-vs-prod comparison | `harness.ts` |

## SPRINT 2.6 — LIVE-DB LOAD & CONCURRENCY TEST (results on the real deployment)

| Item | Result | Evidence |
|---|---|---|
| Concurrency — unguarded path | **PASS**: 5 concurrent `harness:tickOnce` — 5/5 advanced, 0 failed; generated delta = EXACT integer multiple of genPerTick (5 ours + 2 cron) ⇒ no lost update, no double apply | `tests/liveConcurrency.ts`, live run |
| Concurrency — guarded path | **PASS**: 3 concurrent `world:tick` — never >1 advance per 1.6 s guard window (fresh guard: 1; after expiry: 1 over 4.7 s vs legit max 3). Convex serializable isolation + automatic conflict retry makes the non-atomic guard SAFE — **no guard fix required** | `tests/liveConcurrency.ts` |
| Load 10 / 100 / 1,000 | **PASS live**: tick p50 <1 ms / 95 ms / 709 ms; both invariant layers ~1e-9; 0 duplicate reservations; ledger keys unique; genPerTick exact | `tests/liveBench.ts`, live runs |
| Load 10,000 — finding 1 | Tick exceeded Convex's **4,096 DB-op-per-mutation** limit (10,001 per-player patches). Fixed: **sharded robot simulation** (`WORLD.ROBOTS_PER_TICK = 2500` — round-robin shards; worlds ≤ 2,500 unchanged) | `world.ts` tick §2, `gameParams.ts`, `engineSim.ts` parity, 64 tests pass |
| Load 10,000 — finding 2 | Live re-run **BLOCKED by platform**: deployment disabled for exceeding the free-tier usage limit (cumulative session I/O). Re-enable/raise the limit in the Convex dashboard → `bun tests/liveBench.ts 10000 5` → cleanup | platform error, all calls failing |
| Load 10,000 — finding 3 (2.6 continuation) | The sharded-robot fix alone was NOT enough for the write budget: at 10k a tick also burns ~2,000 queues (2,000 patches + 2,000 ledger inserts) ⇒ ~6.5k writes > 4,096. Fixed with **sharded burn processing** — the burn loop now runs only for the tick's round-robin shard (worlds ≤ 2,500 unchanged), keeping a 10k tick ≈ 3.5k writes | `world.ts` §6, `gameParams.ts ROBOTS_PER_TICK`, `tests/engine.test.ts` §10 |
| Idempotency contract | `economy.advanceBurn` contradicted its own doc comment: on an already-rewarded slice it pinned `sliceIndex`, so one stale replay would lock a whole processing session out of TOX forever. Now always advances `sliceIndex` (duplicate burns kg with ZERO credit, next slice gets a fresh key) — covered by `tests/economy.test.ts` | `economy.ts`, test "duplicate slice burns WITHOUT credit but still advances the key" |
| LIVE RE-RUN (usage limit re-enabled) | Full sequence executed on the real deployment: cleanup stranded 10k → `resetWorld` → `liveConcurrency` → `liveBench` 10/100/1k/10k → `invariantAudit` → cleanup → `resetWorld`. **Concurrency PASS** (5/5 unthrottled exact-multiple; 3 guarded → 0 advances, no double tick). **Correctness PASS at every scale** (invariants ~1e-8, 0 dup reservations, ledger keys unique). **10k performance target NOT MET** (tick 2.8–3.8 s vs < 1 s; no failures/write-limit errors; see finding 4 below) | live runs, `bun tests/liveConcurrency.ts`, `bun tests/liveBench.ts` |
| 10k performance — finding 4 | Tick time is dominated by Convex dev-deployment per-doc read/write overhead (~10k doc reads + ~800 writes/tick): 6/6 ticks at 2.8–3.8 s (p50 3.4 s, p95/p99 3.8 s). The no-op-write skip for unchanged robots (this continuation) helped ~10 % (p50 3.4 → 3.1 s) and is kept. Cron drift observed at 10k (tick > 2 s cron interval ⇒ world runs at ~60 % real-time). Paths to < 1 s: prod (non-dev) deployment, or parallel per-shard tick mutations | `world.ts` stepRobot change + live A/B on the same 10k population |
| Cleanup hardening | `cleanupLoad` hit `OptimisticConcurrencyControlFailure` (the final world-doc patch races the 2 s cron) and would exceed the 4,096-write budget at 10k (500 players × ~10 ledger rows). Fixed: write-budgeted deletes + `done` flag + user deleted only when truly done; live drivers retry with backoff and pass args positionally (this CLI has no `--args`) | `harness.ts cleanupLoad`, `tests/liveBench.ts`, `tests/liveConcurrency.ts` |
| Stranded data | RESOLVED — all 10,000 `LOADTEST` players + synthetic user removed; world back to pristine World 0 (50%, skew 0) | live `cleanupLoad` loops + `resetWorld` |

New harness tools: `harness:seedLoad`, `harness:tickOnce` (unguarded, returns engine tickMs incl. DB ops), `harness:benchStatus`, `harness:cleanupLoad`, `harness:worldStateProbe`, `harness:concurrencyProbe` (one-shot tick-guard atomicity probe via nested `ctx.runMutation(api.world.tick)`), `tests/liveBench.ts`, `tests/liveConcurrency.ts`.


---

## 1. PROJECT STACK

| Item | Value | Evidence |
|---|---|---|
| Frontend framework | React 19 + Vite 7 + TypeScript | `package.json`, `src/main.tsx` |
| UI | Tailwind CSS v4 + shadcn/ui + Framer Motion + Lucide | `package.json`, `src/index.css` |
| Routing | React Router v7 (`react-router`) | `src/main.tsx` |
| Backend framework | Convex serverless functions (queries/mutations/cron) — NOT FastAPI | `src/convex/*.ts` |
| Runtime | Node (Vite/Convex CLI); package runner Bun | `package.json` |
| Package manager | Bun | `package.json` (`bun` scripts) |
| Database | Convex document DB (dev deployment) | `src/convex/schema.ts` |
| ORM / query layer | Convex client (`convex/react`: `useQuery`/`useMutation`) + generated `_generated` types | `src/hooks/use-auth.ts`, `src/pages/Game.tsx` |
| Authentication | Convex Auth (`@convex-dev/auth`): email OTP + anonymous; Freebuff federated JWT support | `src/convex/auth.ts`, `src/convex/auth.config.ts` |
| Realtime mechanism | Convex reactive query subscriptions — NO WebSocket layer in this repo | `src/pages/Game.tsx` (`useQuery`) |
| Blockchain SDK | NONE installed (`@solana/web3.js` etc. absent) | `package.json` |
| Solana library | NONE — **NOT IMPLEMENTED, MOCK ONLY** | `package.json` |
| Deployment platform | Freebuff Web (managed Vite preview + managed Convex dev); Convex **dev** deployment `https://jovial-chickadee-617.convex.cloud`; production deploy NOT configured | `bun convex dev --once` output |
| Environment variables | See `.env.example` / section 11 | — |
| Required secrets | Names only: `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, `CONVEX_SITE_URL`, `SITE_URL`, `JWKS`, `JWT_PRIVATE_KEY`, `VLY_CONVEX_AUTH_ISSUER`, `VITE_VLY_APP_ID`, `VITE_VLY_MONITORING_URL`, `VLY_APP_NAME`, `VLY_INTEGRATION_KEY`, `VLY_INTEGRATION_BASE_URL`. **Planned (unused):** `COINBASE_COMMERCE_API_KEY`, `COINBASE_COMMERCE_WEBHOOK_SECRET`, `SOLANA_TREASURY_PRIVATE_KEY` | `.env.example` (if platform blocks the filename: `docs/ENV_VARIABLES.md`) |

---

## 2. DIRECTORY / FILE INVENTORY

### Frontend
| PATH | PURPOSE | ROLE | STATUS | DEPENDS ON | USED BY |
|---|---|---|---|---|---|
| `src/main.tsx` | Router + providers (Convex, auth, error boundaries) | App bootstrap | ACTIVE | react, convex | index.html |
| `src/pages/Landing.tsx` | Public landing w/ live world telemetry | Page | ACTIVE | `api.world.worldState` | route `/` |
| `src/pages/Game.tsx` | Protected game page (map + panels + actions) | Page | ACTIVE | all `api.game.*`, `api.world.*` | route `/game` |
| `src/pages/Auth.tsx` | Email OTP + guest sign-in | Page | ACTIVE (template-styled, functional) | `useAuth` | route `/auth` |
| `src/pages/NotFound.tsx` | 404 | Page | ACTIVE | — | route `*` |
| `src/pages/Dashboard.tsx` | Template starter dashboard | **UNUSED leftover** (not routed) | STALE | — | none |
| `src/components/game/WorldMap.tsx` | Map: clusters, base, animated robot | Component | ACTIVE | `api.world.clusters`, gameParams | Game |
| `src/components/game/Panels.tsx` | Base/Robot/Upgrades/World tabs | Component | ACTIVE | gameParams, queries | Game |
| `src/components/game/format.ts` | Display formatters | Utility | ACTIVE | — | Game, Panels, WorldMap |
| `src/components/RequireAuth.tsx` | Route guard → `/auth?returnTo=` | Component | ACTIVE | `useAuth` | main.tsx |
| `src/components/LogoDropdown.tsx` | Template logo menu | **UNUSED leftover** | STALE | — | none |
| `src/components/ui/*` | shadcn/ui registry | UI primitives | ACTIVE | — | pages/components |
| `src/hooks/use-auth.ts` | Auth hook (user, signIn/out) | Hook | ACTIVE | `@convex-dev/auth/react` | everywhere |
| `src/hooks/use-mobile.ts` | Responsive helper | Utility | ACTIVE (template) | — | ui/sidebar |
| `src/lib/utils.ts` | `cn()` | Utility | ACTIVE | clsx, tailwind-merge | ui/* |
| `src/lib/vly-integrations.ts` | VLY gateway client | Utility | ACTIVE (template) | `@vly-ai/integrations` | unused by game code |
| `src/index.css` | TOXIC WORLD theme (CSS vars, fonts, utilities) | Styling | ACTIVE | tailwind | global |
| `src/instrumentation.tsx` | Runtime error reporter | **UNUSED leftover** (not imported by main.tsx) | STALE | — | none |
| `vly-toolbar-readonly.tsx` | Freebuff platform toolbar | Platform shell | ACTIVE (read-only) | framer-motion, snapdom | main.tsx |
| `public/logo.svg`, `public/manifest.webmanifest`, `src/assets/logo.svg` | Static assets | Assets | ACTIVE (template) | — | shell |

### Backend (Convex)
| PATH | PURPOSE | ROLE | STATUS | DEPENDS ON | USED BY |
|---|---|---|---|---|---|
| `src/convex/schema.ts` | Tables: users, worlds, wasteClusters, players, worldEvents, burnZones, rewardLedger | Schema | ACTIVE | convex/server | codegen |
| `src/convex/gameParams.ts` | Economy constants (Design Freeze v0.4) shared FE/BE | Config | ACTIVE | — | world.ts, game.ts, economy.ts, frontend |
| `src/convex/economy.ts` | Pure v0.4 reward formulas + idempotency keys (unit-tested) | Economy | ACTIVE | gameParams | world.ts, tests |
| `src/convex/world.ts` | World engine: `tick` (cron), `seedWorld`, `stepRobot`, `stepBurnZone`, queries | Engine | ACTIVE | gameParams, economy, users | crons.ts, frontend |
| `src/convex/game.ts` | Player mutations + queries | Domain API | ACTIVE | gameParams, users | frontend |
| `src/convex/crons.ts` | `toxic-world-tick` every 2 s (**must be named `crons.ts`** — Convex only auto-registers that filename; this was a bug in v0.1, fixed) | Scheduler | ACTIVE | world.tick | deployment |
| `src/convex/users.ts` | `currentUser` helper | Auth helper | ACTIVE | auth | game.ts |
| `src/convex/auth.ts` | Convex Auth providers | Auth | ACTIVE (read-only) | @convex-dev/auth | http.ts |
| `src/convex/auth.config.ts` | Auth config (OIDC/JWT) | Auth | ACTIVE (read-only) | — | deployment |
| `src/convex/auth/emailOtp.ts` | Email OTP provider (freebuff gateway) | Auth | ACTIVE (read-only) | axios | auth.ts |
| `src/convex/http.ts` | Auth HTTP routes | Transport | ACTIVE | auth | deployment |
| `src/convex/_generated/*` | Codegen output (api/server/dataModel) | Generated | EXCLUDED from archive | — | all |

### Config / docs
`package.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`,
`vite.config.ts`, `index.html`, `components.json`, `.gitignore`, `integrations.md`.

### Tests
`tests/economy.test.ts` — Bun test runner, 26 tests / 45 assertions, ALL PASS
(`bun test tests/economy.test.ts`). Covers: 500 TOX/ton, 600 TOX/ton zone,
fractional rewards, exactly-once key scheme (normal vs zone share one key),
no-SOL-write path, 1:1 pollution reduction for both kinds, starter 24 h ≈ 460
TOX/day, and cargo progression times (7.8 / 19.6 / 37.3 / 63.9 h).

### Solana
**NONE.** No packages, no files. (Design-doc Solana Sprint 1 artifacts are not in this repo.)

---

## 3. BACKEND STATUS (real working features)

Legend: STATUS = implemented in code; REAL/MOCK = simulation vs external; TESTED = evidence.

| FEATURE | IMPLEMENTATION FILE | FUNCTION | STATUS | REAL/MOCK | TESTED? |
|---|---|---|---|---|---|
| World (state doc) | `src/convex/world.ts` | `tick`, `seedWorld`; table `worlds` | DONE | REAL (simulated server state) | Compile+deploy only; no runtime test harness |
| Global Waste Pool | `world.ts` | `tick` (§1: `pollutionKg += genKgH × dt`) | DONE | REAL | as above |
| Base generation | `world.ts` | `tick`: `active.length × 50 kg/h` | DONE | REAL | as above |
| Collectable pool | `world.ts` | `tick` (§3–4: `collectableKg` + cluster spawn) | DONE | REAL | as above |
| Dynamic Replenishment Model C | `world.ts` | `tick` (§3: `replFracH = clip(0.05×ratio, 0.05, 0.09)`) | DONE | REAL | as above |
| Batch allocation | `game.ts` / `world.ts` | `commandRobot` (reserve) + `tick` (reservation cleanup) | DONE (simplified) | REAL | as above |
| Waste cluster | `world.ts` | `spawnClusters` (150–900 kg, target 500) | DONE | REAL | as above |
| Robot spatial movement | `world.ts` | `stepRobot` (interpolation, states) | DONE | REAL | as above |
| Battery | `world.ts` | `stepRobot` (drain/recharge) | DONE | REAL | as above |
| Cargo | `world.ts` | `stepRobot` (cargoKg, capacity) | DONE | REAL | as above |
| Storage | `game.ts`/`world.ts` | `players.storageKg`, unload logic | DONE | REAL | as above |
| Processing | `game.ts`/`world.ts` | `queueProcessing` + `processing.queuedKg` | DONE | REAL | as above |
| Burn | `world.ts` | `tick` (§5: `2 kg/s`) | DONE | REAL | as above |
| Pollution | `world.ts` | `tick` (§1, §6) | DONE | REAL | as above |
| Critical state | `world.ts` | `tick` (§6: ≥90%) | DONE | REAL | as above |
| Collapse | `world.ts` | `tick` (§6: ≥100%) | DONE | REAL | as above |
| World reset | `world.ts` | `tick` (§6: 22.5%, worldId+1) | DONE | REAL | as above |
| Player persistence | `schema.ts` / `game.ts` | `players` table | DONE | REAL (Convex DB) | as above |
| TOX reward ledger | `world.ts` / `economy.ts` / schema | `rewardLedger` table + `toxFromNormal`/`toxFromZone` counters — exactly-once via `sessionId:sliceIndex` | DONE | REAL (in-database ledger; no chain) | Unit tests + live ticks |
| Burn Zone (v0.4) | `world.ts` `stepBurnZone` / `burnZones` table | random location + spawn/expire schedule, server-side ×1.2 | DONE | REAL (server-driven) | **LIVE VERIFIED** (active zone observed at (394, 137)) |
| SOL ledger | `game.ts` | `solBalance` — base purchase only, burn never writes it | DONE | **MOCK (off-chain)** | — |
| Base purchase | `game.ts` | `buyBase` (0.1 SOL, deducts mock balance) | DONE | **MOCK (no tx)** | as above |

Runtime behavior of the engine is **NOT VERIFIED** beyond compile/deploy: there is
no test harness executing ticks and asserting invariants in this repo.

---

## 4. FRONTEND STATUS

| FEATURE | FILE | ROUTE | DATA SOURCE | REAL API / MOCK | STATUS | TESTED? |
|---|---|---|---|---|---|---|
| Landing page | `src/pages/Landing.tsx` | `/` | `api.world.worldState` | REAL (live) | DONE | typecheck only |
| Wallet / auth UI | `src/pages/Auth.tsx` | `/auth` | Convex Auth | REAL | DONE (template) | typecheck only |
| `/game` | `src/pages/Game.tsx` | `/game` (RequireAuth) | all `api.*` | REAL | DONE | typecheck only |
| World status | `Game.tsx` header / `Panels.tsx` World tab | /game | `worldState` | REAL | DONE | — |
| Pollution gauge | `Game.tsx`, `Panels.tsx`, Landing hero | /, /game | `worldState` | REAL | DONE | — |
| Global waste | `Panels.tsx` World tab | /game | `worldState` | REAL | DONE | — |
| Collectable pool | `Panels.tsx` World tab | /game | `worldState` | REAL | DONE | — |
| Map | `WorldMap.tsx` | /game | `api.world.clusters` | REAL | DONE | — |
| Waste clusters | `WorldMap.tsx` | /game | `api.world.clusters` | REAL | DONE | — |
| Robot (state/icon) | `WorldMap.tsx`, `Panels.tsx` Robot tab | /game | `api.game.me` | REAL | DONE | — |
| Robot movement | `WorldMap.tsx` (motion lerp on server position) | /game | `api.game.me` | REAL | DONE | — |
| Base | `WorldMap.tsx` + buy overlay in `Game.tsx` | /game | `api.game.me` | REAL | DONE | — |
| Storage | `Panels.tsx` Base tab | /game | `api.game.me` | REAL | DONE | — |
| Processing | `Panels.tsx` Base tab | /game | `api.game.me`, `queueProcessing` | REAL | DONE | — |
| Upgrades | `Panels.tsx` Upgrades tab | /game | `gameParams` + `api.game.upgrade` | REAL | DONE | — |
| Protection systems (Lock/AFK/Shield/Emergency) | — | — | — | — | **NOT IMPLEMENTED** | — |
| Event feed | `Panels.tsx` World tab | /game | `api.world.events` (reactive; **not WebSocket**) | REAL | DONE | — |
| Critical/collapse UI | `Game.tsx` banner + overlay | /game | `worldState.status` | REAL | DONE | — |
| Leaderboard | `Panels.tsx` World tab | /game | `api.game.leaderboard` | REAL | DONE | — |

---

## 5. SOLANA STATUS — **NOT IMPLEMENTED — MOCK ONLY**

| FEATURE | FILE | FUNCTION | ON-CHAIN/OFF-CHAIN | REAL TRANSACTION? | TESTED? | LIMITATION |
|---|---|---|---|---|---|---|
| Wallet connection | — | — | — | No | No | No wallet SDK installed |
| Wallet address persistence | — | — | — | No | No | No wallet field in schema |
| 0.1 SOL base purchase | `game.ts` | `buyBase` | OFF-CHAIN | No | No | Deducts `solBalance` number only |
| Solana transaction creation | — | — | — | No | No | — |
| Transaction confirmation | — | — | — | No | No | — |
| Server-side verification | — | — | — | No | No | — |
| TOX purchase | — | — | — | No | No | TOX is an in-game number, no token |
| TOX token | — | — | — | No | No | No SPL token program |
| Treasury | — | — | — | No | No | — |
| Reward outbox | — | — | — | No | No | Rewards credited directly in `tick` |
| SOL reward settlement | — | — | — | No | No | **REMOVED in v0.4** — burn never pays SOL; rewards are TOX ledger entries only |
| Withdrawal | — | — | — | No | No | — |
| Retry | — | — | — | No | No | — |
| Idempotency | — | — | — | No | No | No idempotency keys |
| Duplicate reward protection | — | — | — | No | No | Only the tick rate-limit guard exists |

**NOT IMPLEMENTED — MOCK ONLY.** No wallet, no Solana library, no transactions.
The design-doc "Solana Sprint 1" mock rail files are not present in this repo;
the equivalent here is the in-database ledger.

---

## 6. DATABASE / DATA MODEL

See `DATABASE_SCHEMA.md` (deliverable) and `src/convex/schema.ts`.

| Model | Table | Persistent? | Notes |
|---|---|---|---|
| Player | `players` | YES | includes embedded robot, processing, levels, ledgers |
| Base | (embedded) | YES | `hasBase`, `baseX/baseY` on players |
| Robot | (embedded) | YES | `players.robot` object |
| World | `worlds` | YES | single doc |
| GlobalWastePool | `worlds` fields | YES | `pollutionKg`/`collectableKg`/`hiddenKg` |
| WasteCluster | `wasteClusters` | YES | spatial + reservation |
| ProcessingJob | (embedded) | YES | `players.processing` |
| Transaction | — | **NOT PRESENT** | |
| Upgrade | (embedded) | YES | `players.levels` |
| Protection | — | **NOT PRESENT** | |
| Reward Outbox | — | **NOT PRESENT** | **critical gap for real settlement** |

---

## 7. WORLD ENGINE — formulas exactly as coded (`src/convex/world.ts`, `gameParams.ts`)

Constants (v0.4): `CAPACITY_KG = 10,000,000`, `TICK_GAME_H = 1/60`,
`BASE_GEN_KG_H = 50`, `DEMAND_REF_KG_H = 42`, `TOX_PER_TON = 500`,
`BURN_ZONE_MULTIPLIER = 1.2`, `PROCESSING_KG_PER_S = 2`,
`CLUSTER_MIN/MAX = 150/900`, `ACTIVE_CLUSTER_TARGET = 500`,
`CRITICAL_FRAC = 0.9`. (`WORLD.TOX_PER_KG = 1` and `WORLD.REWARD_USD_PER_TON`
remain only as DEPRECATED legacy aliases.)

- **Generation:** `genKgH = activeBases × 50`; `pollutionKg = min(cap, pollutionKg + genKgH × 1/60)` per tick.
- **Demand (for Model C):** `demandKgH = Σ (robots in to_cluster|collecting|to_base) × 42` — a reference constant, **not** measured throughput (deviation, see §13).
- **Model C replenishment (per tick, scaled from per-hour):**
  `ratio = demandKgH/genKgH` (0 if gen=0);
  `replFracH = min(0.09, max(0.05, 0.05 × ratio))`;
  `unlockKg = min(hiddenKg, hiddenKg × replFracH × 1/60)`;
  `collectableKg += unlockKg`; `hiddenKg -= unlockKg`.
  → **Identical to the freeze formula**, recomputed **every tick (2 s real)**.
- **Batch allocation (Sprint 2.5):** the auto-target path no longer grabs
  clusters first-come-first-served. Every tick, idle auto robots with cargo room
  are matched to unclaimed clusters via `engine.ts batchAllocation` — robots
  sorted by ascending level (tie-break id), batches of `WORLD.BATCH_SIZE`,
  each robot takes its nearest affordable unclaimed cluster. Guarantees
  scarcity behavior, L1 floor access, no duplicate reservation, deterministic
  result. `commandRobot` (manual) still reserves directly; the tick's cleanup
  pass releases stale reservations.
- **Cluster spawn:** while `active < 500 && collectable ≥ 150 && spawned < 25`:
  `size = min(150 + rand×750, collectable)`; `collectable -= size`.
- **Burn (v0.4, exactly-once):** `burn = min(queuedKg, 2 × 2s)` per slice;
  `slice = { key: sessionId:sliceIndex, kg: burn, tox: kg/1000 × 500 (×1.2 if
  burn zone active), kind }`; if `rewardLedger` already has `key` → burn with
  ZERO credit (duplicate-tick safe); else credit `toxBalance` +
  `toxFromNormal`/`toxFromZone` + insert ledger row + reduce `pollutionKg` by
  `burn` (identical for both kinds). `totalBurnedKg/burnedKg += burn` in both
  cases. `solBalance` is NEVER written by burn.
- **Collapse:** `pollutionKg ≥ 10,000,000` → worldId+1, pollution = 22.5% of cap,
  collectable = 10% of that, status safe, all players migrated, clusters reseeded.
- Freeze checks: capacity 10,000 t ✓; World 0 start 50% ✓; World 1+ 22.5% ✓;
  initial collectable 10% ✓; critical 90% ✓; collapse 100% ✓.

---

## 8. ROBOT SPATIAL ENGINE (`stepRobot` in `world.ts`, `ROBOT` in `gameParams.ts`)

- **Speed:** 6 m/s (map units = meters).
- **Battery:** drain 0.6/s moving, 0.25/s collecting; recharge rate by level
  (L1 5/s … L5 26/s); divert home when battery ≤ return-cost + 5 margin.
- **Cargo:** capacity by level (L1 20 … L5 110 kg); collect = `min(space, cluster.kg)`
  after 4 s scoop; cluster deleted at ≤ 0 kg.
- **Target selection:** auto mode picks nearest unreserved cluster requiring
  `batteryForTrip(dist)`; manual mode via `commandRobot`.
- **Movement:** linear interpolation `from→dest` by `(now-departAt)/(arriveAt-departAt)`.
- **Return/unload:** `to_base` → 2 s unload → `storage += min(cargo, storageCap-storage)`;
  overflow stays in cargo (storage-pressure mechanic). Recharge when battery < 30%.
- **Throughput:** **emergent, not an input.** There is no `throughput_kg_h` input;
  the only 42 kg/h usage is the replenishment demand reference (see §7).
  Confirmed by code: throughput = f(position, speed, battery, cargo, distance,
  pool allocation) as the design intended.

---

## 9. ECONOMIC STATE (values from `src/convex/gameParams.ts`)

| VALUE | VALUE | SOURCE FILE | SOURCE FUNCTION | FREEZE / PLACEHOLDER / MOCK |
|---|---|---|---|---|
| Base price | 0.1 SOL | gameParams | `WORLD.BASE_PRICE_SOL` | FREEZE |
| Normal burn reward | **500 TOX / ton** (`kg/1000 × 500`) | economy.ts / gameParams | `TOX_PER_TON` | **FREEZE v0.4** |
| Burn Zone reward | **600 TOX / ton** (`×1.2`) | economy.ts / world.ts | `BURN_ZONE_MULTIPLIER` | **FREEZE v0.4** |
| SOL burn reward | **REMOVED (v0.4)** — burn never pays SOL | — | — | REMOVED; `totalEarnedSol`/`REWARD_USD_PER_TON` kept DEPRECATED |
| Settlement fee | n/a — no SOL settlement path remains | — | — | — |
| Cargo costs | 150/225/340/510 | gameParams | `UPGRADES.cargo.costs` | FREEZE |
| Recharge costs | 20/30/45/65 | gameParams | `UPGRADES.recharge.costs` | FREEZE |
| Storage costs | 200/320/500/760 | gameParams | `UPGRADES.storage.costs` | PLACEHOLDER (freeze left open → P1) |
| Battery costs | 120/190/300/470 | gameParams | `UPGRADES.battery.costs` | PLACEHOLDER (freeze left open → P1) |
| Base Lock | — | — | — | NOT IMPLEMENTED |
| AFK Protection | — | — | — | NOT IMPLEMENTED |
| Toxic Shield | — | — | — | NOT IMPLEMENTED |
| Emergency Launch | — | — | — | NOT IMPLEMENTED |

---

## 10. TESTS

| TEST | FILE | COMMAND | VALIDATES | PASS/FAIL | LAST VERIFIED |
|---|---|---|---|---|---|
| v0.4 reward formulas (26 tests) | `tests/economy.test.ts` | `bun test tests/economy.test.ts` | 500/600 TOX per ton, fractions, idempotency keys + `advanceBurn` duplicate-slice contract, no-SOL path, pollution 1:1, starter 460 TOX/day, cargo progression times | **26 PASS / 0 FAIL** (45 assertions) | Sprint 2.6 continuation |
| Engine harness (29 tests) | `tests/engine.test.ts` + `tests/engineSim.ts` | `bun test tests/engine.test.ts` | two-layer invariant every tick, pollution %, Model C, Batch/Reservation (floor access, no dup, determinism, prod==reference), burn reward normal/zone, idempotency, collapse+reset, critical recovery, active/inactive scaling, scale 10→10k | **29 PASS / 0 FAIL** (134 assertions) | Sprint 2.6 continuation |
| Convex codegen + deploy | — | `bunx convex dev --once` | functions compile & deploy to dev | **PASS** (exit 0) | this turn |
| Whole-project typecheck | — | `bunx tsc -b --noEmit` | TS across frontend + backend | **PASS** (exit 0) | this turn |
| Live engine smoke | — | `bunx convex run world:worldState` ×2 (12 s apart) | cron fires every 2 s: pollution +5.83 kg, clusters +175 | **PASS** (observed deltas) | this turn |
| Burn Zone lifecycle (live) | — | `bunx convex run world:worldState` + `world:events` | zone spawned ACTIVE ×1.2 at (394, 137), event recorded | **PASS** (observed) | this turn |

**NOT TESTED (no harness):** full player burn → ledger path end-to-end (needs an
authenticated player with storage; CLI `convex run` cannot sign in), multiplayer
concurrency, load (10k players), reservation races.

---

## 11. DEPLOYMENT

| Item | Command / Value |
|---|---|
| Install | `bun install` |
| Dev server | Platform-managed (Freebuff Web). Do NOT run `bun run dev` manually. |
| Convex codegen+push | `bun convex dev --once` |
| Typecheck | `bun tsc -b --noEmit` |
| Production build | `bun run build` (tsc -b && vite build) |
| Production deploy | **NOT CONFIGURED.** Currently a Convex *dev* deployment (`freebuff:e534bc6b…:dev`, `https://jovial-chickadee-617.convex.cloud`). Production would use `bunx convex deploy` + prod env vars. |

Env var names: see §1 and `.env.example`. Real values are never committed.

---

## 12. KNOWN BUGS / RISKS (from code review)

| SEVERITY | FILE | DESCRIPTION | REPRODUCTION | CURRENT WORKAROUND |
|---|---|---|---|---|
| MEDIUM | `world.ts` `tick` | No atomic CAS on `lastTick`: two concurrent ticks can both pass the guard → double generation/burn in one window | Fire many concurrent `tick` calls at once | Cron is effectively the single writer; guard reduces frequency; exploit only affects simulated balances |
| MEDIUM | `world.ts` §5 | No reward idempotency / outbox: burn credits ledger directly; a duplicated tick double-credits | See above | None — **must fix before real SOL** |
| MEDIUM | `world.ts` `stepRobot` auto-target | Nearest-cluster scan is O(players × clusters) per tick (500 clusters; 10k players → ~5M dist calcs/tick) | Scale test | None — needs spatial bucketing |
| LOW | `world.ts` reservation cleanup | Cleanup reads pre-tick robot states; a diverted robot's cluster stays reserved up to one tick (~1.6 s) | Divert a robot mid-run and watch the cluster | Next tick releases it |
| LOW | `world.ts` unload | Storage-full leaves robot idle with full cargo; no in-map warning (panel bar only) | Fill storage, keep collecting | Manual processing; UI shows bars |
| LOW | `world.ts` `tick` public | Clients may invoke `tick` (rate-limited to 1 per ~1.6 s) | Call it repeatedly | Guard; cannot accelerate world |
| LOW | `game.ts` `ensurePlayer` | Rapid double-invoke could theoretically race insert; mitigated by `by_user` first-check | — | Low risk; mutation serialization |
| LOW | `world.ts` events | Per-depletion events can spam; feed capped at 60 | Active map | Capped in `addEvent` |
| INFO | repo | `Dashboard.tsx`, `LogoDropdown.tsx`, `instrumentation.tsx` unused leftovers; `dist/` from an old build | — | Not routed/imported |
| INFO | security | All mutations validate server-side (price, TOX, state, reservation); world is server-authoritative | — | Acceptable for MVP |

---

## 13. DESIGN FREEZE v0.3 COMPLIANCE

| RULE | CODE LOCATION | COMPLIANT? | EVIDENCE / DEVIATION |
|---|---|---|---|
| World Capacity = 10,000 t | `gameParams.ts` `WORLD.CAPACITY_KG` | ✅ | 10,000,000 kg |
| World 0 = 50% | `gameParams.ts` `INITIAL_POLLUTION_FRAC` + `seedWorld` | ✅ | 0.5 |
| World 1+ = 22.5% | `gameParams.ts` `RESET_POLLUTION_FRAC` + `tick` §6 | ✅ | 0.225 |
| Initial collectable = 10% | `INITIAL_COLLECTABLE_FRAC` | ✅ | 0.1 |
| Dynamic Replenishment Model C | `world.ts` `tick` §3 | ✅ | formula identical |
| Replenishment clip 5%–9% | `REPLENISHMENT` + `tick` §3 | ✅ | min/max applied |
| Periodic recalculation | `cron.ts` + `tick` | ✅ with note | every 2 s real (= 1 game min, 30× compression) — freeze didn't specify real-time cadence; **DEVIATION (documented choice)** |
| Batch Allocation | `world.ts` tick §2 via `engine.ts` `batchAllocation` | ✅ DONE (Sprint 2.5) | level-ordered floor access, battery-feasible, deterministic, no duplicate reservation; prod == reference tested |
| Cargo costs 150/225/340/510 | `UPGRADES.cargo.costs` | ✅ | |
| Recharge costs 20/30/45/65 | `UPGRADES.recharge.costs` | ✅ | |
| Storage/Battery remain P1 | `UPGRADES.storage/battery.costs` | ⚠️ DEVIATION | freeze left open; filled with MVP placeholders (200/320/500/760, 120/190/300/470), flagged P1 |
| Critical = 90% | `CRITICAL_FRAC`, `tick` §6 | ✅ | |
| Collapse = 100% | `tick` §6 | ✅ | |
| No collapse countdown | `tick` §6 | ✅ | immediate reset |
| Single waste type | schema (`wasteClusters.kg` only) | ✅ | no waste-type field |
| Global waste pool | `worlds` fields + `tick` §1–4 | ✅ | |
| Two-layer waste invariant | `engine.ts` §1 + `harness:invariantAudit` | ✅ (Sprint 2.5) | Layer 1 mass + Layer 2 pool both ~0 live; old physical invariant retired |
| Robot spatial model | `world.ts` `stepRobot` | ✅ | position/speed/battery/cargo/distance |
| Demand from real throughput | `tick` §2 | ⚠️ DEVIATION | uses fixed 42 kg/h reference, not measured throughput |
| REST API + WebSocket | — | ❌ DEVIATION | Convex functions replace FastAPI/WS (not present in repo) |
| Separate domain models (Base/Robot/Job/Outbox) | `schema.ts` | ⚠️ DEVIATION | embedded in `players` doc; no outbox |

---

## 14. CURRENT MVP STATUS

| Category | Status |
|---|---|
| Design | DONE (per source doc; doc not in repo) |
| Simulation | NOT IN REPO (Python sim from doc was not transferred; Convex engine is the production stand-in) |
| Backend Engine | DONE (world.ts + crons.ts; Sprint 2.5: batch compliance, two-layer invariant, clean world) |
| Backend API | PARTIAL (Convex functions only; no REST/WebSocket layer) |
| Persistence | DONE (Convex DB, dev deployment) |
| Frontend | DONE (landing + game) |
| Auth | DONE (email OTP + anonymous) |
| Solana | NOT IMPLEMENTED — MOCK ONLY |
| Economy | DONE for v0.4 (TOX-only rewards, Burn Zones, ledgered; storage/battery costs remain P1 placeholders) |
| Reward Settlement | PARTIAL (TOX: real in-database ledger, exactly-once; SOL: none by design — no chain, no outbox) |
| Multiplayer | PARTIAL (shared world state; NOT load-tested, not verified with concurrent clients) |
| Production Deployment | NOT CONFIGURED (dev deployment only) |

---

## 15. EXACT NEXT STEPS (priority order)

| # | TASK | ROLE | DEPENDENCY | OUTPUT | ACCEPTANCE CRITERIA |
|---|---|---|---|---|---|
| 1 | Storage/Battery P1 rebalance | Economy | — | `gameParams.ts` update | Playtest data; storage pressure + progression ROI measured |
| 2 | Protection systems (Lock/AFK/Shield/Emergency) | Backend | — | schema + tick logic + UI | Each system has test + UI state |
| 3 | Concurrency hardening of `tick` (atomic guard) | Backend | — | atomic CAS or serialized tick | Double-advance impossible under concurrent calls |
| 4 | Real Solana entry rail (0.1 SOL base purchase) | Backend/Frontend | — | Coinbase Commerce or wallet SDK; server-side verification | Purchase verified on devnet; base granted only on confirmation; burn still pays TOX only |
| 5 | Performance: spatial bucketing for nearest-cluster | Backend | — | indexed/spatial lookup | 10k-player tick < 2 s |
| 6 | Live-DB load test (10/100/1k/10k) on the clean world | QA | #5 | seeded load script against Convex dev | Per-tick timing + invariant skew recorded on the clean baseline |
| 7 | Multiplayer QA (concurrent clients) | QA | #6 | session concurrency test | No double reservations; leaderboard consistent |
| 8 | Production deployment | DevOps | — | `bunx convex deploy` + prod envs | Landing + game on prod URL; cron firing |

---

## 16. FILE PACKAGE

| Deliverable | In repo? | Path |
|---|---|---|
| Source archive | TO CREATE | `TOXIC_WORLD_SOURCE.zip` (created this handoff; excludes node_modules/dist/.git/_generated) |
| Package manifest | ✅ | `package.json` |
| Database schema | ✅ | `src/convex/schema.ts` + `DATABASE_SCHEMA.md` |
| Env template | ⚠️ | `.env.example` (blocked by platform guard → fallback `docs/ENV_VARIABLES.md` if so) |
| API specification | ✅ | `API_SPEC.md` |
| README (local setup) | ✅ | `README.md` (rewritten for TOXIC WORLD) |
| Test commands | ✅ | documented in README + §10 (no test files exist) |
| Deployment config | ❌ NOT PRESENT — MUST CREATE | prod Convex deployment + env config |

---

## FINAL TABLE

| Area | Status | Real/Mock | Evidence | Next Owner | Next Task |
|---|---|---|---|---|---|
| World engine | DONE | REAL (server sim, cron-driven) | `src/convex/world.ts` + `crons.ts` + `engine.ts` | Backend | #3 atomic tick guard |
| Engine consistency (Sprint 2.5) | DONE | REAL | `batchAllocation` prod compliance, two-layer invariant, clean world (`harness:resetWorld`) | Backend | #6 live-DB load test |
| Economy (v0.4) | DONE | REAL (in-database ledger) | `economy.ts`, `rewardLedger`, `burnZones` | Economy | #3 P1 balance |
| Backend API | PARTIAL | REAL | `game.ts`, `world.ts` | Backend | — |
| Persistence | DONE | REAL | `schema.ts` | — | — |
| Frontend | DONE | REAL | `pages/`, `components/game/` | Frontend | — |
| Auth | DONE | REAL | `convex/auth*.ts` | — | — |
| Reward settlement | PARTIAL (TOX ledgered exactly-once; SOL none by design) | REAL (ledger) | `rewardLedger` | Backend | #1 P1 rebalance |
| Solana | NOT IMPLEMENTED | MOCK | none (no packages) | Blockchain | #6 entry rail |
| Multiplayer | PARTIAL | REAL | shared world state | QA | #8 load test |
| Production deploy | NOT CONFIGURED | — | dev deployment only | DevOps | #9 deploy |

---

## CURRENT PROJECT STATE
A playable single-world MVP on Convex + React with a **v0.4 TOX-only reward
economy**: server-authoritative spatial robots, global waste pool with Model C
replenishment, burn → TOX (500/ton, ×1.2 in random server-driven Burn Zones)
credited exactly-once through a `rewardLedger` table, upgrades, collapse/reset,
auth, and a themed landing + game UI. The world tick cron fires every 2 s
(`crons.ts`); SOL exists only as a mock entry balance for the base purchase. No
blockchain code exists. **Sprint 2.5** made the engine consistent with the
freeze: the tick plans robot reservations through the same `batchAllocation`
reference the harness tests (level-ordered floor access, deterministic, no
duplicate reservation), the two-layer waste invariant (mass + pool) is the
official accounting and holds live at machine precision, and a clean world
baseline (`harness:resetWorld`) removed the pre-2.5 seed write-back bug that
had leaked ~13.5 t of phantom pool mass.

## CRITICAL BLOCKERS
1. **Dev deployment DISABLED by platform usage limit** (Sprint 2.6 load tests
   exceeded the free-tier cap). Must be re-enabled/raised in the Convex
   dashboard, then the stranded 10k `LOADTEST` players cleaned up
   (`harness:cleanupLoad` loop → `harness:resetWorld`).
2. No Solana integration of any kind (wallet, transactions, treasury) — SOL is
   mock by design under v0.4.
3. No production deployment configured (dev-only).
4. **Live 10k benchmark: RUN — correctness passes, performance target fails.**
   6/6 ticks, no failures, no write-limit errors, invariants ~1e-8, but tick
   p50 ≈ 3.1–3.4 s vs the < 1 s target (dev-deployment per-doc overhead
   dominates; headless 10k sim ≈ 55 ms/tick). Path options in
   NEXT IMMEDIATE TASK.
5. Storage/Battery upgrade costs are P1 placeholders awaiting rebalance.

(Resolved in Sprint 2.6: the non-atomic tick guard was verified SAFE under
concurrency — double-advance cannot occur; no guard fix needed. Continuation
added: burn-loop sharding for the 10k write budget and the `advanceBurn`
idempotency-contract fix, both covered by the headless suite.)

## NEXT IMMEDIATE TASK
**Launch plan (Sprint 2.8 confirms B for MVP):**
1. **MVP development: keep B (5 s tick).** 2.8 verified the per-game-hour
   economy is preserved and the tick cadence is stable at 10k.
2. **Pre-launch: production benchmark (A).** Create a production deployment in
   the Convex dashboard (or provide a prod deploy key) and run the runbook:
   ```
   CONVEX_DEPLOYMENT=<prod-url> bunx convex deploy
   bunx convex run harness:resetWorld --prod
   bunx convex run harness:seedLoad '{"count":2000,...}' --prod  (×5)
   bunx convex run harness:tickOnce --prod                     (×6, tickMs + dbReadOps/dbWriteOps)
   bunx convex run harness:benchStatus --prod && bunx convex run harness:invariantAudit --prod
   bunx convex run harness:cleanupLoad '{"limit":500}' --prod (loop) && bunx convex run harness:resetWorld --prod
   ```
   Decision matrix: PROD < 1 s → re-evaluate B (could go back to a faster
   tick); PROD ≈ 3 s → B stays; PROD > 5 s → C (spatial sharding) comes into
   play.
3. **Design follow-up — Model C reference RESOLVED (Sprint 2.9):** frozen at
   42 kg/game-h as a deliberate scarcity lever (`TOXIC_WORLD_STARTER_ECONOMY_
   RECALIBRATION_v0.1.md`); re-anchoring is a future balance-sprint option,
   not a pre-launch blocker. Remaining pre-launch design items: pick
   `WORLD_COLLAPSE_TARGET` from the Sprint 2.9 curve (freeze doc §4), then
   rebalance Storage/Battery P1 costs with the measured progression rates
   (game-h and real-h columns, freeze doc §3).
4. Protection systems (Lock/AFK/Shield/Emergency) remain unimplemented.
