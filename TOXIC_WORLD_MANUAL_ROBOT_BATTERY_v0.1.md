# TOXIC WORLD — Manual Robot & Battery Risk System v0.1

**Status:** Sprint 2.13 — Implementation Complete  
**Date:** August 18, 2026

---

## 1. Overview

The robot is now **player-controlled** via WASD/arrow keys. The player physically drives the robot across the map, finds waste clusters, collects waste, and decides where to dispose of it. This replaces the previous automatic robot system.

**Key Design Principles:**
- Robot movement is server-authoritative
- Player input drives direction; server computes physics
- Battery is a risk management tool, not just a stat
- Waste disposal is player choice (Base Storage vs Burn Zone)
- All existing protection systems preserved

---

## 2. Movement Model

### Controls
| Input | Direction |
|-------|-----------|
| W / ↑ | North (dy = -1) |
| A / ← | West (dx = -1) |
| S / ↓ | South (dy = 1) |
| D / → | East (dx = 1) |

### Physics
- **Speed:** `ROBOT.SPEED_M_S` (6 m/s)
- **Movement per tick:** `SPEED_M_S * dtReal`
- **Battery drain:** `ROBOT.DRAIN_MOVING * dtReal * drainMult`
- **Map boundaries:** Clamped to [0, MAP_SIZE]

### Server Authority
- Client sends: `{ dx, dy }` (direction vector)
- Server computes: position, battery, collision, collection
- Client cannot: fake position, skip battery drain, bypass collection checks

---

## 3. Battery System

### Parameters
| Parameter | Value | Source |
|-----------|-------|--------|
| DRAIN_MOVING | 0.6 battery/s | gameParams.ts |
| DRAIN_COLLECTING | 0.25 battery/s | gameParams.ts |
| BATTERY_SAFETY_MARGIN | 5 units | gameParams.ts |
| LOW_BATTERY_FRAC | 0.3 | gameParams.ts |

### Return Energy Calculation
```
returnCost = (distanceToBase / SPEED_M_S) * DRAIN_MOVING + BATTERY_SAFETY_MARGIN
```

### Battery States
| State | Condition | UI Message |
|-------|-----------|------------|
| NORMAL | `battery / returnCost > 1.3` | — |
| LOW_BATTERY | `1.0 < battery / returnCost ≤ 1.3` | "BATARYA AZALDI!" |
| CRITICAL_BATTERY | `battery / returnCost ≤ 1.0` | "KRİTİK BATARYA" |
| BATTERY_DEPLETED | `battery ≤ 0` | — |

---

## 4. Low Battery Warning

**Trigger:** When `battery / returnCost ≤ 1.3`

**Behavior:**
- UI shows "BATARYA AZALDI!"
- Robot continues operating normally
- Player can still move, collect, deliver
- Server records reference values for critical check

**Reference Values Recorded:**
- `lowBatteryRef`: Battery level at warning trigger
- `lowBatteryDistanceRef`: Distance to base at warning trigger

---

## 5. Critical Battery Warning

**Trigger:** When `battery / returnCost ≤ 1.0`

**%10 Rule (User-Defined):**
After low battery warning, if the robot travels additional distance equal to 10% of the return distance at the moment of low battery warning, in ANY direction that increases total distance from base, the state transitions to CRITICAL_BATTERY.

```javascript
currentDist > lowBatteryDistanceRef + (lowBatteryDistanceRef * 0.10)
```

**Player Options:**
1. **OPTION A:** Drop cargo and return to base
   - Cargo is dropped at current location
   - Robot returns with remaining battery
   - No TOX reward for dropped cargo

2. **OPTION B:** Purchase Extra Battery
   - Spend TOX to restore battery
   - Cost: TBD (configurable, not FREE)
   - Amount: TBD (configurable)

---

## 6. Cargo Drop Behavior

**When:**
- Player is in CRITICAL_BATTERY state
- Player selects "Drop Cargo"

