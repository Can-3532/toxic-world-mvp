# TOXIC WORLD — API SPECIFICATION v0.1 (economy v0.4, engine Sprint 2.5)

**Backend:** Convex serverless functions (NOT the FastAPI + WebSocket design from
BACKEND TECHNICAL SPECIFICATION v0.1 — see DEVIATION notes in the handoff report).

> **v0.4 economy:** burn rewards are TOX-only. Normal burn = 500 TOX/ton; active
> Burn Zone = 600 TOX/ton (×1.2). Client NEVER sends a reward amount — the
> multiplier is decided server-side by the `burnZones` doc. Every burn slice is
> credited exactly-once through the `rewardLedger` table (`key =
> sessionId:sliceIndex`).
>
> **Sprint 2.5 engine consistency:** the world tick plans robot reservations
> through the same `batchAllocation` reference used by the test harness
> (level-ordered floor access, battery-feasible, deterministic, no duplicate
> reservation), and the official waste accounting is the TWO-LAYER invariant
> below (the old single-equation physical invariant is retired).

Client references are auto-generated in `src/convex/_generated/api.ts`.
All functions live under `src/convex/*.ts`. No REST endpoints exist except the
Convex Auth HTTP routes.

---

## 1. QUERIES (reactive subscriptions via `useQuery`)

### `api.users.currentUser` — src/convex/users.ts
- Args: `{}`
- Auth: none (returns `null` when signed out)
- Returns: `users` doc | `null`

### `api.game.me` — src/convex/game.ts
- Args: `{}`
- Auth: signed-in user (returns `null` otherwise)
- Returns: `players` doc | `null` — includes `robot`, `storageKg`,
  `processing.queuedKg`, `levels`, `solBalance`, `toxBalance`, lifetime counters

### `api.game.leaderboard` — src/convex/game.ts
- Args: `{}`
- Auth: public
- Returns: top-10 collectors by `totalBurnedKg`:
  `[{ name, burnedKg, toxEarned, worldId, earnedSol }]` where `toxEarned =
  toxFromNormal + toxFromZone` and `earnedSol` is DEPRECATED (v0.3, always 0)

### `api.world.worldState` — src/convex/world.ts
- Args: `{}`
- Auth: public (used by the landing page)
- Returns: `{ world, zone, clusterCount, activePlayers, totalPlayers } | null`
  where `zone` is the `burnZones` doc (status `active` | `inactive`, x/y,
  spawnedAt/expiresAt, multiplier 1.2)

### `api.world.clusters` — src/convex/world.ts
- Args: `{}`
- Auth: public
- Returns: `wasteClusters` docs for the current world (up to ~500)

### `api.world.events` — src/convex/world.ts
- Args: `{}`
- Auth: public
- Returns: last 40 `worldEvents` as `[{ type, message, at }]` (newest first)

---

## 2. MUTATIONS

### `api.game.ensurePlayer` — src/convex/game.ts
- Args: `{}`
- Auth: required
- Effect: creates the `players` doc if missing; grants the 0.1 SOL genesis
  demo credit (`genesisGrant: true`)
- Returns: `{ ok, created }`

### `api.game.buyBase` — src/convex/game.ts
- Args: `{}`
- Auth: required
- Effect: validates `solBalance >= 0.1`, deducts 0.1 SOL, places the base at a
  random position (120..880 in a 1000-unit map), resets robot to base, full battery
- Errors: `"Base already deployed"`, `"Base costs 0.1 SOL"`
- Returns: `{ ok, baseX, baseY }`

### `api.game.commandRobot` — src/convex/game.ts
- Args: `{ clusterId: Id<"wasteClusters"> }`
- Auth: required
- Effect: Batch/Reservation — reserves the cluster (`reservedBy`, `reservedAt`),
  sets robot state `to_cluster` with `arriveAt = now + dist/speed`
- Errors: `"Robot is busy"`, `"Cargo full"`, `"Cluster depleted"`,
  `"Cluster already reserved by another robot"`, `"Cluster is not in your world"`
- Returns: `{ ok, travelMs }`

### `api.game.toggleAuto` — src/convex/game.ts
- Args: `{}`
- Auth: required
- Effect: flips `robot.auto`. In auto mode the robot participates in the
  per-tick Batch/Reservation plan (`engine.ts batchAllocation`): idle robots
  are matched to unclaimed clusters in ascending level order (low-level floor
  access), battery-feasible and deterministic.
- Returns: `{ ok, auto }`

### `api.game.queueProcessing` — src/convex/game.ts
- Args: `{}`
- Auth: required
- Effect: moves `storageKg` into `processing.queuedKg` and starts/appends a burn
  session (`sessionId = playerId:now`, kept stable while the queue is non-empty
  so reward keys stay unique per waste unit)
- Errors: `"Storage is empty"`
- Returns: `{ ok, queuedKg }`

### `api.game.upgrade` — src/convex/game.ts
- Args: `{ track: "cargo" | "recharge" | "battery" | "storage" }`
- Auth: required
- Effect: validates TOX balance against `UPGRADES[track].costs[level]`, deducts
  TOX, increments level; battery upgrade tops up battery by the cap delta
- Errors: `"Max level reached"`, `"Need N TOX"`, `"Base is sealed…"` (Sprint 2.11)
- Returns: `{ ok, level }`

