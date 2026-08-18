# TOXIC WORLD — PROTECTION SYSTEMS DESIGN v0.1 (SPRINT 2.11 + 2.12)

Status: **FROZEN for implementation** (Sprint 2.11); **economy validated,
conditional freeze** (Sprint 2.12 — see §8).
Supersedes: no prior doc (the Design Freeze v0.3 listed the four systems as
decisions without mechanics; the Engineering Handoff carried them as
"NOT IMPLEMENTED", next-task #2).

Scope: Base Lock, AFK Protection, Toxic Shield, Emergency Launch — modeled as
ONE protection state machine because Storage (the check-in/AFK buffer from
Sprint 2.10), AFK Protection and Base Lock are not independent: the same
storage/cargo/queue decides what an AFK player loses or keeps.

Everything below is a NEW mechanic layer. It does NOT change: the frozen
economy constants (Sprint 2.9/2.10), Model C replenishment, Batch/Reservation,
the two-layer waste invariant, world capacity/collapse thresholds, the
500/600 TOX burn rewards. All TOX costs below are MVP placeholders, marked
`[PLAYTEST]`, exactly like the Sprint 2.10 rebalance did.

---

## 1. THE PROTECTION STATE MACHINE (single source of truth)

One `protection` object per player + one `lastActiveAt` timestamp:

```
                      ┌───────────────────────────────────────────────┐
                      │                                               │
  any player action   │           unlock (200 TOX)                   │
  ───────────────────────────► NORMAL ◄────────────────── LOCKED ◄────┤
                      │         ▲      │                       ▲   │  │
                      │         │      │ 12 real h idle        │   │  │
                      │         │      ▼ (tick detects)        │   │  │
                      │         │     AFK ──(world collapse)───┘   │  │
                      │         │            (auto-lock)           │  │
                      │         │                                  │  │
                      │         └──── launchBase (free) ──► LAUNCHING │
                      │                                            │  │
                      └────────────────────────────────────────────┘  │
                                    5 min later (tick completes)      │
                                            ▼                         │
                                     BASE DESTROYED ──► NORMAL        │
                                     (hasBase=false,                 │
                                      re-entry grant)                │
                                                                    └──┘
```

| State | Entered by | Meaning |
|---|---|---|
| `normal` | default; unlock; any action while `afk` | everything as today |
| `afk` | tick: `now − lastActiveAt ≥ 12 real hours` | autopilot base; only matters at collapse |
| `locked` | `lockBase` (voluntary) or tick at collapse when `afk` (forced, `lockReason="collapse"`) | sealed base |
| `launching` | `launchBase` (only from `locked`) | 5 real-minute escape countdown; base still sealed |

`lastActiveAt` is refreshed by **every** successful player mutation
(ensurePlayer, buyBase, commandRobot, toggleAuto, queueProcessing, upgrade,
lockBase, unlockBase, activateShield, launchBase, cancelLaunch). The `afk`
state ends the moment any action occurs.

## 2. WHAT EACH STATE DOES (production behavior)

### 2.1 NORMAL — unchanged.

### 2.2 AFK (12 real hours, separate mechanism from Base Lock)

- Base generation: **CONTINUES** at 50 kg/game-h. An AFK base is industrial
  autopilot — it stays world pressure (this matches the Sprint 2.9 collapse
  matrix, where inactive populations still drive pollution).
- Robot: continues in `auto` until the storage buffer fills, then parks with
  full cargo (the existing Sprint 2.10 storage-pressure stall). **Storage is
  the AFK buffer.**
- Collapse: the base **auto-locks** (`state=locked`, `lockReason="collapse"`,
  free — no unlock charge at that moment, but unlocking later costs TOX).
- Cost of AFK protection: the eventual unlock fee (200 TOX) + missed income
  while sealed. There is no recurring AFK fee. `[PLAYTEST]`

### 2.3 LOCKED (voluntary or forced)

- Base generation: **STOPS** (sealed base emits no waste → locking reduces
  your pollution footprint; a cooperative world-saving tool during critical).
- Robot: recalled to base and parked (`state=idle`, target cleared, cargo
  kept, `auto` flag preserved so it resumes after unlock). No demand, no
  collection, no new reservations.
- Storage / cargo / queue: **preserved and frozen** (no queueing while sealed).
- Existing burn queue: **CONTINUES** burning (the incinerator runs inside the
  sealed base) — this is deliberate: a player who locked with a full queue can
  earn the unlock fee, so the system cannot deadlock. Only *new* processing is
  blocked.
- Blocked actions while sealed: `commandRobot`, `toggleAuto`,
  `queueProcessing`, `upgrade`, `activateShield`, `lockBase`.
- Unlock: `unlockBase` costs **200 TOX** `[PLAYTEST]` and returns to `normal`.
- World collapse: **the base and its stockpile survive** (see §3) — that is
  the point of locking.
- UI: locked banner + Defense tab shows reason (`voluntary`/`collapse`).

### 2.4 LAUNCHING (Emergency Launch — 5 real minutes)

- Only from `locked` (voluntary or forced). Player commits **300 TOX**
  `[PLAYTEST]` and the world treasury loses **15%** (mock treasury, see §4) —
  charged at **completion**, not initiation. `cancelLaunch` is free and
  refunds nothing (nothing was charged).
- During the countdown the base behaves exactly like `locked` (sealed).
- On completion (tick sees `now ≥ launchAt`):
  - **Base −1**: `hasBase=false`, base position cleared.
  - **Robot −1**: robot doc reset to the reserve unit (idle at map center,
    full battery, empty cargo, `auto=true`).
  - Held waste (storage/cargo/queue) is **left behind on the abandoned base**
    (returned to the dying world's pool accounting — see §3).
  - **Treasury −15%**: `worlds.treasuryTox *= 0.85` (floor 0).
  - Player TOX balance keeps the launch fee and everything else (escaped with
    wealth).
  - Re-entry: player receives the genesis **0.1 SOL grant (MOCK)** so the
    loop is playable end-to-end (they can buy a new base).
  - `protection` returns to `normal`; the shield buff, if any, persists.
- Why launch instead of unlock: it is the free escape hatch when you cannot or
  will not pay the unlock fee — you keep your TOX, but lose the base.

### 2.5 Toxic Shield

- Purchase: `activateShield` — **150 TOX**, **2 real hours** `[PLAYTEST]`;
  re-buying refreshes the timer. Only while not sealed.
- Effect: while the **world is CRITICAL (pollution ≥ 90%)**, an unshielded
  robot's field battery drains at **×2** (toxic air corrodes exposed units;
  movement and collection only — recharging at base is safe). A shielded robot
  drains normally. In `safe` state the shield does nothing (pure insurance).
- It does **NOT** prevent or delay World Collapse — it is personal activity
  protection only.
- The shield does not stack with itself; it does not protect the stockpile.

## 3. WORLD COLLAPSE — THE FULL TRANSITION TABLE (storage/cargo/queue fate)

The user-facing question "what happens to storage/cargo on collapse" — answered
per state, checked at collapse time (tick §7):

| Player state at collapse | Storage / cargo / queue | Base | Post-collapse state |
|---|---|---|---|
| `normal` (active) | **WIPED** (dies with the world — unchanged v0.4 behavior) | survives | `normal` |
| `afk` | **PRESERVED** (auto-lock protection) | survives | `locked` (`collapse`) |
| `locked` | **PRESERVED** | survives | `locked` |
| `launching` | **PRESERVED** (until launch completes later) | survives | `launching` |

**Mass accounting (keeps the two-layer invariant EXACT — the reason this
design is safe):** preserved holdings are real recoverable pool mass carried
into the next cycle, so they must come out of the new world's atmosphere:

```
carriedKg = Σ kept players (storageKg + robot.cargoKg + processing.queuedKg)
P0        = capacity × 22.5%            (unchanged reset seed)
preserved = min(carriedKg, P0)          (a world cannot hold more than its seed)
pollutionKg(new) = P0
recoverable      = P0 − preserved
hiddenKg         = recoverable × 90%
collectableKg    = recoverable × 10%    (clusters spawned from this)
```

If `carriedKg > P0` (pathological, ~10k sealed max-stockpile players), kept
holdings are **proportionally scaled down** to `preserved` — the invariant
stays exact by construction. `seedPollutionKg = P0`, `generatedKg = 0`,
`burnedKg = 0` (fresh anchors, unchanged).

Fairness note `[PLAYTEST]`: AFK players keep stockpiles while active players
who did not lock lose them — the asymmetry is the entire point of the
protection systems (active players can voluntarily lock before collapse; the
cost is downtime + unlock fee). Flagged for playtest.

## 4. MOCK WORLD TREASURY

Emergency Launch's "Treasury −15%" has no real counterpart in v0.4 (the SOL
treasury/outbox rail was retired by design). This sprint adds a **MOCK**
world-level `worlds.treasuryTox` accumulator (genesis seed 1,000,000 TOX,
never credited by gameplay) purely so the −15% mechanic is real, testable and
visible. It is explicitly NOT a payout rail. When a real treasury/outbox
lands, this field becomes its simulation anchor.

