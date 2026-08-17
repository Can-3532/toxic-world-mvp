# TOXIC WORLD — ENGINEERING HANDOFF v0.1

Verified against the repository on disk (Freebuff Web / Vly sandbox).
Everything below is grounded in actual files; anything not in the repo is
explicitly marked NOT PRESENT / NOT VERIFIED. Mock vs real is always labeled.

Verification evidence (run this turn):
- `bun convex dev --once` → exit 0 (`Convex functions ready!` 09:04:35, dev deployment)
- `bun tsc -b --noEmit` → exit 0 (part of the same combined run)

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
| `src/convex/schema.ts` | Tables: users, worlds, wasteClusters, players, worldEvents | Schema | ACTIVE | convex/server | codegen |
| `src/convex/gameParams.ts` | Economy constants (freeze values) shared FE/BE | Config | ACTIVE | — | world.ts, game.ts, frontend |
| `src/convex/world.ts` | World engine: `tick` (cron), `seedWorld`, `stepRobot`, queries | Engine | ACTIVE | gameParams, users | cron.ts, frontend |
| `src/convex/game.ts` | Player mutations + queries | Domain API | ACTIVE | gameParams, users | frontend |
| `src/convex/cron.ts` | `toxic-world-tick` every 2 s | Scheduler | ACTIVE | world.tick | deployment |
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
**NONE.** No `*.test.*` / `*.spec.*` files exist (glob-verified).

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
| Reward ledger (SOL) | `world.ts` / `game.ts` | `solBalance`, `totalEarnedSol` | DONE | **MOCK (off-chain)** | as above |
| TOX ledger | `world.ts` / `game.ts` | `toxBalance` | DONE | **MOCK (off-chain)** | as above |
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
| SOL reward settlement | `world.ts` | `tick` §5 | OFF-CHAIN | No | No | Adds to `solBalance` |
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

Constants: `CAPACITY_KG = 10,000,000`, `TICK_GAME_H = 1/60`,
`BASE_GEN_KG_H = 50`, `DEMAND_REF_KG_H = 42`, `SOL_PER_KG = (10/1000)/150`,
`TOX_PER_KG = 1`, `PROCESSING_KG_PER_S = 2`, `CLUSTER_MIN/MAX = 150/900`,
`ACTIVE_CLUSTER_TARGET = 500`, `CRITICAL_FRAC = 0.9`.

- **Generation:** `genKgH = activeBases × 50`; `pollutionKg = min(cap, pollutionKg + genKgH × 1/60)` per tick.
- **Demand (for Model C):** `demandKgH = Σ (robots in to_cluster|collecting|to_base) × 42` — a reference constant, **not** measured throughput (deviation, see §13).
- **Model C replenishment (per tick, scaled from per-hour):**
  `ratio = demandKgH/genKgH` (0 if gen=0);
  `replFracH = min(0.09, max(0.05, 0.05 × ratio))`;
  `unlockKg = min(hiddenKg, hiddenKg × replFracH × 1/60)`;
  `collectableKg += unlockKg`; `hiddenKg -= unlockKg`.
  → **Identical to the freeze formula**, recomputed **every tick (2 s real)**.
- **Batch allocation:** single reservation (`wasteClusters.reservedBy`) on
  `commandRobot`/auto-target; cleanup pass releases reservations whose owner no
  longer targets the cluster (`to_cluster`/`collecting`). Freeze's "floor access
  guarantee for low-level players" is **not** enforced (deviation).
- **Cluster spawn:** while `active < 500 && collectable ≥ 150 && spawned < 25`:
  `size = min(150 + rand×750, collectable)`; `collectable -= size`.
- **Burn:** `burn = min(queuedKg, 2 × 2s)`; `sol += burn × SOL_PER_KG`;
  `tox += burn × 1`; `totalBurnedKg/burnedKg += burn`.
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
| SOL reward / ton | $10/ton → 0.00006667 SOL/kg (@ $150/SOL) | gameParams | `SOL_PER_KG` | FREEZE (SOL price display constant = placeholder) |
| Settlement fee | 0 (none defined) | — | — | NOT DEFINED in freeze |
| TOX per kg | 1 | gameParams | `WORLD.TOX_PER_KG` | PLACEHOLDER (not in freeze) |
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
| (none exist in repo) | — | — | — | — | — |

Verification actually performed this handoff:
- `bun convex dev --once` → **PASS** (exit 0, 09:04:35) — codegen + deploy to dev.
- `bun tsc -b --noEmit` → **PASS** (exit 0) — whole-project typecheck.

