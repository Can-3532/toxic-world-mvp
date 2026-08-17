# TOXIC WORLD — API SPECIFICATION v0.1

**Backend:** Convex serverless functions (NOT the FastAPI + WebSocket design from
BACKEND TECHNICAL SPECIFICATION v0.1 — see DEVIATION notes in the handoff report).

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
  `[{ name, burnedKg, earnedSol, tox, worldId }]`

### `api.world.worldState` — src/convex/world.ts
- Args: `{}`
- Auth: public (used by the landing page)
- Returns: `{ world, clusterCount, activePlayers, totalPlayers } | null`

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
- Effect: flips `robot.auto` (nearest-free-cluster autonomous targeting)
- Returns: `{ ok, auto }`

### `api.game.queueProcessing` — src/convex/game.ts
- Args: `{}`
- Auth: required
- Effect: moves `storageKg` into `processing.queuedKg` (reserved for the burner)
- Errors: `"Storage is empty"`
- Returns: `{ ok, queuedKg }`

### `api.game.upgrade` — src/convex/game.ts
- Args: `{ track: "cargo" | "recharge" | "battery" | "storage" }`
- Auth: required
- Effect: validates TOX balance against `UPGRADES[track].costs[level]`, deducts
  TOX, increments level; battery upgrade tops up battery by the cap delta
- Errors: `"Max level reached"`, `"Need N TOX"`
- Returns: `{ ok, level }`

### `api.world.tick` — src/convex/world.ts
- Args: `{}`
- Auth: public — **intentionally callable but rate-limited**
- Effect: advances the simulation one tick (generation → robots → replenishment
  → clusters → burn → status/collapse). Guard: skips if `now - world.lastTick
  < 0.8 × TICK_SECONDS × 1000`, so a client cannot accelerate the world.
- Driven by the cron job `toxic-world-tick` (every 2s). Clients should NOT call it.

---

## 3. CRON JOBS — src/convex/cron.ts

| Name | Schedule | Target |
|------|----------|--------|
| `toxic-world-tick` | every 2 s | `api.world.tick` |

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