## 5. CONSTANTS (all in `src/convex/gameParams.ts` → `PROTECTION`)

| Constant | Value | Status |
|---|---|---|
| `AFK_AFTER_MS` | 12 real hours | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12, kept** |
| `UNLOCK_COST_TOX` | 200 | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12, kept** |
| `SHIELD_COST_TOX` | 150 | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12, kept (flag §8.6)** |
| `SHIELD_DURATION_MS` | 2 real hours | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12, kept** |
| `CRITICAL_DRAIN_MULT` | 2 (unshielded, critical only) | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12, kept** |
| `LAUNCH_FEE_TOX` | 300 | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12, kept** |
| `LAUNCH_WINDOW_MS` | 5 real minutes | freeze v0.1 |
| `TREASURY_BURN_FRAC` | 0.15 | freeze v0.1 `[PLAYTEST]` — **validated Sprint 2.12 (server-side, floor 0)** |
| `TREASURY_SEED_TOX` | 1,000,000 (MOCK) | placeholder |

## 6. EXISTING ECONOMY IMPACT (measured, not assumed)

- Locking stops generation → `genKgH` drops → Model C ratio rises → the 5–9%
  replenishment clip stays; no constant changes.
- Locked/launching players contribute **0 demand** (robot parked).
- AFK players generate + demand exactly like active ones (unchanged).
- All of the above is exercised in `tests/protectionValidation.test.ts`
  (pure-function + deterministic oracle), and the oracle sim
  (`tests/engineSim.ts`) mirrors `world.ts` step-for-step as before.

