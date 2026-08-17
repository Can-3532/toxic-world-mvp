# TOXIC WORLD — DATABASE SCHEMA v0.1

Source of truth: `src/convex/schema.ts` (Convex, `schemaValidation: false`).

Notes:
- Convex adds `_id` (Id<Table>) and `_creationTime` to every doc automatically.
- **Embedded models:** Base, Robot, Processing, Upgrade levels, and the economy
  ledger are fields *inside* the `players` doc — there are NO standalone
  `base`, `robot`, `processingJob`, `transaction`, `upgrade`, or
  `rewardOutbox` tables (deviation from BACKEND TECHNICAL SPECIFICATION v0.1,
  which planned separate domain models).
- Reward accounting is a **mock off-chain ledger** (`solBalance`,
  `totalEarnedSol`, `toxBalance`); no on-chain data is stored anywhere.

---

## Tables

### `users` (template auth table — do not remove)
| Field | Type | Notes |
|---|---|---|
| `name` | string? | |
| `image` | string? | |
| `email` | string? | indexed (`email`) |
| `emailVerificationTime` | number? | |
| `isAnonymous` | boolean? | |
| `role` | "admin"\|"user"\|"member"? | `roleValidator` |

Plus `authTables()` system tables: `authAccounts`, `authSessions`,
`authVerificationRequests` (managed by `@convex-dev/auth`).

### `worlds` — single live world doc (worldId increments on collapse)
| Field | Type | Notes |
|---|---|---|
| `worldId` | number | 0 = World 0; +1 per collapse |
| `capacityKg` | number | 10,000,000 (= 10,000 t) |
| `pollutionKg` | number | global waste mass (atmosphere) |
| `collectableKg` | number | portion robots can grab |
| `hiddenKg` | number | locked portion (replenishment unlocks) |
| `status` | "safe"\|"critical"\|"collapsed" | |
| `generationRateKgH` | number | Σ base generation, per game hour |
| `demandKgH` | number | active-robot demand reference |
| `burnedKg` | number | burned this world cycle |
| `activePlayers` | number | players with `hasBase` |
| `resetCount` | number | collapse counter |
| `startedAt` | number | epoch ms |
| `lastTick` | number | epoch ms; rate-limit guard for `tick` |

Indexes: none (single doc, fetched with `.first()`).

### `wasteClusters` — spatial materialization of the collectable pool
| Field | Type | Notes |
|---|---|---|
| `worldId` | number | |
| `x`, `y` | number | 0..1000 map units |
| `kg` | number | 150–900, consumed by robots |
| `reservedBy` | Id<"players">? | Batch/Reservation allocation |
| `reservedAt` | number? | |

Index: `by_world` (`worldId`).

### `players` — one doc per signed-in user; owns base, robot, economy
| Field | Type | Notes |
|---|---|---|
| `userId` | Id<"users"> | indexed (`by_user`) |
| `worldId` | number | world the player lives in |
| `name` | string? | display name |
| `hasBase` | boolean | base purchased? |
| `baseX`, `baseY` | number? | base position |
| `solBalance` | number | **mock** SOL ledger (incl. 0.1 genesis grant) |
| `toxBalance` | number | **mock** TOX ledger (spent on upgrades) |
| `genesisGrant` | boolean | demo credit flag |
| `totalCollectedKg` | number | lifetime |
| `totalBurnedKg` | number | lifetime |
| `totalEarnedSol` | number | lifetime mock rewards |
| `storageKg` | number | waste held at base |
| `processing` | object | `{ queuedKg, since }` — reserved for burner |
| `levels` | object | `{ cargo, recharge, battery, storage }` each 1..5 |
| `robot` | object | see below |

`robot` embedded object:
`{ state: "idle"|"to_cluster"|"collecting"|"to_base"|"unloading"|"recharging",
   x, y, fromX, fromY, departAt, targetClusterId?, battery, cargoKg,
   arriveAt?, busyUntil?, auto, totalTrips }`

Indexes: `by_user` (`userId`), `by_world` (`worldId`).

### `worldEvents` — capped event feed (spawn/depleted/burn/collapse)
| Field | Type | Notes |
|---|---|---|
| `worldId` | number | |
| `type` | string | e.g. "spawn" \| "depleted" \| "burn" \| "collapse" |
| `message` | string | human-readable |
| `at` | number | epoch ms |

Index: `by_world` (`worldId`). Capped at 60 docs per world (`addEvent`).

---

## Relationships

- `players.userId → users._id`
- `players.worldId → worlds.worldId` (logical, not a FK)
- `wasteClusters.worldId → worlds.worldId` (logical)
- `wasteClusters.reservedBy → players._id` (logical; cleared when robot stops targeting)
- `players.robot.targetClusterId → wasteClusters._id` (logical, optional)

## Planned-but-missing tables (from Backend Spec v0.1)

| Table | Status |
|---|---|
| `processingJob` | NOT PRESENT (embedded in `players.processing`) |
| `transaction` | NOT PRESENT |
| `rewardOutbox` | NOT PRESENT — **critical for real SOL settlement** |
| `upgrade` | NOT PRESENT (embedded in `players.levels`) |
| `protection` (Base Lock / AFK / Shield / Emergency Launch) | NOT PRESENT |
