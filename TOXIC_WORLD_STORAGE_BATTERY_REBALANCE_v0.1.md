# TOXIC WORLD — STORAGE & BATTERY P1 REBALANCE v0.1 (Sprint 2.10)

Status: **FROZEN** — resolves the Design Freeze v0.3 open item "Storage/Battery
remain P1" (the handoff's next-step #1). Source of truth for the two rebalanced
cost curves; everything else in the freeze is untouched.

Measured on: deterministic headless oracle sim (`tests/engineSim.ts` → mirrors
`src/convex/world.ts` on the same pure functions), 5 s tick (Sprint 2.7 B),
deterministic Burn Zone schedule (active 4 ticks of every 16-tick cycle —
inside the frozen 15–30 s / 45–90 s window; the Sprint 2.9/2.10 runs used an
old seeded-RNG sim). Baseline re-measured in Sprint 2.11/2.12: **1,919.5 TOX /
game-day** at 500 TOX/t (superseded benchmark: 2,206.7). Verification:
`bun test tests/storageBatteryValidation.test.ts` — 10 tests / 0 fail; full
suite `bun test tests/` — 149 tests / 109,827 assertions / 0 fail.

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
| L1 | 152.50 | 79.98 |
| L2 | 220.50 | 115.54 |
| L3 | 328.58 | 172.78 |
| L4 | 467.17 | 245.20 |
| L5 | 597.08 | 313.38 |

Strictly increasing, **3.92× total** — cargo is THE throughput driver and
stays the #1 sink (costs 150/225/340/510 frozen, unchanged). Superseded
benchmark (old random-zone sim): L1 174.38 → L5 587.52, 3.4× total.

### Storage — the check-in / AFK buffer

Queue policy: storage is moved to the burner once per game-hour (a player who
checks in every 5 real minutes). The storage cap is the only thing that decides
how long the robot can work between check-ins.

| Storage Lv | Cap | Stall % of real time | Burned kg/game-h |
|---|---|---|---|
| L1 | 60 kg (≈0.35 game-h) | **57.5%** | 57.50 |
| L2 | 100 kg | 30.1% | 95.83 |
| L3 | 160 kg (≈0.92 game-h) | 0% | 147.50 |
| L4 | 260 kg | 0% | 147.50 |
| L5 | 420 kg (≈2.4 game-h) | 0% | 147.50 |

Finding: on a 1 game-hour check-in cadence the L1 hopper loses **62% of
throughput** to full-hopper stalls; L3 (the knee) recovers to ~97% of the
diligent baseline; L3+ is indistinguishable from diligent (only ~160 kg
accumulates per game-hour, so L4/L5 caps never bind at this cadence). Storage
is the highest-value non-cargo track for the intended casual loop.
Superseded benchmark (old sim): L1 71.5% / L3 149.31 / L4–5 167.71.

### Battery — the range / uptime track (recharge rate held at L1 in this sweep)

| Battery Lv | Cap | Recharge % of real time | Burned kg/game-h |
|---|---|---|---|
| L1 | 100 | **8.61%** | 152.50 |
| L2 | 150 | 7.99% | 153.33 |
| L3 | 220 | 7.29% | 154.17 |
| L4 | 320 | 7.64% | 153.33 |
| L5 | 460 | 6.81% | 154.58 |

Finding: for a diligent starter on short trips the cap alone moves recharge
dead time only 8.61% → 6.81% (+1.4% throughput). Its real value scales with
map sparsity and AFK (bigger battery = farther clusters feasible). Supporting
measurement — the recharge RATE (frozen track, L1 5/s → L5 26/s) is the
dead-time killer: same setup, sweeping recharge instead of battery drops
recharge share 8.61% → 2.36% (+5.5% throughput).

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

## 4. PROGRESSION ROI AFTER REBALANCE (starter, 500 TOX/t, 1,919.5 TOX/day)

Game-hours to afford each next level at the measured starter rate
(79.98 TOX/game-h, deterministic sim); real-h = game-h / 12:

| Track | L2 | L3 | L4 | L5 | Cumulative (game-h / real-h) |
|---|---|---|---|---|---|
| Cargo | 1.88 (0.16) | 2.81 (0.23) | 4.25 (0.35) | 6.38 (0.53) | 15.32 / 1.28 |
| Storage | 1.50 (0.13) | 2.38 (0.20) | 3.75 (0.31) | 5.75 (0.48) | 13.38 / 1.11 |
| Battery | 1.25 (0.10) | 2.00 (0.17) | 3.13 (0.26) | 5.00 (0.42) | 11.38 / 0.95 |
| Recharge | 0.25 (0.02) | 0.38 (0.03) | 0.56 (0.05) | 0.81 (0.07) | 2.00 / 0.17 |

Total sink (all four trees) = **3,365 TOX** → **1.75 game-days**
(~3.5 real hours of active play) to max everything, down from 1.92 game-days
under the placeholders (superseded benchmark under the old sim: 1.52
game-days / 13.32 game-h cargo tree). The 500 TOX/ton freeze is unchanged;
the sink column of the Sprint 2.9 sensitivity table was recomputed in the
freeze doc: 250 → 3.51, 350 → 2.50, 500 → 1.75, 650 → 1.35 game-days.

## 5. Open items (pre-launch)

- [ ] Playtest confirmation of the 1 game-hour check-in model (the storage
      axis assumes a player taps "process" once per 5 real minutes; the exact
      cadence determines whether storage should be cheaper or pricier).
- [ ] `WORLD_COLLAPSE_TARGET` decision from the Sprint 2.9 curve (unchanged,
      still open).
- [ ] Protection systems (Base Lock / AFK / Shield / Emergency Launch) will
      interact with storage's AFK-buffer role — revisit after they land.
