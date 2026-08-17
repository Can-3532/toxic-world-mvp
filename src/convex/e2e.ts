// TOXIC WORLD — e2e test helpers (QA only, NOT part of the game API).
//
// Purpose: the Convex CLI cannot perform a real browser sign-in, so the
// authenticated flow (Sign In -> Base -> Robot -> Collect -> Process -> Burn)
// is exercised by injecting a real `users` doc id via `convex run --identity`.
// `getAuthUserId` (users.ts) resolves `identity.subject` to a `users._id`, so
// every mutation below runs the SAME authenticated code path the browser uses.
//
// Usage (from project root):
//   bunx convex dev --once   # deploy this file first
//   ID=$(bunx convex run e2e:createTestUser | jq -r .userId)
//   bunx convex run game:ensurePlayer --identity "{\"subject\":\"$ID\"}"
//   bunx convex run game:buyBase       --identity "{\"subject\":\"$ID\"}"
//   ... let the cron drive the robot ...
//   bunx convex run game:queueProcessing --identity "{\"subject\":\"$ID\"}"
//   ... verify rewardLedger via --inline-query ...
//   bunx convex run e2e:cleanup --args "{\"userId\":\"$ID\"}"   # optional

import { v } from "convex/values";
import { mutation } from "./_generated/server";

/** Create an isolated test user (no auth provider session needed). */
export const createTestUser = mutation({
  args: {},
  handler: async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: "e2e-burn-tester",
      isAnonymous: false,
    });
    return { userId: id };
  },
});

/** Remove the test user, its player doc, and its reward-ledger rows. */
export const cleanup = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const player = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (player) {
      const ledger = await ctx.db
        .query("rewardLedger")
        .withIndex("by_player", (q) => q.eq("playerId", player._id))
        .collect();
      for (const row of ledger) await ctx.db.delete(row._id);
      await ctx.db.delete(player._id);
    }
    await ctx.db.delete(userId);
    return { ok: true };
  },
});
