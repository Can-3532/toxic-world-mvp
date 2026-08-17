import { cronJobs } from "convex/server";
import { api } from "./_generated/api";
import { WORLD } from "./gameParams";

const crons = cronJobs();

// The world simulation advances every TICK_SECONDS (each tick = 1 game minute).
crons.interval(
  "toxic-world-tick",
  { seconds: WORLD.TICK_SECONDS },
  api.world.tick,
);

export default crons;