### `api.game.lockBase` — src/convex/game.ts (Sprint 2.11)
- Args: `{}` · Auth: required · Free
- Effect: `normal|afk` → `locked` (`lockReason="voluntary"`). Recalls the robot
  to base (idle, cargo kept, reservation released by the next tick's cleanup).
  While sealed: generation off, robot parked, stockpile preserved across
  collapse, existing burn queue keeps running.
- Errors: `"Buy a base first"`, `"Base is already sealed"`
- Returns: `{ ok, state: "locked" }`

### `api.game.unlockBase` — src/convex/game.ts (Sprint 2.11)
- Args: `{}` · Auth: required
- Effect: `locked` → `normal` for `PROTECTION.UNLOCK_COST_TOX` (200). The
  sealed incinerator keeps burning, so the fee is always earnable.
- Errors: `"Base is not locked"`, `"Unlock costs 200 TOX"`
- Returns: `{ ok, state: "normal" }`

### `api.game.activateShield` — src/convex/game.ts (Sprint 2.11)
- Args: `{}` · Auth: required
- Effect: sets `protection.shieldUntil = now + 2 h` for `150 TOX` (re-buying
  refreshes). While the world is CRITICAL, unshielded field robots drain ×2;
  the shield never prevents world collapse.
- Errors: `"Shield costs 150 TOX"`, `"Base is sealed…"`
- Returns: `{ ok, shieldUntil }`

### `api.game.launchBase` — src/convex/game.ts (Sprint 2.11)
- Args: `{}` · Auth: required
- Effect: `locked` → `launching` with `launchAt = now + 5 min`. Fees (300 TOX
  + 15% mock treasury) are charged at COMPLETION by the tick; the base stays
  sealed during the countdown.
- Errors: `"Only a locked base can launch"`, `"Launch needs 300 TOX…"`
- Returns: `{ ok, launchAt }`

### `api.game.cancelLaunch` — src/convex/game.ts (Sprint 2.11)
- Args: `{}` · Auth: required
- Effect: `launching` → `locked` (free; nothing was charged yet).
- Errors: `"No launch in progress"`
- Returns: `{ ok, state: "locked" }`

### `api.world.tick` — src/convex/world.ts
- Args: `{}`
- Auth: public — **intentionally callable but rate-limited**
- Effect: advances the simulation one tick (generation → Batch/Reservation
  planning → robots → replenishment → clusters → burn → status/collapse).
  Guard: skips if `now - world.lastTick < 0.8 × TICK_SECONDS × 1000`, so a
  client cannot accelerate the world.
- Driven by the cron job `toxic-world-tick` (every 2s). Clients should NOT call it.
- Writes per-tick mass-balance telemetry (`world.invariantSkewKg`); see the
  two-layer invariant spec in §3c.

---

## 3. CRON JOBS — src/convex/crons.ts

| Name | Schedule | Target |
|------|----------|--------|
| `toxic-world-tick` | every 2 s | `api.world.tick` |

---

## 3b. V0.4 REWARD ECONOMY (server-side)

Pure formulas live in `src/convex/economy.ts` (imported by the world engine and
by `tests/economy.test.ts` — no Convex runtime imports):

```
normalBurnTox(kg)   = kg / 1000 × 500            // 1 ton → 500 TOX
burnZoneTox(kg)     = normalBurnTox(kg) × 1.2    // 1 ton → 600 TOX
rewardKey(session, slice) = `${session}:${slice}` // idempotency key
applyBurnToPollution(p, kg) = max(0, p - kg)      // identical for both kinds
```

In `world:tick` (step 6): each burn slice looks up its key in `rewardLedger`;
if absent it credits TOX (`toxBalance`, `toxFromNormal`/`toxFromZone`) and
inserts the ledger row; if present it burns the kg with NO credit (duplicate-tick
safe). Client-supplied numbers never enter this path.

---

## 3c. SPRINT 2.5 — WASTE ACCOUNTING SPEC + BATCH/RESERVATION (official)

**Two-layer waste invariant** (supersedes the old physical invariant; verified
live by `harness:invariantAudit` and every headless engine test):

```
Layer 1 — Primary Mass Invariant:
    seedPollutionKg + generatedKg == pollutionKg + burnedKg

Layer 2 — Secondary Pool Invariant (holdings partition the recoverable
atmosphere; every kg sits in EXACTLY ONE bucket — never double-counted):
    hiddenKg + collectableKg + clusterKg + cargoKg + storageKg + processingKg
        == pollutionKg − generatedKg
```

Generated waste enters the atmosphere, not the pools; burned waste left the
system — hence the subtraction in Layer 2.

**Batch/Reservation allocation** (`engine.ts batchAllocation`, called by the
production tick AND the oracle simulator on the same inputs): robots sorted by
ascending level (tie-break: id), processed in batches of `WORLD.BATCH_SIZE`
(20); each takes its nearest affordable unclaimed cluster. Guarantees: shared
pool scarcity, L1 floor access, no duplicate reservation, deterministic result.

**Clean World (Sprint 2.5):** `harness:resetWorld` re-seeds World 0 at
capacity 10,000 t, pollution 50%, collectable 10%, generated 0, burned 0,
zero legacy residual (fixes the pre-2.5 seed write-back bug that caused ~13.5 t
of phantom pool mass). All benchmarks run from this baseline.

---

## 4. HTTP ROUTES — src/convex/http.ts

- `auth.addHttpRoutes(http)` — Convex Auth OIDC / sign-in routes (see
  `@convex-dev/auth`). No game endpoints over HTTP.

---

## 5. ERROR CONVENTIONS

- Mutations throw `Error(message)`; Convex surfaces them as exceptions to the
  client (`useMutation().catch(...)`). The UI maps them to toasts in
  `src/pages/Game.tsx` (`errMsg()` helper).
- There is no structured error-code envelope (no 400/409 style responses).

---

## 6. TIME MODEL (important for any consumer)

- 1 world tick = 2 s real = 1 game minute (30× compression).
- All throughput constants are per **game hour**; the engine scales by
  `GAME_MINUTES_PER_TICK / 60 = 1/60` per tick.
