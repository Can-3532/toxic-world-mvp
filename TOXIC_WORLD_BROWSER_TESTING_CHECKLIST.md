# TOXIC WORLD — Browser Testing Checklist (Sprint 2.13.2)

**Status:** Ready for Manual Browser Testing  
**Date:** August 18, 2026

---

## Overview

This checklist documents what needs to be verified on a real browser. The simulation tests (602 tests, all passing) validate the logic; this checklist validates the UX.

---

## 1. Movement Input Testing

### Controls
- [ ] W key moves robot north
- [ ] A key moves robot west
- [ ] S key moves robot south
- [ ] D key moves robot east
- [ ] ↑ arrow moves robot north
- [ ] ← arrow moves robot west
- [ ] ↓ arrow moves robot south
- [ ] → arrow moves robot east
- [ ] Diagonal movement (W+D) works correctly
- [ ] Diagonal movement normalized (not doubled speed)
- [ ] Stop on key release (no drift)
- [ ] Rapid key switching feels responsive
- [ ] Multiple keys held simultaneously handled correctly

### Boundary
- [ ] Robot clamps at map edges (0,0 to 1000,1000)
- [ ] No jitter at boundaries
- [ ] Robot doesn't escape map

### Feel
- [ ] Movement feels like "driving a car"
- [ ] No input lag visible
- [ ] No position rubber-banding
- [ ] Smooth acceleration/deceleration (if implemented)

---

## 2. Collection Testing

### Pickup
- [ ] Robot must be within 15 units of cluster to collect
- [ ] Collection takes ~4 seconds (COLLECT_TIME_S)
- [ ] Cargo fills during collection
- [ ] Cargo capped at cargoCap (20 kg L1)
- [ ] No collection when cargo full
- [ ] Battery drains during collection

### Cluster Interaction
- [ ] Cluster visually indicates pickup range
- [ ] Collection progress visible (if UI shows it)
- [ ] Collection fails if battery too low
- [ ] Cluster disappears after full collection

---

## 3. Disposal Decision

### Base Storage
- [ ] Robot approaches within 15 units of base
- [ ] Cargo transfers to storage
- [ ] Storage shows correct amount
- [ ] Storage capacity enforced

### Burn Zone
- [ ] Active Burn Zone visually distinct
- [ ] Robot approaches within 20 units of active zone
- [ ] Cargo delivers to zone
- [ ] 600 TOX/ton reward credited
- [ ] Inactive zone shows no reward
- [ ] Zone location random each spawn

### Decision
- [ ] Player can choose between Base and Burn Zone
- [ ] No auto-routing to either destination
- [ ] Both paths require manual driving

---

## 4. Battery UX

### Display
- [ ] Battery % visible at all times
- [ ] Distance to Base visible
- [ ] Return Energy Required visible
- [ ] Safe Return indicator visible

### Warnings
- [ ] "BATARYA AZALDI!" appears at LOW_BATTERY
- [ ] "KRİTİK BATARYA" appears at CRITICAL_BATTERY
- [ ] Warning doesn't block gameplay
- [ ] Warning clears when battery recharged

### States
- [ ] NORMAL: green/safe indicator
- [ ] LOW_BATTERY: yellow/warning indicator
- [ ] CRITICAL_BATTERY: red/danger indicator
- [ ] BATTERY_DEPLETED: grey/disabled indicator

---

## 5. Critical Battery Decision

### Cargo Drop
- [ ] "CARGO'YU BIRAK" option appears at CRITICAL
- [ ] Clicking drops all cargo (cargo = 0)
- [ ] No TOX reward for dropped cargo
- [ ] Player can continue driving after drop
- [ ] Return to base possible with remaining battery

### Extra Battery
- [ ] "EXTRA BATTERY AL" option appears at CRITICAL
- [ ] Price shown (50 TOX recommended)
- [ ] Purchase deducts TOX
- [ ] Battery increases by 30 units
- [ ] Cargo preserved after purchase
- [ ] Player can continue driving
- [ ] Insufficient TOX shows error

### %10 Rule
- [ ] Low Battery warning triggers at battery/returnCost ≤ 1.3
- [ ] Critical Battery triggers after 10% additional distance
- [ ] 9.9% does NOT trigger Critical
- [ ] 10.0% does NOT trigger Critical (boundary)
- [ ] 10.1% DOES trigger Critical

---

## 6. Storage Shipment

### Flow
- [ ] SHIP button appears when storage > 0
- [ ] Clicking SHIP starts 60-second transit
- [ ] Transit state shows "PROCESSING / IN TRANSIT"
- [ ] Timer counts down from 60s
- [ ] Storage clears immediately on SHIP
- [ ] After 60s: waste burned, TOX credited
- [ ] Pollution reduced by burned amount

