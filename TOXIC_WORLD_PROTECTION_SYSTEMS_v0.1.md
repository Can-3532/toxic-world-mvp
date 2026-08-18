# TOXIC WORLD — PROTECTION SYSTEMS DESIGN v0.1 (SPRINT 2.11)

Status: **FROZEN for implementation** (this sprint).
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
| `AFK_AFTER_MS` | 12 real hours | freeze v0.1 `[PLAYTEST]` |
| `UNLOCK_COST_TOX` | 200 | freeze v0.1 `[PLAYTEST]` |
| `SHIELD_COST_TOX` | 150 | freeze v0.1 `[PLAYTEST]` |
| `SHIELD_DURATION_MS` | 2 real hours | freeze v0.1 `[PLAYTEST]` |
| `CRITICAL_DRAIN_MULT` | 2 (unshielded, critical only) | freeze v0.1 `[PLAYTEST]` |
| `LAUNCH_FEE_TOX` | 300 | freeze v0.1 `[PLAYTEST]` |
| `LAUNCH_WINDOW_MS` | 5 real minutes | freeze v0.1 |
| `TREASURY_BURN_FRAC` | 0.15 | freeze v0.1 `[PLAYTEST]` |
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
| All TOX costs/durations | `[PLAYTEST]` — placeholders pending playtest, same discipline as Sprint 2.10 |
| Treasury −15% | MOCK world accumulator (see §4) — not a payout rail |
| AFK 12h | real time (player-facing); game-time AFK is a future option |
| Locked burn continues | deliberate anti-deadlock choice (unlock fee earnable); flagged |
| AFK keeps stockpile on collapse | fairness asymmetry, flagged for playtest |
| UI | Defense tab shows all four systems + countdowns (implemented this sprint) |
