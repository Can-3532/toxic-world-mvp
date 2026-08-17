import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

export const robotStateValidator = v.union(
  v.literal("idle"),
  v.literal("to_cluster"),
  v.literal("collecting"),
  v.literal("to_base"),
  v.literal("unloading"),
  v.literal("recharging"),
);
export type RobotState = Infer<typeof robotStateValidator>;

export const worldStatusValidator = v.union(
  v.literal("safe"),
  v.literal("critical"),
  v.literal("collapsed"),
);
export type WorldStatus = Infer<typeof worldStatusValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // TOXIC WORLD — single live world document (worldId 0, increments on collapse)
    worlds: defineTable({
      worldId: v.number(),
      capacityKg: v.number(),
      pollutionKg: v.number(), // global waste mass in the atmosphere
      collectableKg: v.number(), // portion of pollution that robots can grab
      hiddenKg: v.number(), // locked portion that replenishment unlocks
      status: worldStatusValidator,
      generationRateKgH: v.number(), // total base generation (kg / game hour)
      demandKgH: v.number(), // active robot demand (kg / game hour)
      burnedKg: v.number(), // total burned this world cycle
      activePlayers: v.number(), // players with a base
      resetCount: v.number(),
      startedAt: v.number(),
      lastTick: v.number(),
    }),

    // waste clusters on the map — the collectable pool materialized spatially
    wasteClusters: defineTable({
      worldId: v.number(),
      x: v.number(),
      y: v.number(),
      kg: v.number(),
      reservedBy: v.optional(v.id("players")), // Batch/Reservation allocation
      reservedAt: v.optional(v.number()),
    }).index("by_world", ["worldId"]),

    // one player-state document per signed-in user
    players: defineTable({
      userId: v.id("users"),
      worldId: v.number(),
      name: v.optional(v.string()),
      hasBase: v.boolean(),
      baseX: v.optional(v.number()),
      baseY: v.optional(v.number()),
      // mock economy ledger (real Solana settlement is a follow-up rail)
      // v0.4: SOL is used ONLY for the (mock) base purchase; burn pays TOX.
      solBalance: v.number(), // MOCK — base purchase only
      toxBalance: v.number(), // game token — earned by burning, spent on upgrades
      genesisGrant: v.boolean(),
      totalCollectedKg: v.number(),
      totalBurnedKg: v.number(),
      // DEPRECATED (v0.3) — burn no longer pays SOL. Kept for backward
      // compat with existing docs; never written after v0.4.
      totalEarnedSol: v.optional(v.number()),
      // v0.4 TOX reward counters (server-side, derived from rewardLedger)
      toxFromNormal: v.optional(v.number()),
      toxFromZone: v.optional(v.number()),
      storageKg: v.number(),
      processing: v.object({
        queuedKg: v.number(), // reserved for the burner
        since: v.number(),
        sessionId: v.optional(v.string()), // unique burn session (queueProcessing)
        sliceIndex: v.optional(v.number()), // idempotency key component
      }),
      levels: v.object({
        cargo: v.number(), // 1..5
        recharge: v.number(), // 1..5
        battery: v.number(), // 1..5
        storage: v.number(), // 1..5
      }),
      robot: v.object({
        state: robotStateValidator,
        x: v.number(),
        y: v.number(),
        fromX: v.number(),
        fromY: v.number(),
        departAt: v.number(),
        targetClusterId: v.optional(v.id("wasteClusters")),
        battery: v.number(),
        cargoKg: v.number(),
        arriveAt: v.optional(v.number()),
        busyUntil: v.optional(v.number()),
        auto: v.boolean(),
        totalTrips: v.number(),
      }),
    })
      .index("by_user", ["userId"])
      .index("by_world", ["worldId"]),

    // live world event feed (spawns, depletions, burns, burn zones, collapse)
    worldEvents: defineTable({
      worldId: v.number(),
      type: v.string(),
      message: v.string(),
      at: v.number(),
    }).index("by_world", ["worldId"]),

    // v0.4 — Burn Zone: temporary, randomly-located shared event with a
    // server-side reward multiplier. Client only ever reads this state.
    burnZones: defineTable({
      worldId: v.number(),
      status: v.union(v.literal("active"), v.literal("inactive")),
      x: v.number(),
      y: v.number(),
      spawnedAt: v.number(),
      expiresAt: v.number(),
      nextSpawnAt: v.number(),
      multiplier: v.number(), // 1.2 while active
    }).index("by_world", ["worldId"]),

    // v0.4 — TOX reward ledger (source of truth for burn rewards).
    // One entry per burn slice; `key` (sessionId:sliceIndex) makes rewards
    // exactly-once: the same waste unit can never produce TOX twice.
    rewardLedger: defineTable({
      playerId: v.id("players"),
      worldId: v.number(),
      key: v.string(),
      kind: v.union(v.literal("normal"), v.literal("burn_zone")),
      kg: v.number(),
      tox: v.number(),
      at: v.number(),
    }).index("by_player", ["playerId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