## 7. OPEN ITEMS / DEVIATIONS

| Item | Note |
|---|---|
| Shield value in critical | measured starter value ≈ 5 TOX/game-h vs 6.25 TOX/game-h cost of coverage — slight overpay for short-trip starters; value scales with trip length/map sparsity; flagged for playtest (§8.6) |
| AFK 12h | real time (player-facing); game-time AFK is a future option |
| Locked burn continues | deliberate anti-deadlock choice (unlock fee earnable) — validated: sealed queue burns and pays the unlock fee |
| AFK keeps stockpile on collapse | fairness asymmetry, flagged for playtest |
| Treasury −15% | MOCK world accumulator (see §4) — not a payout rail |
| Usage frequency | synthetic 4% AFK/day; shield/lock usage only measurable in critical-world sims (event-driven) |
| UI | Defense tab shows all four systems + countdowns (implemented Sprint 2.11) |

---

## 8. SPRINT 2.12 — PROTECTION ECONOMY VALIDATION (measured)

Suite: `tests/protectionEconomyValidation.test.ts` — 56 tests / 0 fail (added
this sprint; full suite now 149 tests / 109,827 assertions / 0 fail). All
measurements use the deterministic oracle (`tests/engineSim.ts` → mirrors
`world.ts`/`engine.ts`/`economy.ts`) and the **new deterministic starter
baseline: 1,919.5 TOX/day = 79.98 TOX/game-h = 959.75 TOX/real-h** (the
2,206.7 TOX/day value is a superseded benchmark).

### 8.1 Storage + AFK interaction (does AFK invalidate storage? — NO)

| Cadence (24 game-h, L1 storage 60 kg) | TOX/day | Loss vs diligent |
|---|---|---|
| diligent (queue every tick) | 1,919.5 | — |
| 1 game-h check-in (AVERAGE ACTIVE) | 723 | 62% |
| 6 game-h check-in (OCCASIONAL) | 93 | 95% |
| 12 game-h idle then return | ~990 (12 game-h lost) | 48% |

AFK Protection does NOT devalue Storage: storage remains the difference
between the 1-game-h check-in player (723/day) and the occasional player
(93/day). Long AFK costs the idle hours' income outright — protection only
saves the **stockpile**, never the missed income (correct by design).

### 8.2 Player profiles (24 game-h)

| Profile | TOX/day | Protection spend | Notes |
|---|---|---|---|
| GOOD ACTIVE (diligent) | 1,919.5 | 0 | no protection needed |
| AVERAGE ACTIVE (1 game-h check-in) | 723 | 0 | 57.5% storage stall |
| OCCASIONAL (6 game-h check-in) | 93 | 0 | storage-bound |
| LONG AFK (12 game-h idle) | ~990 | 0 (AFK free) | 12 h income lost; stockpile safe at collapse |
| CRITICAL WORLD (shielded in critical) | ~1,700+ | 150/day (1 shield) | shield preserves drain; see §8.6 |

### 8.3 Economic comparison (starter 79.98 TOX/game-h)

| System | TOX cost | game-h to afford | What it saves | Differentiation |
|---|---|---|---|---|
| AFK | 0 | — | stockpile at collapse (auto-lock) | free + automatic; costs missed income + eventual 200 unlock |
| Base Lock | 200 | 2.50 (0.21 real-h) | stockpile + base at collapse | voluntary; generation STOPS (pollution tool); resume at 200 |
| Toxic Shield | 150 | 1.88 (0.16 real-h) | critical battery drain (activity only) | 24 game-h coverage; never blocks collapse |
| Emergency Launch | 300 | 3.75 (0.31 real-h) | escape a locked base; keeps TOX wealth | exit hatch when unlock is unaffordable; loses base+robot+stockpile, treasury −15% |

