# TOXIC WORLD — STORAGE & BATTERY P1 REBALANCE v0.1 (Sprint 2.10)

Status: **FROZEN** — resolves the Design Freeze v0.3 open item "Storage/Battery
remain P1" (the handoff's next-step #1). Source of truth for the two rebalanced
cost curves; everything else in the freeze is untouched.

Measured on: deterministic headless oracle sim (`tests/engineSim.ts` → mirrors
`src/convex/world.ts` on the same pure functions), 5 s tick (Sprint 2.7 B),
seed 42 (the Sprint 2.9 frozen starter baseline: 2,206.7 TOX / game-day at 500
TOX/t). Verification: `bun test tests/storageBatteryValidation.test.ts` — 10
tests / 0 fail; full suite `bun test tests/` — 92 tests / 67,846 assertions /
0 fail.

---

## 1. THE PROBLEM (why the placeholders were wrong)

The freeze left Storage and Battery costs open; the MVP carried placeholders:

| Track | Placeholder | Total | vs Cargo (total 1,225, frozen) |
|---|---|---|---|
| Storage | 200/320/500/760 | **1,780** | **MORE than the throughput track** ❌ |
| Battery | 120/190/300/470 | **1,080** | nearly cargo-priced for a support track ❌ |

The buffer track (storage) costing more than the throughput track (cargo) is
inverted progression: the thing that makes you stronger at the core loop
(cargo) must be the primary sink, and the support tracks must be cheaper.

## 2. MEASURED TRACK VALUE (24 game-h starter, oracle sim)

### Cargo — the throughput track (frozen, reference)

| Cargo Lv | Burned kg/game-h | TOX/game-h |
|---|---|---|
| L1 | 174.38 | 91.95 |
| L2 | 264.53 | 138.55 |
| L3 | 356.86 | 188.14 |
| L4 | 477.01 | 250.14 |
| L5 | 587.52 | 309.25 |

Strictly increasing, **3.4× total** — cargo is THE throughput driver and stays
the #1 sink (costs 150/225/340/510 frozen, unchanged).

### Storage — the check-in / AFK buffer

Queue policy: storage is moved to the burner once per game-hour (a player who
checks in every 5 real minutes). The storage cap is the only thing that decides
how long the robot can work between check-ins.

| Storage Lv | Cap | Stall % of real time | Burned kg/game-h |
|---|---|---|---|
| L1 | 60 kg (≈0.35 game-h) | **71.5%** | 57.50 |
| L2 | 100 kg | 47.9% | 95.83 |
| L3 | 160 kg (≈0.92 game-h) | 11.2% | 149.31 |
| L4 | 260 kg | 0% | 167.71 |
| L5 | 420 kg (≈2.4 game-h) | 0% | 167.71 |

Finding: on a 1 game-hour check-in cadence the L1 hopper loses **2/3 of
throughput** to full-hopper stalls; L3 (the knee) recovers to ~91% of the
diligent baseline; L4+ is indistinguishable from diligent. Storage is the
highest-value non-cargo track for the intended casual loop.

### Battery — the range / uptime track (recharge rate held at L1 in this sweep)

| Battery Lv | Cap | Recharge % of real time | Burned kg/game-h |
|---|---|---|---|
| L1 | 100 | **7.71%** | 174.38 |
| L2 | 150 | 7.29% | 174.38 |
| L3 | 220 | 6.81% | 175.21 |
| L4 | 320 | 6.74% | 175.21 |
| L5 | 460 | 6.81% | 175.21 |

Finding: for a diligent starter on short trips the cap alone moves recharge
dead time only 7.71% → 6.81% (+0.5% throughput). Its real value scales with
map sparsity and AFK (bigger battery = farther clusters feasible). Supporting
measurement — the recharge RATE (frozen track, L1 5/s → L5 26/s) is the
dead-time killer: same setup, sweeping recharge instead of battery drops
recharge share 7.71% → 2.15% (+5.3% throughput).

## 3. DECISION — rebalanced curves (frozen v0.1)

| Track | Costs (L2→L5) | Total | Priority |
|---|---|---|---|
| Cargo | 150/225/340/510 | **1,225** | 1 (frozen — throughput) |
| Storage | **120/190/300/460** | **1,070** | 2 (check-in buffer — measured stall 71.5%→0%) |
| Battery | **100/160/250/400** | **910** | 3 (range/uptime — measured starter effect small) |
| Recharge | 20/30/45/65 | **160** | 4 (frozen — dead-time fix, QoL) |

Rules enforced (and pinned by tests):

1. Cargo total > Storage total > Battery total > Recharge total.
2. Neither support track exceeds cargo at ANY level (each storage step < its
   cargo step; each battery step < its storage step).
3. Caps and mechanics are UNCHANGED — this is a cost-only rebalance.

Code: `src/convex/gameParams.ts` → `UPGRADES.storage.costs`,
`UPGRADES.battery.costs` (comments cite this doc).

## 4. PROGRESSION ROI AFTER REBALANCE (starter, 500 TOX/t, 2,206.7 TOX/day)

Game-hours to afford each next level at the measured starter rate
(91.95 TOX/game-h); real-h = game-h / 12:

| Track | L2 | L3 | L4 | L5 | Cumulative (game-h / real-h) |
|---|---|---|---|---|---|
| Cargo | 1.63 (0.14) | 2.45 (0.20) | 3.70 (0.31) | 5.55 (0.46) | 13.32 / 1.11 (unchanged) |
| Storage | 1.31 (0.11) | 2.07 (0.17) | 3.26 (0.27) | 5.00 (0.42) | 11.64 / 0.97 |
| Battery | 1.09 (0.09) | 1.74 (0.15) | 2.72 (0.23) | 4.35 (0.36) | 9.90 / 0.83 |
| Recharge | 0.22 (0.02) | 0.33 (0.03) | 0.49 (0.04) | 0.71 (0.06) | 1.74 / 0.15 |

Total sink (all four trees) = **3,365 TOX** → **1.52 game-days**
(~3.0 real hours of active play) to max everything, down from 1.92 game-days
under the placeholders. The 500 TOX/ton freeze is unchanged; only the sink
column of the Sprint 2.9 sensitivity table shifts (recomputed in the freeze
doc: 250 → 3.05, 350 → 2.18, 500 → 1.52, 650 → 1.17 game-days).

## 5. Open items (pre-launch)

- [ ] Playtest confirmation of the 1 game-hour check-in model (the storage
      axis assumes a player taps "process" once per 5 real minutes; the exact
      cadence determines whether storage should be cheaper or pricier).
- [ ] `WORLD_COLLAPSE_TARGET` decision from the Sprint 2.9 curve (unchanged,
      still open).
- [ ] Protection systems (Base Lock / AFK / Shield / Emergency Launch) will
      interact with storage's AFK-buffer role — revisit after they land.