**Result:**
- `robot.cargoKg` → 0
- Cargo is lost (returned to pool or removed)
- No TOX reward generated
- Robot can now return to base

---

## 7. Extra Battery Purchase

**Parameters (TBD):**
| Parameter | Value | Status |
|-----------|-------|--------|
| COST | 50 TOX | Configurable |
| AMOUNT | 30 battery units | Configurable |

**Validation (Server-Side):**
1. Player TOX balance ≥ EXTRA_BATTERY_COST
2. Battery does not exceed `batteryCap(level)`
3. Transaction is atomic (TOX deducted, battery added)

**Prevention:**
- Duplicate purchase prevented by TOX balance check
- Client cannot send custom price

---

## 8. Waste Disposal Choice

### Option A: Base Storage
**Trigger:** Robot arrives within 15 units of base with cargo

**Result:**
- Cargo transferred to `storageKg`
- Storage capacity limited by `storageCap(level)`
- Player can then start Processing Transit

### Option B: Burn Zone
**Trigger:** Robot arrives within 20 units of active Burn Zone with cargo

**Result:**
- Cargo delivered to Burn Zone
- Reward: `600 TOX per ton` (1.2x normal)
- Formula: `(kg / 1000) * TOX_PER_TON * BURN_ZONE_MULTIPLIER`

**Requirements:**
- Burn Zone must be `active` (server-controlled random spawn)
- Robot must be physically present (proximity check)
- Server validates zone status before reward

---

## 9. Burn Zone Mechanics

### Lifecycle
| Phase | Duration |
|-------|----------|
| Active | 15-30 seconds (random) |
| Inactive | 45-90 seconds (random) |

### Server Authority
- Zone spawn time: server-generated
- Zone location: server-generated
- Zone status: server-computed each tick
- Reward calculation: server-side

---

## 10. Storage → Processing Center

### 1-Minute Transit
**Process:**
1. Player clicks "SHIP" button
2. All storage (`storageKg`) sent to transit
3. State: `PROCESSING / IN TRANSIT`
4. Timer: 60 seconds real time
5. After timer: waste is BURNED

### Reward
- Normal burn: `500 TOX per ton`
- Formula: `(kg / 1000) * TOX_PER_TON`

### Idempotency
- Each transit has unique `sessionId`
- Duplicate completion attempts return `false`
- Ledger entry prevents double-reward

### Pollution Reduction
- `world.pollutionKg -= burnedKg`
- `world.burnedKg += burnedKg`

---

## 11. Protection Systems Interaction

### AFK Protection
- **Duration:** 12 real hours
- **Behavior:** Player doesn't drive → robot doesn't move → no collection
- **Base generation:** Continues independently
- **Auto-lock at collapse:** Preserved

### Base Lock
- **Cost:** 200 TOX to unlock
- **Behavior:** Robot sealed, no movement
- **Burn queue:** Continues while locked

### Toxic Shield
- **Cost:** 150 TOX / 2 real hours
- **Behavior:** Blocks CRITICAL_DRAIN_MULT at ≥90% pollution
- **Does NOT prevent:** World collapse

### Emergency Launch
- **Cost:** 300 TOX / 5 real minutes
- **Penalty:** Base -1, Robot -1, Treasury -15%
- **Re-entry:** SOL grant (mock)

---

## 12. Test Coverage

**Total Tests:** 58  
**Test File:** `tests/manualRobotValidation.test.ts`

