# TOXIC WORLD — STARTER ECONOMY RECALIBRATION v0.1 (Sprint 2.9)

Status: **FROZEN** — single source of truth for the four Sprint 2.9 values.
Companion docs: `TOXIC_WORLD_ENGINEERING_HANDOFF_v0.1.md`, `README.md`.

Measured on: deterministic headless oracle sim (`tests/engineSim.ts` → mirrors
`src/convex/world.ts` on the same pure functions `engine.ts` / `economy.ts` /
`gameParams.ts`), 5 s tick (Sprint 2.7 B), 1 game-min/tick, 12× compression.
Verification: `bun test tests/economyValidation.test.ts` — 27 pass / 0 fail;
full suite `bun test tests/` — 92 tests / 67,846 assertions, 0 fail (after
Sprint 2.10, which added `tests/storageBatteryValidation.test.ts`).

---

## 1. FROZEN VALUES (v0.1)

| # | Constant | Value | Role |
|---|---|---|---|
| 1 | `WORLD.STARTER_OBSERVED_THROUGHPUT_KG_H` | **174.4 kg/game-h** (measured 174.38) | **INFORMATIONAL ONLY.** Measured emergent throughput of a lone L1 starter (24 game-h, diligent queue). Model C never reads it. |
| 2 | `WORLD.DEMAND_REF_KG_H` | **42 kg/game-h** | **DELIBERATE scarcity lever for Model C.** Officially NOT the measured throughput. Consequence (frozen): demand/gen ratio sits at the 5% replenishment floor in practice. Re-anchoring deferred to a future balance sprint. |
| 3 | `TOX_PER_TON` | **500 TOX / ton** (kept) | Normal burn reward. Zone = ×1.2 = 600 TOX/t. Burn reward is TOX-only (v0.4); SOL is entry-side mock only. |
| 4 | `WORLD_COLLAPSE_TARGET` | **OPEN — no target forced (Sprint 2.9)** | Real curve measured (section 4). Target to be set by design from this curve before launch. |

---

## 2. DECISION 1 — Starter throughput reference (resolved)

**Separated, not conflated.** The Model C demand reference is a *design lever*;
the measured starter throughput is an *observation*. They must not be the same
constant. Frozen values in §1.1–1.2; code in `src/convex/gameParams.ts`.

Why: with `DEMAND_REF_KG_H = 42` and measured demand ≈ 174 kg/game-h, the
Model C ratio = 42/gen is effectively pinned to the 5% floor at any population
with bases. That is the **frozen behavior** — replenishment runs at floor rate
until a balance sprint deliberately re-anchors it.

## 3. DECISION 2 — 500 TOX/ton: kept; sensitivity measured

Same starter run scaled bucket-by-bucket (normal ×1, zone ×1.2 — zone kg split
derived from the measured `toxFromNormal` / `toxFromZone` TOX buckets, so the
500 row reconstructs the Sprint 2.8 baseline to machine precision).

Burn split (measured, 24 game-h): **174.38 kg/game-h total = 126.82 normal +
47.56 zone** → **31.0% of TOX earned inside Burn Zones** (33.8% by encounter
metric from the 2.8 zone test).

| TOX/t | L2 time (game-h / real-h) | L5 time (game-h / real-h) | daily TOX (game-day) | daily TOX (real-day) | TOX sink ratio (game-days to max all tracks) |
|---|---|---|---|---|---|
| 250 | 3.26 / 0.27 | 26.65 / 2.22 | 1,103 | 13,240 | 3.05 |
| 350 | 2.33 / 0.19 | 19.03 / 1.59 | 1,545 | 18,536 | 2.18 |
| **500** | **1.63 / 0.14** | **13.32 / 1.11** | **2,207** | **26,480** | **1.52** |
| 650 | 1.25 / 0.10 | 10.25 / 0.85 | 2,869 | 34,424 | 1.17 |

> Sink-ratio column recomputed in Sprint 2.10: the Storage/Battery P1 rebalance
> (TOXIC_WORLD_STORAGE_BATTERY_REBALANCE_v0.1.md) cut the full upgrade-tree
> cost from 4,245 to 3,365 TOX. TOX/ton values are untouched; only the sink
> numbers shift (total sink / daily TOX).

Monotonicity verified: higher TOX/t ⇒ faster upgrades and lower sink ratio.
500 reproduces the 2.8 baseline exactly (L2 1.63, L5 13.32, 2,206.7/day).

**Decision: keep 500 TOX/t.** At 500, a starter maxes the full upgrade tree
(all 4 tracks = 3,365 TOX after the Sprint 2.10 storage/battery rebalance) in
**1.52 game-days** (~3.0 real hours of active play at 12× compression).
250–650 bracket is documented for any future rebalance; the sink ratio table
is the reference.

## 4. DECISION 3 — World collapse tempo (real curve, no target forced)

