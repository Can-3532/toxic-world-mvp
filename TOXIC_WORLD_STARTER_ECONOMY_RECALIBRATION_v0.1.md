# TOXIC WORLD — STARTER ECONOMY RECALIBRATION v0.1 (Sprint 2.9)

Status: **FROZEN** — single source of truth for the four Sprint 2.9 values.
Companion docs: `TOXIC_WORLD_ENGINEERING_HANDOFF_v0.1.md`, `README.md`.

Measured on: deterministic headless oracle sim (`tests/engineSim.ts` → mirrors
`src/convex/world.ts` on the same pure functions `engine.ts` / `economy.ts` /
`gameParams.ts`), 5 s tick (Sprint 2.7 B), 1 game-min/tick, 12× compression.
Verification: `bun test tests/economyValidation.test.ts` — 30 pass / 0 fail;
full suite `bun test tests/` — 149 tests / 109,827 assertions, 0 fail
(Sprint 2.11 port + Sprint 2.12 protection-economy suite included).

> **SPRINT 2.11/2.12 RE-MEASUREMENT (deterministic sim):** the engineSim oracle
> was rewritten to a fully deterministic, world.ts-mirroring API and the Burn
> Zone is now driven by a fixed schedule (active 4 ticks of every 16-tick
> cycle = 20 s active per 80 s — inside the frozen 15–30 s / 45–90 s window)
> instead of the old seeded RNG. The frozen 500 TOX/t row therefore
> RE-MEASURED: L2 **1.88**, L5 **15.32** game-h, **1,919.5 TOX/game-day**
> (was 1.63 / 13.32 / 2,206.7 under the old random-zone sim). The old values
> are kept below as **superseded benchmark** where they appear. Decision
> outcomes are unchanged; only the measured rows shift.

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

Burn split (measured, 24 game-h, deterministic sim): **152.50 kg/game-h total
= 115.21 normal + 37.29 zone** → **27.98% of TOX earned inside Burn Zones**
(superseded benchmark from the old random-zone sim: 174.38 kg/game-h =
126.82 normal + 47.56 zone → 31.0%).

| TOX/t | L2 time (game-h / real-h) | L5 time (game-h / real-h) | daily TOX (game-day) | daily TOX (real-day) | TOX sink ratio (game-days to max all tracks) |
|---|---|---|---|---|---|
| 250 | 3.75 / 0.31 | 30.63 / 2.55 | 959.75 | 11,517 | 3.51 |
| 350 | 2.68 / 0.22 | 21.88 / 1.82 | 1,343.65 | 16,123.80 | 2.50 |
| **500** | **1.88 / 0.16** | **15.32 / 1.28** | **1,919.50** | **23,034.00** | **1.75** |
| 650 | 1.44 / 0.12 | 11.78 / 0.98 | 2,495.35 | 29,944.20 | 1.35 |

> Superseded benchmark (old random-zone sim): 250 → 3.26/26.65/1,103/3.05,
> 350 → 2.33/19.03/1,545/2.18, 500 → 1.63/13.32/2,207/1.52, 650 →
> 1.25/10.25/2,869/1.17. Same decisions; only the measured rows shifted.

> Sink-ratio column recomputed in Sprint 2.10: the Storage/Battery P1 rebalance
> (TOXIC_WORLD_STORAGE_BATTERY_REBALANCE_v0.1.md) cut the full upgrade-tree
> cost from 4,245 to 3,365 TOX. TOX/ton values are untouched; only the sink
> numbers shift (total sink / daily TOX).

Monotonicity verified: higher TOX/t ⇒ faster upgrades and lower sink ratio
(re-measured under the deterministic sim; the old 2.8 row — L2 1.63, L5
13.32, 2,206.7/day — is a superseded benchmark, see header note).

**Decision: keep 500 TOX/t.** At 500, a starter maxes the full upgrade tree
(all 4 tracks = 3,365 TOX after the Sprint 2.10 storage/battery rebalance) in
**1.75 game-days** (~3.5 real hours of active play at 12× compression;
superseded benchmark: 1.52 game-days).
250–650 bracket is documented for any future rebalance; the sink ratio table
is the reference.

## 4. DECISION 3 — World collapse tempo (real curve, no target forced)

Scenario: World 0 @ 50%, synthetic players with bases + **diligent auto-queue**
(max burn — lower bound on collapse time; the 2.8 no-queue numbers were the
upper bound). All players of the given activity % collect as fast as the
cluster-limited pool allows; `autoFraction` only gates who is active.

| Players | Activity | Collection (kg/game-h) | Gen (kg/game-h) | Net | 50→90 | 90→100 |
|---|---|---|---|---|---|---|
| 1,000 | 100% | 189,596 | 50,000 | **−78,444** | ∞ (never) | ∞ |
| 1,000 | 75% | 243,754 | 50,000 | −118,006 | ∞ | ∞ |
| 1,000 | 50% | 190,980 | 50,000 | −69,454 | ∞ | ∞ |
| 1,000 | 25% | 120,844 | 50,000 | −21,298 | ∞ | ∞ |
| 5,000 | 100% | 135,340 | 250,000 | +159,448 | 24.55 game-h (2.05 real-h) | 6.27 game-h (0.52 real-h) |
| 5,000 | 75% | 131,784 | 250,000 | +159,824 | 24.51 (2.04) | 6.26 (0.52) |
| 5,000 | 50% | 132,650 | 250,000 | +158,538 | 24.69 (2.06) | 6.31 (0.53) |
| 5,000 | 25% | 135,972 | 250,000 | +155,506 | 25.16 (2.10) | 6.43 (0.54) |
| 10,000 | 100% | 131,782 | 500,000 | +409,404 | 9.32 (0.78) | 2.44 (0.20) |
| 10,000 | 75% | 133,730 | 500,000 | +409,332 | 9.31 (0.78) | 2.44 (0.20) |
| 10,000 | 50% | 132,246 | 500,000 | +407,916 | 9.33 (0.78) | 2.45 (0.20) |
| 10,000 | 25% | 133,608 | 500,000 | +407,168 | 9.37 (0.78) | 2.46 (0.20) |

> Re-measured under the deterministic sim (superseded benchmark: 1K rows
> differed only in collection magnitude; 5K 50→90 ≈ 23.2, 90→100 ≈ 5.9;
> 10K 8.8 + 2.3 game-h). Conclusions unchanged.

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
   **~11.8 game-h total (50→90 9.32 + 90→100 2.44 ≈ 0.98 real-h)**; 5K in
   **~30.8 game-h (~2.57 real-h)**.
4. **Per-player collection DROPS with population (sharded loop).** 5K:
   ~27 kg/game-h/player (shardCount 2); 10K: ~13.2 kg/game-h/player
   (shardCount 4 — each robot advances every 4th tick, Sprint 2.6
   `ROBOTS_PER_TICK = 2500`). This is the write-budget tradeoff, now measured:
   at high population the sharded loop throttles collection ~2× vs 5K.
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
  Decision 3 collapse matrix (30 tests, deterministic zone schedule).
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
