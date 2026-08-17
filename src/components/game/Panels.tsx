import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import type { Doc } from "@/convex/_generated/dataModel";
import type { UpgradeTrack } from "@/convex/gameParams";
import { BURN_ZONE_MULTIPLIER, REPLENISHMENT, TOX_PER_TON, UPGRADES, WORLD } from "@/convex/gameParams";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Battery,
  Coins,
  Flame,
  Package,
  RefreshCw,
  Trash2,
  Trophy,
  Warehouse,
  Zap,
} from "lucide-react";
import { fmtKg, fmtTimeAgo, fmtTox } from "./format";

type Player = Doc<"players">;

const UPGRADE_ICONS: Record<UpgradeTrack, typeof Package> = {
  cargo: Package,
  recharge: Zap,
  battery: Battery,
  storage: Warehouse,
};

const ROBOT_STATE_LABEL: Record<string, string> = {
  idle: "IDLE",
  to_cluster: "EN ROUTE TO CLUSTER",
  collecting: "COLLECTING",
  to_base: "RETURNING HOME",
  unloading: "UNLOADING",
  recharging: "RECHARGING",
};

function Bar({ value, max, className }: { value: number; max: number; className: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full transition-all duration-700 ${className}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono font-semibold ${accent ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

export type WorldPanelState = {
  world: Doc<"worlds"> | null;
  clusterCount?: number;
  zone?: Doc<"burnZones"> | null;
};

export type LeaderboardRow = {
  name: string;
  burnedKg: number;
  toxEarned: number;
};

export type EventRow = {
  type: string;
  message: string;
  at: number;
};

export function Panels({
  me,
  world,
  leaderboard,
  events,
  onToggleAuto,
  onQueueProcessing,
  onUpgrade,
}: {
  me: Player | null | undefined;
  world: WorldPanelState | undefined;
  leaderboard: LeaderboardRow[] | undefined;
  events: EventRow[] | undefined;
  onToggleAuto: () => void;
  onQueueProcessing: () => void;
  onUpgrade: (track: UpgradeTrack) => void;
}) {
  const w = world?.world;
  const frac = w ? w.pollutionKg / w.capacityKg : 0;
  const ratio = w && w.generationRateKgH > 0 ? w.demandKgH / w.generationRateKgH : 0;
  const replFrac = Math.min(
    REPLENISHMENT.MAX_FRAC,
    Math.max(REPLENISHMENT.MIN_FRAC, REPLENISHMENT.BASE_FRAC * ratio),
  );

  const storageCap = me ? UPGRADES.storage.caps[me.levels.storage - 1] : 0;
  const cargoCap = me ? UPGRADES.cargo.caps[me.levels.cargo - 1] : 0;
  const batteryCap = me ? UPGRADES.battery.caps[me.levels.battery - 1] : 0;
  const queued = me?.processing.queuedKg ?? 0;

  const toxLifetime = (me?.toxFromNormal ?? 0) + (me?.toxFromZone ?? 0);

  // "TOX earned this session" = rewards landed while this page is open
  const sessionStart = useRef<number | null>(null);
  useEffect(() => {
    if (me && sessionStart.current === null) {
      sessionStart.current = (me.toxFromNormal ?? 0) + (me.toxFromZone ?? 0);
    }
  }, [me]);
  const sessionTox = Math.max(0, toxLifetime - (sessionStart.current ?? 0));

  const zoneActive = world?.zone?.status === "active";
  const zoneUntil = world?.zone?.expiresAt ?? 0;

  return (
    <Tabs defaultValue="base" className="flex h-full flex-col">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="base">Base</TabsTrigger>
        <TabsTrigger value="robot">Robot</TabsTrigger>
        <TabsTrigger value="upgrades">Upgrades</TabsTrigger>
        <TabsTrigger value="world">World</TabsTrigger>
      </TabsList>

      {/* BURN ZONE ALERT */}
      {zoneActive && (
        <div className="mt-3 animate-blink rounded-md border border-yellow-400/60 bg-yellow-400/10 px-3 py-2 text-center font-mono text-[10px] font-bold tracking-[0.14em] text-yellow-300">
          🔥 BURN ZONE ACTIVE — {TOX_PER_TON * BURN_ZONE_MULTIPLIER} TOX / t (×{BURN_ZONE_MULTIPLIER}) until{" "}
          {Math.max(0, Math.ceil((zoneUntil - Date.now()) / 1000))}s
        </div>
      )}

      {/* BASE */}
      <TabsContent value="base" className="mt-3 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
              <Warehouse className="size-4 text-primary" /> STORAGE
            </h3>
            <span className="font-mono text-xs text-muted-foreground">
              {fmtKg(me?.storageKg ?? 0)} / {fmtKg(storageCap)}
            </span>
          </div>
          <div className="mt-2">
            <Bar value={me?.storageKg ?? 0} max={storageCap} className="bg-primary" />
          </div>
          <Button
            variant="outline"
            className="mt-3 w-full cursor-pointer gap-2"
            disabled={!me?.hasBase || (me?.storageKg ?? 0) <= 0}
            onClick={onQueueProcessing}
          >
            <Flame className="size-4" />
            Process all stored waste
          </Button>
          <p className="mt-2 text-center font-mono text-[10px] text-muted-foreground">
            burn rate 2 kg/s · only burning removes waste from the world
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
              <Flame className="size-4 text-yellow-400" /> BURN QUEUE
            </h3>
            <span className="font-mono text-xs font-bold text-yellow-400">{fmtKg(queued)}</span>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            {queued > 0
              ? `Burning… ~${Math.max(1, Math.ceil(queued / WORLD.PROCESSING_KG_PER_S))}s to settle TOX rewards.`
              : "Nothing in the burner. Process stored waste to earn TOX."}
          </p>
          {queued > 0 && (
            <div className="mt-2">
              <Bar value={queued} max={queued} className="bg-yellow-400" />
            </div>
          )}
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
            <span>normal: {TOX_PER_TON} TOX / t</span>
            <span className="text-yellow-400">
              burn zone: {Math.round(TOX_PER_TON * BURN_ZONE_MULTIPLIER)} TOX / t
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-4">
          <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
            <Zap className="size-4 text-yellow-300" /> TOX ECONOMY
          </h3>
          <div className="mt-2 divide-y divide-border/60">
            <StatRow
              label="Balance"
              value={`${fmtTox(me?.toxBalance ?? 0)} TOX`}
              accent="text-yellow-300"
            />
            <StatRow label="Earned this session" value={`${fmtTox(sessionTox)} TOX`} accent="text-primary" />
            <StatRow label="Earned — normal burns" value={`${fmtTox(me?.toxFromNormal ?? 0)} TOX`} />
            <StatRow
              label="Earned — burn zones"
              value={`${fmtTox(me?.toxFromZone ?? 0)} TOX`}
              accent="text-yellow-400"
            />
            <StatRow label="Collected" value={fmtKg(me?.totalCollectedKg ?? 0)} />
            <StatRow label="Burned" value={fmtKg(me?.totalBurnedKg ?? 0)} />
            <StatRow label="Trips" value={`${me?.robot.totalTrips ?? 0}`} />
          </div>
          <p className="mt-2 border-t border-border/60 pt-2 font-mono text-[10px] leading-4 text-muted-foreground">
            DESIGN FREEZE v0.4 · burn pays TOX only — no SOL rewards, ever. SOL exists only on the (mock)
            base purchase.
          </p>
        </div>
      </TabsContent>

      {/* ROBOT */}
      <TabsContent value="robot" className="mt-3 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
              <Trash2 className="size-4 text-primary" /> UNIT STATUS
            </h3>
            <Badge
              variant="outline"
              className={`border-primary/40 font-mono text-[10px] ${
                me?.robot.state === "recharging"
                  ? "text-sky-300"
                  : me?.robot.state === "idle"
                    ? "text-primary"
                    : "text-yellow-300"
              }`}
            >
              {ROBOT_STATE_LABEL[me?.robot.state ?? "idle"]}
            </Badge>
          </div>
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                <span>CARGO</span>
                <span>
                  {fmtKg(me?.robot.cargoKg ?? 0)} / {fmtKg(cargoCap)}
                </span>
              </div>
              <Bar value={me?.robot.cargoKg ?? 0} max={cargoCap} className="bg-primary" />
            </div>
            <div>
              <div className="mb-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                <span>BATTERY</span>
                <span>
                  {Math.round(me?.robot.battery ?? 0)} / {Math.round(batteryCap)}
                </span>
              </div>
              <Bar
                value={me?.robot.battery ?? 0}
                max={batteryCap}
                className={
                  (me?.robot.battery ?? 0) < batteryCap * 0.25
                    ? "bg-red-500"
                    : (me?.robot.battery ?? 0) < batteryCap * 0.6
                      ? "bg-yellow-400"
                      : "bg-sky-400"
                }
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-md border border-border/70 bg-background/50 px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <RefreshCw className="size-4 text-primary" />
              Autonomous mode
            </span>
            <Switch
              checked={me?.robot.auto ?? true}
              onCheckedChange={onToggleAuto}
              className="cursor-pointer"
            />
          </div>
          <p className="mt-2 text-center font-mono text-[10px] leading-4 text-muted-foreground">
            AUTO: the robot picks the nearest free cluster itself · 42 kg/h starter throughput reference
          </p>
        </div>
      </TabsContent>

      {/* UPGRADES */}
      <TabsContent value="upgrades" className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1">
        {(Object.keys(UPGRADES) as UpgradeTrack[]).map((track) => {
          const cfg = UPGRADES[track];
          const level = me?.levels[track] ?? 1;
          const maxed = level >= 5;
          const cost = maxed ? 0 : cfg.costs[level];
          const Icon = UPGRADE_ICONS[track];
          const rates = "rates" in cfg ? cfg.rates : null;
          const caps = "caps" in cfg ? cfg.caps : null;
          const kgSuffix = track === "storage" || track === "cargo" ? " kg" : "";
          const next =
            track === "recharge" && rates
              ? `${rates[level - 1]}/s → ${rates[level]}/s`
              : caps
                ? `${caps[level - 1]}${kgSuffix} → ${caps[level]}${kgSuffix}`
                : "";
          return (
            <motion.div
              key={track}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-lg border border-border bg-card/70 p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-bold">{cfg.label}</p>
                    <p className="text-[10px] text-muted-foreground">{cfg.description}</p>
                  </div>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">
                  L{level}
                </Badge>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="font-mono text-[11px] text-muted-foreground">{next}</span>
                <Button
                  size="sm"
                  variant={maxed ? "outline" : "default"}
                  disabled={maxed || (me?.toxBalance ?? 0) < cost}
                  className="cursor-pointer gap-1.5"
                  onClick={() => onUpgrade(track)}
                >
                  {maxed ? "MAXED" : (
                    <>
                      <Coins className="size-3.5" />
                      {cost} TOX
                    </>
                  )}
                </Button>
              </div>
            </motion.div>
          );
        })}
        <p className="px-1 font-mono text-[10px] leading-4 text-muted-foreground">
          TOX is earned only by burning waste ({TOX_PER_TON} TOX / t,{" "}
          {Math.round(TOX_PER_TON * BURN_ZONE_MULTIPLIER)} TOX / t inside an active Burn Zone). Cargo
          &amp; recharge prices follow Design Freeze v0.3 (unchanged in v0.4); storage &amp; battery remain
          P1 — open to rebalance after playtests.
        </p>
      </TabsContent>

      {/* WORLD */}
      <TabsContent value="world" className="mt-3 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
              WORLD 0 POLLUTION
            </h3>
            <span
              className={`font-mono text-sm font-bold ${
                frac >= 0.9 ? "animate-blink text-red-500" : frac >= 0.6 ? "text-yellow-400" : "text-primary"
              }`}
            >
              {(frac * 100).toFixed(1)}%
            </span>
          </div>
          <div className="mt-2">
            <Bar
              value={w?.pollutionKg ?? 0}
              max={w?.capacityKg ?? 1}
              className={frac >= 0.9 ? "bg-red-500" : frac >= 0.6 ? "bg-yellow-400" : "bg-primary"}
            />
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
            <span>CRITICAL 90%</span>
            <span className="text-red-500">COLLAPSE 100%</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">BURN ZONE</h3>
            <Badge
              variant="outline"
              className={`font-mono text-[10px] ${
                zoneActive ? "animate-blink border-yellow-400/70 text-yellow-300" : "text-muted-foreground"
              }`}
            >
              {zoneActive ? "ACTIVE ×1.2" : "INACTIVE"}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {zoneActive && world?.zone
              ? `Located at (${Math.round(world.zone.x)}, ${Math.round(world.zone.y)}) — burns there pay ${
                  TOX_PER_TON * BURN_ZONE_MULTIPLIER
                } TOX / t.`
              : "A random shared zone spawns periodically. While active, waste burned inside pays 1.2× the normal TOX rate."}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="divide-y divide-border/60">
            <StatRow label="Global waste" value={fmtKg(w?.pollutionKg ?? 0)} />
            <StatRow label="Collectable pool" value={fmtKg(w?.collectableKg ?? 0)} accent="text-primary" />
            <StatRow label="Hidden reserve" value={fmtKg(w?.hiddenKg ?? 0)} />
            <StatRow label="Base generation" value={`${fmtKg(w?.generationRateKgH ?? 0)}/h`} />
            <StatRow label="Robot demand" value={`${fmtKg(w?.demandKgH ?? 0)}/h`} />
            <StatRow
              label="Replenishment"
              value={`${(replFrac * 100).toFixed(2)}%/h`}
              accent="text-yellow-400"
            />
            <StatRow label="Burned (cycle)" value={fmtKg(w?.burnedKg ?? 0)} />
            <StatRow label="Active clusters" value={`${world?.clusterCount ?? 0}`} />
          </div>
          <p className="mt-2 border-t border-border/60 pt-2 font-mono text-[10px] leading-4 text-muted-foreground">
            MODEL C: repl = clip(0.05 × demand/generation, 5%, 9%) · clusters 150–900 kg · allocation =
            batch/reservation
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-4">
          <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
            <Trophy className="size-4 text-yellow-400" /> TOP COLLECTORS
          </h3>
          <div className="mt-2 divide-y divide-border/60">
            {(leaderboard ?? []).slice(0, 5).map((p, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-4 font-mono text-[10px] text-muted-foreground">#{i + 1}</span>
                  <span className="max-w-[130px] truncate">{p.name}</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {fmtKg(p.burnedKg)} · <span className="text-yellow-300">{fmtTox(p.toxEarned)} TOX</span>
                </span>
              </div>
            ))}
            {(leaderboard ?? []).length === 0 && (
              <p className="py-2 text-xs text-muted-foreground">No collectors yet — be the first.</p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card/70 p-4">
          <h3 className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">EVENT FEED</h3>
          <div className="mt-2 space-y-1.5">
            {(events ?? []).slice(0, 12).map((e, i) => (
              <div key={i} className="flex items-start justify-between gap-2 text-[11px] leading-4">
                <span className="text-muted-foreground">{e.message}</span>
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">
                  {fmtTimeAgo(e.at)}
                </span>
              </div>
            ))}
            {(events ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">Waiting for world activity…</p>
            )}
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}