Scenario: World 0 @ 50%, synthetic players with bases + **diligent auto-queue**
(max burn — lower bound on collapse time; the 2.8 no-queue numbers were the
upper bound). All players of the given activity % collect as fast as the
cluster-limited pool allows; `autoFraction` only gates who is active.

| Players | Activity | Collection (kg/game-h) | Gen (kg/game-h) | Net | 50→90 | 90→100 |
|---|---|---|---|---|---|---|
| 1,000 | 100% | 171,889 | 50,000 | **−73,741** | ∞ (never) | ∞ |
| 1,000 | 75% | 219,985 | 50,000 | −111,216 | ∞ | ∞ |
| 1,000 | 50% | 203,458 | 50,000 | −83,430 | ∞ | ∞ |
| 1,000 | 25% | 140,062 | 50,000 | −29,301 | ∞ | ∞ |
| 5,000 | 100% | 89,600 | 250,000 | +168,348 | 23.2 game-h (1.94 real-h) | 5.9 game-h (0.50 real-h) |
| 5,000 | 75% | 88,800 | 250,000 | +169,860 | 23.0 (1.92) | 5.9 (0.49) |
| 5,000 | 50% | 90,480 | 250,000 | +166,804 | 23.5 (1.96) | 6.0 (0.50) |
| 5,000 | 25% | 99,270 | 250,000 | +163,588 | 23.9 (1.99) | 6.1 (0.51) |
| 10,000 | 100% | 54,320 | 500,000 | +429,942 | 8.8 (0.74) | 2.3 (0.19) |
| 10,000 | 75% | 53,760 | 500,000 | +430,792 | 8.8 (0.73) | 2.3 (0.19) |
| 10,000 | 50% | 53,320 | 500,000 | +434,020 | 8.7 (0.73) | 2.3 (0.19) |
| 10,000 | 25% | 52,520 | 500,000 | +430,270 | 8.8 (0.73) | 2.3 (0.19) |

### Findings (frozen into v0.1)

1. **Collection is CLUSTER-LIMITED, not activity-limited.** Within each
   population tier, 25%–100% activity changes collection by < 10%. The pool is
   gated by the cluster spawn cap (25/tick) and the 500-cluster map target —
   not by how many robots want to work.
2. **1K players = sustainable world.** Diligent players burn faster than 50
   bases generate → pollution declines, no collapse. The 2.8 "1K → 102.7
   game-h" was the no-queue upper bound; the real lower bound is ∞.
3. **5K and 10K collapse regardless of activity.** Generation (50 kg/game-h
   per base) overwhelms the cluster-limited collection. 10K collapses in
   **~11.1 game-h total (50→90 8.8 + 90→100 2.3 ≈ 0.92 real-h)**; 5K in
   **~29 game-h (~2.4 real-h)**.
4. **Per-player collection DROPS with population (sharded loop).** 5K:
   ~18 kg/game-h/player (shardCount 2); 10K: ~5.4 kg/game-h/player
   (shardCount 4 — each robot advances every 4th tick, Sprint 2.6
   `ROBOTS_PER_TICK = 2500`). This is the write-budget tradeoff, now measured:
   at high population the sharded loop throttles collection ~3.3× vs 5K.
5. **`WORLD_COLLAPSE_TARGET` stays OPEN.** The curve is now real; the design
   team picks a target from it (e.g., "10K collapse ≈ 1 real-h" is what the
   current constants produce; a slower or faster tempo is a
   `BASE_GEN_KG_H` / `CAPACITY_KG` tuning decision, NOT a code change).

---

## 5. Where this lives in code

- `src/convex/gameParams.ts` — `WORLD.STARTER_OBSERVED_THROUGHPUT_KG_H`,
  `WORLD.DEMAND_REF_KG_H`, `TOX_PER_TON`, `BURN_ZONE_MULTIPLIER` (single
  source of truth; comments cite this doc).
- `tests/economyValidation.test.ts` — Decision 2 sensitivity table +
  Decision 3 collapse matrix (27 tests, deterministic seeds).
- No other engine changes in Sprint 2.9 (measurement-only + the constant
  split).

## 6. Open items (pre-launch)

- [ ] `WORLD_COLLAPSE_TARGET` decision from the §4 curve.
- [ ] Live starter measurement (real players) to confirm 174.4 kg/game-h on
      the Convex deployment (headless oracle is the authority until then).
- [ ] Model C demand reference re-anchor debate (42 vs measured) — deliberately
      deferred; the 5% floor is frozen behavior.
- [x] Storage/Battery P1 rebalance uses the new daily-TOX + sink-ratio numbers
      — **DONE in Sprint 2.10** (`TOXIC_WORLD_STORAGE_BATTERY_REBALANCE_v0.1.md`
      + `tests/storageBatteryValidation.test.ts`); sink column above recomputed.