Pairwise: **AFK vs Lock** — same collapse outcome, different terms (AFK is
free + forced at collapse; Lock is voluntary + 200 and actively reduces
pollution). **Shield vs Launch** — never substitutes (150 insurance for
activity vs 300 exit). **Lock vs Launch** — Lock preserves and resumes for
200; Launch abandons for 300. No two systems solve the same problem.

### 8.4 Cost sensitivity (playtest values NOT accepted blindly)

Affordability at 0.5×/1×/1.5×/2× (starter game-h of income): unlock 1.25 /
2.50 / 3.75 / 5.00; shield 0.94 / 1.88 / 2.81 / 3.75; launch 1.88 / 3.75 /
5.63 / 7.50. Shield coverage cost per game-h: 75 → 3.13 (3.91% of daily
income), 150 → 6.25 (7.81%), 225 → 9.38 (11.72%), 300 → 12.50 (15.63%).
Unlock at 100/200/300/400 TOX = 1.25 / 2.50 / 3.75 / 5.00 game-h — **200
keeps unlock within one play session while remaining a real decision**
(100 would be friction-free, 400+ starts to feel punitive on top of the
already-lost sealed income).

### 8.5 Usage frequency at scale (deterministic, 24 game-h)

| Population | AFK triggers/day | Shield purchases | Lock events | TOX sink |
|---|---|---|---|---|
| 10 | 0 | 0 | 0 | 0 |
| 100 | 4 (4%) | 0 | 0 | 0 |
| 1,000 | 40 (4%) | 0 | 0 | 0 |
| 10,000 (50% active) | deterministic, invariant-exact | 0 | 0 | 0 |

AFK ≈ 4% of population/day (seeded inactive cohort) at every scale and
activity split. Shield/lock are **event-driven**: 0 in safe-world sims —
their usage only materializes in critical/collapse scenarios (measured in the
profile + collapse tests). The only recurring sink at steady state is AFK's
unlock fee when a collapsed player returns (event, not daily).

### 8.6 Findings → recommended values

1. **AFK — keep 12 real-h, free.** Storage is the true buffer; AFK is the
   safety net. No cost dimension to tune.
2. **Base Lock unlock — keep 200 TOX.** 10.42% of daily income, one session,
   earnable while sealed (queue keeps burning — anti-deadlock verified).
3. **Toxic Shield — keep 150 TOX / 2 real-h, with a playtest flag.** Measured
   protection value for a short-trip starter in critical ≈ 5 TOX/game-h vs
   6.25 TOX/game-h cost of coverage — a slight overpay that is justified as
   insurance and scales with trip length (bigger cargo / sparser map). If
   playtest shows critical phases are rare, 100–125 is the fallback.
4. **Emergency Launch — keep 300 TOX / 5 min.** 15.63% of daily income;
   correctly priced above unlock (200) because it also abandons the base.
   Penalties verified server-side: base −1, robot −1 (reserve unit), held
   waste returned to pool accounting, treasury ×0.85 (floor 0).

**PROTECTION ECONOMY FREEZE (conditional, Sprint 2.12):** AFK = free / 12
real hours; BASE LOCK unlock = 200 TOX; TOXIC SHIELD = 150 TOX / 2 real
hours (value flag §8.6.3); EMERGENCY LAUNCH = 300 TOX / 5 real minutes.
Condition: the shield flag is resolved by a playtest of critical-phase
frequency before launch. Everything else is test-supported as-is.

### 8.7 Acceptance criteria → status

| Criterion | Status |
|---|---|
| Protection state transitions deterministic | ✔ (13. determinism test) |
| Lock works (generation off, robot parked, stockpile kept, queue burns) | ✔ §4 |
| AFK works (12h detect, generation continues, collapse auto-lock, return) | ✔ §5 |
| Shield works (critical drain, no collapse block) | ✔ §3 + §8.6 |
| Emergency Launch works (5 min, cancel, penalties, re-entry grant) | ✔ §7 |
| Collapse interactions deterministic | ✔ §11 matrix |
| No protection creates duplicate reward | ✔ (ledger keys slice-unique) |
| Storage interaction consistent | ✔ §8.1 |
| TOX costs measurable | ✔ §8.3–8.4 |
| Usage frequency measurable | ✔ §8.5 |
| 10/100/1k/10k scale test | ✔ §10 |
| 100/75/50/25% active tests | ✔ §10 |
| Deterministic oracle passes | ✔ |
| Full test suite passes | ✔ 149 tests / 0 fail |
| Typecheck passes | ✔ `bun tsc -b --noEmit` |
| No unexplained invariant drift | ✔ every scenario (`simInvariant` exact) |