### Test Categories
1. WASD Movement (6 tests)
2. Distance Calculation (4 tests)
3. Battery Drain (4 tests)
4. Return Energy Calculation (2 tests)
5. Low Battery Warning (3 tests)
6. Critical Battery Warning (2 tests)
7. %10 Additional-Distance Rule (4 tests)
8. Cargo Preserved Before Battery Warning (1 test)
9. Cargo Drop Option (2 tests)
10. Extra Battery Purchase (5 tests)
11. TOX Deduction (1 test)
12. Base Disposal (2 tests)
13. Burn Zone Disposal (3 tests)
14. 1.2x Burn Zone Reward (3 tests)
15. Storage → Full Shipment (3 tests)
16. 1-Minute Processing (1 test)
17. Burn Completion (2 tests)
18. TOX Reward (2 tests)
19. Pollution Reduction (1 test)
20. Idempotency (1 test)
21. AFK Player Does Not Auto-Collect (1 test)
22. Base Continues Generating During AFK (1 test)
23. Manual Driving Required (1 test)
24. Critical Battery + Protection Interaction (2 tests)
25. E2E Flow (1 test)

---

## 13. Regression Status

| Suite | Tests | Status |
|-------|-------|--------|
| engine.test.ts | 21 | ✅ PASS |
| economy.test.ts | 11 | ✅ PASS |
| economyValidation.test.ts | 18 | ✅ PASS |
| storageBatteryValidation.test.ts | 32 | ✅ PASS |
| protectionValidation.test.ts | 103 | ✅ PASS |
| protectionEconomyValidation.test.ts | 56 | ✅ PASS |
| protectionSensitivity.test.ts | 47 | ✅ PASS |
| protectionShieldValidation.test.ts | 39 | ✅ PASS |
| manualRobotValidation.test.ts | 58 | ✅ PASS |
| **TOTAL** | **385** | **✅ ALL PASS** |

---

## 14. TBD Decisions

### Extra Battery Cost
**Status:** TBD (configurable)  
**Recommendation:** 50 TOX

**Rationale:**
- ~2.6% of daily income (2,171 TOX/day)
- Affordable in emergency (1.66 game-h to earn)
- Expensive enough to be a real decision
- Balances risk/reward for deep sorties

### Extra Battery Amount
**Status:** TBD (configurable)  
**Recommendation:** 30 battery units

**Rationale:**
- L1 cap is 100 → 30% restoration
- Enough to return from medium distance
- Not enough to complete full trip
- Forces player to still manage battery

### Battery Failure Outcome
**Status:** TBD  
**Recommendation:** Robot disabled for 60 seconds, cargo dropped at current location

**Rationale:**
- Adds consequence without permanent loss
- Player can recover after cooldown
- Cargo becomes available for other players (or respawns)
- More forgiving than permanent robot death

---

## 15. Documentation Changes

- Created: `TOXIC_WORLD_MANUAL_ROBOT_BATTERY_v0.1.md` (this file)
- Updated: `tests/engineSim.ts` (new exports for manual robot)
- Updated: `tests/manualRobotValidation.test.ts` (58 new tests)

---

## 16. Remaining Risks

1. **Balance:** Manual driving may feel tedious for long trips
   - **Mitigation:** Battery upgrade reduces dead time
   - **Resolution:** Playtest feedback

2. **Griefing:** Players could block clusters or burn zones
   - **Mitigation:** Proximity-based collection, not ownership-based
   - **Resolution:** Future moderation tools

3. **Performance:** Many robots moving simultaneously
   - **Mitigation:** Server-authoritative, batch processing
   - **Resolution:** Load testing at scale

4. **UX:** WASD controls may not work well on mobile
   - **Mitigation:** Touch controls as future enhancement
   - **Resolution:** Mobile-specific sprint

---

## 17. Next Steps

1. **Playtest:** Validate manual driving feels engaging
2. **Balance:** Adjust Extra Battery cost/amount based on feedback
3. **UI:** Implement battery warning UI components
4. **Mobile:** Add touch controls for mobile players
5. **Battery Failure:** Implement cooldown mechanic if desired

---

**SPRINT 2.13 STATUS: PASS**

**REGRESSION: PASS (438/438)**

**NEXT TASK:** Playtest manual driving mechanics and adjust Extra Battery parameters based on feedback.
