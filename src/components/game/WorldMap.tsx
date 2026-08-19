import { useRef, useState, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { Bot, Flame, House, Minus, Plus, Crosshair, Maximize2 } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { BURN_ZONE_MULTIPLIER, WORLD } from "@/convex/gameParams";
import { fmtKg } from "./format";

type Cluster = Doc<"wasteClusters">;
type Player = Doc<"players">;
type Zone = Doc<"burnZones">;

function clusterSize(kg: number): number {
  return Math.min(24, Math.max(9, Math.sqrt(kg) * 0.62));
}

function clusterClass(kg: number): string {
  if (kg > 600) return "bg-yellow-400/80 border-yellow-300/90";
  if (kg > 350) return "bg-lime-400/70 border-lime-300/80";
  return "bg-primary/60 border-primary/80";
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.25;
const FOLLOW_ZOOM = 2.5;

export function WorldMap({
  clusters,
  me,
  zone,
  onCommand,
  isManual = false,
}: {
  clusters: Cluster[];
  me: Player | null | undefined;
  zone: Zone | null | undefined;
  onCommand: (clusterId: Cluster["_id"]) => void;
  isManual?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [followRobot, setFollowRobot] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  const robot = me?.robot;
  const robotBusy = robot ? robot.state !== "idle" : false;
  const xPct = (v: number) => `${(v / WORLD.MAP_SIZE) * 100}%`;
  const zoneActive = zone?.status === "active";

  // Auto-enable follow when entering manual mode
  useEffect(() => {
    if (isManual) {
      setFollowRobot(true);
      setScale(FOLLOW_ZOOM);
    } else {
      setFollowRobot(false);
      setScale(1);
      setOffset({ x: 0, y: 0 });
    }
  }, [isManual]);

  // Follow robot: update offset to center robot on screen
  useEffect(() => {
    if (!followRobot || !robot) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    // Robot position in % of map -> pixels at current scale
    const robotPxX = (robot.x / WORLD.MAP_SIZE) * rect.width * scale;
    const robotPxY = (robot.y / WORLD.MAP_SIZE) * rect.height * scale;
    setOffset({ x: cx - robotPxX, y: cy - robotPxY });
  }, [followRobot, robot?.x, robot?.y, scale]);

  // Mouse wheel zoom (toward cursor)
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale + delta));
      const ratio = newScale / scale;

      setOffset((prev) => ({
        x: mouseX - ratio * (mouseX - prev.x),
        y: mouseY - ratio * (mouseY - prev.y),
      }));
      setScale(newScale);
      setFollowRobot(false);
    },
    [scale],
  );

  // Drag to pan
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Don't start drag if clicking a button (cluster, etc.)
      if ((e.target as HTMLElement).closest("button")) return;
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [offset],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setOffset({ x: dragStart.current.ox + dx, y: dragStart.current.oy + dy });
      setFollowRobot(false);
    },
    [isDragging],
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Zoom buttons
  const zoomIn = () => setScale((s) => Math.min(ZOOM_MAX, s + ZOOM_STEP * 2));
  const zoomOut = () => setScale((s) => Math.max(ZOOM_MIN, s - ZOOM_STEP * 2));
  const zoomReset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setFollowRobot(false);
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="grid-floor relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-background sm:aspect-[16/10]"
      style={{ cursor: isDragging ? "grabbing" : "grab" }}
    >
      {/* Zoomable / pannable content layer */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
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

        {/* burn zone */}
        {zoneActive && zone && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: xPct(zone.x), top: xPct(zone.y) }}
            title={`Burn Zone — ×${zone.multiplier} TOX rewards`}
          >
            <span className="absolute -inset-6 animate-ping rounded-full border border-yellow-400/70" />
            <span className="absolute -inset-3 rounded-full border border-yellow-400/50" />
            <span className="flex size-10 items-center justify-center rounded-full border border-yellow-400/80 bg-yellow-400/20 text-yellow-300 backdrop-blur-sm">
              <Flame className="size-5 animate-pulse-toxic" />
            </span>
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] font-bold tracking-widest text-yellow-300">
              ×{BURN_ZONE_MULTIPLIER} TOX
            </span>
          </div>
        )}

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
            {/* Manual mode direction indicator */}
            {isManual && robot.state === "driving" && (
              <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 font-mono text-[8px] font-bold text-sky-300">
                ●
              </span>
            )}
          </motion.div>
        )}
      </div>

      {/* Zoom controls */}
      <div className="absolute right-2 top-2 z-30 flex flex-col gap-1">
        <button
          type="button"
          onClick={zoomIn}
          title="Zoom in"
          className="flex size-7 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground backdrop-blur transition-colors hover:bg-background hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={zoomOut}
          title="Zoom out"
          className="flex size-7 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground backdrop-blur transition-colors hover:bg-background hover:text-foreground"
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={zoomReset}
          title="Reset view"
          className="flex size-7 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground backdrop-blur transition-colors hover:bg-background hover:text-foreground"
        >
          <Maximize2 className="size-3" />
        </button>
        {isManual && (
          <button
            type="button"
            onClick={() => {
              setFollowRobot((f) => {
                const next = !f;
                if (next) setScale(FOLLOW_ZOOM);
                return next;
              });
            }}
            title={followRobot ? "Unlock camera" : "Follow robot"}
            className={`flex size-7 items-center justify-center rounded-md border backdrop-blur transition-colors ${
              followRobot
                ? "border-sky-400/60 bg-sky-400/15 text-sky-300"
                : "border-border bg-background/90 text-muted-foreground hover:bg-background hover:text-foreground"
            }`}
          >
            <Crosshair className="size-3.5" />
          </button>
        )}
      </div>

      {/* Zoom level indicator */}
      <div className="absolute right-2 bottom-2 z-30 rounded-md border border-border bg-background/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
        {Math.round(scale * 100)}%
      </div>

      {/* legend */}
      <div className="absolute bottom-2 left-2 z-20 flex items-center gap-3 rounded-md border border-border/70 bg-background/80 px-3 py-1.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-primary/70" /> waste cluster
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-yellow-400/80" /> big score
        </span>
        <span className="flex items-center gap-1.5">
          <Flame className="size-3 text-yellow-400" /> burn zone ×{BURN_ZONE_MULTIPLIER}
        </span>
        <span className="flex items-center gap-1.5">
          <House className="size-3 text-primary" /> base
        </span>
      </div>
    </div>
  );
}