### Idempotency
- [ ] Second SHIP during transit rejected
- [ ] Second completion attempt rejected
- [ ] No double TOX reward

---

## 7. Burn Zone

### Lifecycle
- [ ] Zone spawns at random location
- [ ] Zone active for 15-30 seconds
- [ ] Zone inactive for 45-90 seconds
- [ ] Zone visually indicates active/inactive
- [ ] Zone location shown on map

### Delivery
- [ ] Active zone accepts cargo
- [ ] Inactive zone rejects cargo
- [ ] 600 TOX/ton reward for active zone
- [ ] No reward for inactive zone
- [ ] Cargo fully delivered on arrival

---

## 8. Auth / Reconnect

### State Preservation
- [ ] Refresh page → robot position preserved
- [ ] Refresh page → battery preserved
- [ ] Refresh page → cargo preserved
- [ ] Refresh page → storage preserved
- [ ] Refresh page → processing transit continues
- [ ] Logout → login → state preserved
- [ ] Tab close → reopen → state preserved
- [ ] Network disconnect → reconnect → state preserved

### Protection
- [ ] AFK state preserved across reconnect
- [ ] Base Lock state preserved
- [ ] Shield state preserved
- [ ] Emergency Launch state preserved

---

## 9. Performance

### Metrics
- [ ] FPS stable at 60 (or target)
- [ ] Input latency < 50ms
- [ ] WebSocket latency < 100ms
- [ ] No memory leaks over 10 minutes
- [ ] No CPU spikes during movement
- [ ] Smooth rendering at 100+ clusters

### Stress
- [ ] 10+ active robots on screen
- [ ] 50+ clusters visible
- [ ] Multiple Burn Zones active
- [ ] Rapid input switching

---

## 10. E2E Flows

### Flow 1: Full Cycle
1. [ ] Login
2. [ ] Create base
3. [ ] Drive to waste cluster
4. [ ] Collect waste
5. [ ] Drive to base
6. [ ] Cargo transfers to storage
7. [ ] Click SHIP
8. [ ] Wait 60 seconds
9. [ ] TOX credited
10. [ ] Pollution reduced

### Flow 2: Burn Zone
1. [ ] Login
2. [ ] Drive to waste cluster
3. [ ] Collect waste
4. [ ] Find active Burn Zone
5. [ ] Drive to Burn Zone
6. [ ] Cargo delivers
7. [ ] 600 TOX/ton credited

### Flow 3: Critical Battery
1. [ ] Login
2. [ ] Drive far from base
3. [ ] LOW_BATTERY warning appears
4. [ ] Continue driving away
5. [ ] CRITICAL_BATTERY warning appears
6. [ ] Click "CARGO'YU BIRAK"
7. [ ] Cargo drops
8. [ ] Drive back to base
9. [ ] Arrive safely

### Flow 4: Extra Battery
1. [ ] Login
2. [ ] Drive far from base
3. [ ] LOW_BATTERY warning appears
4. [ ] Continue driving away
5. [ ] CRITICAL_BATTERY warning appears
6. [ ] Click "EXTRA BATTERY AL"
7. [ ] 50 TOX deducted
8. [ ] Battery increases by 30
9. [ ] Continue driving
10. [ ] Return to base

---

## 11. Bugs to Watch For

- [ ] Robot gets stuck (can't move)
- [ ] Cargo disappears unexpectedly
- [ ] TOX balance incorrect
- [ ] Battery drains too fast/slow
- [ ] Position rubber-banding
- [ ] Collection triggers at wrong distance
- [ ] Burn Zone reward wrong amount
- [ ] Storage shipment doesn't complete
- [ ] State lost on reconnect
- [ ] UI elements overlap/broken

---

## 12. UX Issues to Report

- [ ] Movement feels sluggish
- [ ] Battery warning too aggressive/passive
- [ ] Critical Battery decision unclear
- [ ] Burn Zone hard to find
- [ ] Storage shipment confusing
- [ ] Extra Battery price unclear
- [ ] Map too small/large
- [ ] Cluster density too high/low
- [ ] UI text too small/large

---

## Notes

- All simulation tests pass (602/602)
- TypeScript compiles cleanly
- No auto-collection in player gameplay
- Burn Zone = 600 TOX/ton (1.2x)
- Extra Battery = 50 TOX / 30 units (PLAYTEST, not frozen)
- Battery Failure = TBD (no auto-freeze)
- All protection systems preserved

---

**NEXT TASK:** Complete this checklist on real browser, report findings, adjust parameters if needed.
