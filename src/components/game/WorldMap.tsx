import { motion } from "framer-motion";
import { Bot, House } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { WORLD } from "@/convex/gameParams";
import { fmtKg } from "./format";

type Cluster = Doc<"wasteClusters">;
type Player = Doc<"players">;

function clusterSize(kg: number): number {
  return Math.min(24, Math.max(9, Math.sqrt(kg) * 0.62));
}

function clusterClass(kg: number): string {
  if (kg > 600) return "bg-yellow-400/80 border-yellow-300/90";
  if (kg > 350) return "bg-lime-400/70 border-lime-300/80";
  return "bg-primary/60 border-primary/80";
}

export function WorldMap({
  clusters,
  me,
  onCommand,
}: {
  clusters: Cluster[];
  me: Player | null | undefined;
  onCommand: (clusterId: Cluster["_id"]) => void;
}) {
  const robot = me?.robot;
  const robotBusy = robot ? robot.state !== "idle" : false;
  const xPct = (v: number) => `${(v / WORLD.MAP_SIZE) * 100}%`;

  return (
    <div className="grid-floor relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-background sm:aspect-[16/10]">
      {/* subtle toxic haze */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_60%,color-mix(in_oklch,var(--primary)_10%,transparent),transparent_65%)]" />
      <div className="scanlines pointer-events-none absolute inset-0 opacity-40" />

      {/* clusters */}
      {clusters.map((c) => {
        const size = clusterSize(c.kg);
        const isTarget = me?.robot.targetClusterId === c._id;
        const isReserved = !!c.reservedBy;
        const disabled = !me?.hasBase || robotBusy || isReserved;
        return (
          <button
            key={c._id}
            type="button"
            title={`${fmtKg(c.kg)} waste${isReserved ? " — reserved" : ""}`}
            onClick={() => onCommand(c._id)}
            disabled={disabled}
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border transition-transform ${clusterClass(
              c.kg,
            )} ${isTarget ? "z-20 scale-125 ring-2 ring-primary" : isReserved ? "z-10 opacity-60" : "z-10 hover:scale-125 cursor-pointer"}`}
            style={{ left: xPct(c.x), top: xPct(c.y), width: size, height: size }}
          />
        );
      })}

      {/* base */}
      {me?.hasBase && me.baseX != null && me.baseY != null && (
        <div
          className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
          style={{ left: xPct(me.baseX), top: xPct(me.baseY) }}
          title="Your base"
        >
          <span className="flex size-9 items-center justify-center rounded-md border border-primary/60 bg-card/90 text-primary">
            <House className="size-5" />
          </span>
          <span className="absolute -bottom-1 left-1/2 h-1.5 w-8 -translate-x-1/2 rounded-full bg-primary/40 blur-[2px]" />
        </div>
      )}

      {/* robot */}
      {robot && me?.hasBase && (
        <motion.div
          initial={false}
          animate={{ left: xPct(robot.x), top: xPct(robot.y) }}
          transition={{ duration: 1.9, ease: "linear" }}
          className="absolute z-30 -translate-x-1/2 -translate-y-1/2"
          title={`Robot — ${robot.state.replace("_", " ")}`}
        >
          <span
            className={`flex size-7 items-center justify-center rounded-md border ${
              robot.state === "recharging"
                ? "border-sky-400/70 bg-sky-400/15 text-sky-300"
                : robotBusy
                  ? "border-yellow-400/70 bg-yellow-400/15 text-yellow-300"
                  : "border-primary bg-primary/20 text-primary"
            }`}
          >
            <Bot className="size-4 animate-pulse-toxic" />
          </span>
        </motion.div>
      )}

      {/* legend */}
      <div className="absolute bottom-2 left-2 z-20 flex items-center gap-3 rounded-md border border-border/70 bg-background/80 px-3 py-1.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-primary/70" /> waste cluster
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-yellow-400/80" /> big score
        </span>
        <span className="flex items-center gap-1.5">
          <House className="size-3 text-primary" /> base
        </span>
      </div>
    </div>
  );
}
