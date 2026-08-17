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

## The game loop (server-side)

1. Every 2 s the cron `toxic-world-tick` calls `api.world.tick` (1 tick = 1 game minute).
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
bun test tests/                 # all 58 tests (economy + engine harness)
bun test tests/engine.test.ts   # Sprint 2.4 production engine test harness
bun test tests/economy.test.ts  # v0.4 reward formulas, idempotency, pollution accounting

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


## Status (honest)

- **Real:** world engine (cron-driven every 2s), spatial robots, v0.4 TOX economy
  with reward ledger + Burn Zones, persistence, auth, frontend, invariant
  telemetry per tick (`world.invariantSkewKg`), live audit (`harness:invariantAudit`).
- **Mock:** SOL balance (off-chain ledger) used only for the base purchase. No
  wallet, no Solana transaction.
- **Not implemented:** real settlement, reward outbox for SOL payouts, protection
  systems (Base Lock / AFK / Shield / Emergency Launch), leaderboard pagination,
  live-DB load tests at 10k players (the 10k scale test runs the headless
  oracle sim, not the Convex DB path).

See `TOXIC_WORLD_ENGINEERING_HANDOFF_v0.1.md` for the full engineering handoff,
known risks, and the next-task list.