**NOT TESTED (critical, no harness):** world-tick runtime behavior, cron firing,
mass-conservation invariant, economic balance, multi-player concurrency, load
(10k players), reservation race, double-tick prevention at runtime, upgrade
economics.

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
| Batch Allocation | `game.ts` `commandRobot`, `world.ts` cleanup | ⚠️ PARTIAL | reservation implemented; freeze's low-level "floor access guarantee" NOT enforced |
| Cargo costs 150/225/340/510 | `UPGRADES.cargo.costs` | ✅ | |
| Recharge costs 20/30/45/65 | `UPGRADES.recharge.costs` | ✅ | |
| Storage/Battery remain P1 | `UPGRADES.storage/battery.costs` | ⚠️ DEVIATION | freeze left open; filled with MVP placeholders (200/320/500/760, 120/190/300/470), flagged P1 |
| Critical = 90% | `CRITICAL_FRAC`, `tick` §6 | ✅ | |
| Collapse = 100% | `tick` §6 | ✅ | |
| No collapse countdown | `tick` §6 | ✅ | immediate reset |
| Single waste type | schema (`wasteClusters.kg` only) | ✅ | no waste-type field |
| Global waste pool | `worlds` fields + `tick` §1–4 | ✅ | |
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
| Backend Engine | DONE (world.ts) |
| Backend API | PARTIAL (Convex functions only; no REST/WebSocket layer) |
| Persistence | DONE (Convex DB, dev deployment) |
| Frontend | DONE (landing + game) |
| Auth | DONE (email OTP + anonymous) |
| Solana | NOT IMPLEMENTED — MOCK ONLY |
| Economy | PARTIAL (simulated; storage/battery placeholders; no fees) |
| Reward Settlement | MOCK (direct ledger credit; no outbox, no idempotency) |
| Multiplayer | PARTIAL (shared world state; NOT load-tested, not verified with concurrent clients) |
| Production Deployment | NOT CONFIGURED (dev deployment only) |

---

## 15. EXACT NEXT STEPS (priority order)

| # | TASK | ROLE | DEPENDENCY | OUTPUT | ACCEPTANCE CRITERIA |
|---|---|---|---|---|---|
| 1 | Reward Outbox + idempotency keys | Backend | — | `rewardOutbox` table; `processReward` with unique key | Duplicate tick credit impossible; every burn exactly one outbox entry |
| 2 | Engine test harness (invariants) | Backend | — | test script driving `tick` N times | Mass conservation within epsilon; collapse/reset verified; PASS in CI |
| 3 | Real Solana rail (wallet + base purchase + payouts) | Backend/Frontend | #1 | `@solana/web3.js` or Coinbase Commerce; wallet connect; treasury payouts | 0.1 SOL purchase verified on devnet; reward paid from treasury once |
| 4 | Split embedded models into tables | Backend | — | `robots`, `processingJobs`, `transactions` tables | Matches Backend Spec v0.1; migration script |
| 5 | Storage/Battery P1 balance | Economy | #2 | parameter update in `gameParams.ts` | Playtest data; storage pressure + ROI measured |
| 6 | Protection systems (Lock/AFK/Shield/Emergency) | Backend | — | schema + tick logic + UI | Each system has test + UI state |
| 7 | Concurrency hardening of `tick` | Backend | #1 | atomic guard or serialized tick | Double-tick impossible |
| 8 | Performance: spatial bucketing for nearest-cluster | Backend | — | indexed/spatial lookup | 10k-player tick < 2 s |
| 9 | Multiplayer QA (10/100/1k/10k) | QA | #8 | load script + report | Throughput/pollution curves match sim |
| 10 | Production deployment | DevOps | all | `bunx convex deploy` + prod envs | Landing + game on prod URL; cron firing |

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
| World engine | DONE | REAL (simulated) | `src/convex/world.ts` | Backend | #2 test harness |
| Economy | PARTIAL | REAL (simulated) | `gameParams.ts` | Economy | #5 P1 balance |
| Backend API | PARTIAL | REAL | `game.ts`, `world.ts` | Backend | #4 model split |
| Persistence | DONE | REAL | `schema.ts` | — | — |
| Frontend | DONE | REAL | `pages/`, `components/game/` | Frontend | #3 wallet UI |
| Auth | DONE | REAL | `convex/auth*.ts` | — | — |
| Reward settlement | MOCK | MOCK | `world.ts` §5 ledger | Backend | #1 outbox |
| Solana | NOT IMPLEMENTED | MOCK | none (no packages) | Blockchain | #3 real rail |
| Multiplayer | PARTIAL | REAL | shared world state | QA | #9 load test |
| Production deploy | NOT CONFIGURED | — | dev deployment only | DevOps | #10 deploy |

---

## CURRENT PROJECT STATE
A playable single-world MVP on Convex + React: server-authoritative spatial
robots, global waste pool with Model C replenishment and reservation allocation,
burn-for-SOL/TOX loop, upgrades, collapse/reset, auth, and a themed landing +
game UI. Everything economic is simulated in-database; no blockchain code exists.

## CRITICAL BLOCKERS
1. No reward outbox / idempotency — blocks any real SOL settlement.
2. No engine test harness — runtime correctness (invariants, collapse) unverified.
3. No Solana integration of any kind (wallet, transactions, treasury).
4. `tick` concurrency guard is not atomic — theoretical double-advance exists.
5. No production deployment configured (dev-only).

## NEXT IMMEDIATE TASK
**Build the reward outbox with idempotency keys** (`rewardOutbox` table +
credit-once logic in `world.ts` §5), so burn rewards become exactly-once before
any real-money rail is attached.
