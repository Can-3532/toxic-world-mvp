import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { Doc } from "@/convex/_generated/dataModel";
import type { UpgradeTrack } from "@/convex/gameParams";
import {
  BURN_ZONE_MULTIPLIER,
  PROTECTION,
  REPLENISHMENT,
  TOX_PER_TON,
  UPGRADES,
  WORLD,
} from "@/convex/gameParams";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Battery,
  Coins,
  Flame,
  Gamepad2,
  Lock,
  Package,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Timer,
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
};  const ROBOT_STATE_LABEL: Record<string, string> = {
    idle: "IDLE",
    to_cluster: "EN ROUTE TO CLUSTER",
    collecting: "COLLECTING",
    to_base: "RETURNING HOME",
    unloading: "UNLOADING",
    recharging: "RECHARGING",
    driving: "MANUAL DRIVE",
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
  onLockBase,
  onUnlockBase,
  onActivateShield,
  onLaunchBase,
  onCancelLaunch,
  onToggleManual,
  onShipStorage,
  onCompleteShipment,
}: {
  me: Player | null | undefined;
  world: WorldPanelState | undefined;
  leaderboard: LeaderboardRow[] | undefined;
  events: EventRow[] | undefined;
  onToggleAuto: () => void;
  onQueueProcessing: () => void;
  onUpgrade: (track: UpgradeTrack) => void;
  // Sprint 2.11 — protection systems
  onLockBase: () => void;
  onUnlockBase: () => void;
  onActivateShield: () => void;
  onLaunchBase: () => void;
  onCancelLaunch: () => void;
  // Sprint 2.13 — manual driving + shipment
  onToggleManual: () => void;
  onShipStorage: () => void;
  onCompleteShipment: () => void;
}) {
  const w = world?.world;
  const frac = w ? w.pollutionKg / w.capacityKg : 0;
  const ratio = w && w.generationRateKgH > 0 ? w.demandKgH / w.generationRateKgH : 0;
  const replFrac = Math.min(
    REPLENISHMENT.MAX_FRAC,
    Math.max(REPLENISHMENT.MIN_FRAC, REPLENISHMENT.BASE_FRAC * ratio),
  );

  // live clock for protection countdowns (AFK / shield / launch)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const isManual = me?.manual ?? false;
  const shipping = me?.shipping;
  const shippingActive = shipping?.active ?? false;
  const shippingDone = shippingActive && now >= (shipping?.finishAt ?? 0);
  const storageCap = me ? UPGRADES.storage.caps[me.levels.storage - 1] : 0;
  const cargoCap = me ? UPGRADES.cargo.caps[me.levels.cargo - 1] : 0;
  const batteryCap = me ? UPGRADES.battery.caps[me.levels.battery - 1] : 0;
  const queued = me?.processing.queuedKg ?? 0;

  // Sprint 2.11 — protection state (legacy docs read as NORMAL)
  const prot = me?.protection ?? { state: "normal" as const };
  const sealed = prot.state === "locked" || prot.state === "launching";
  const afk = prot.state === "afk";
  const launching = prot.state === "launching";
  const locked = prot.state === "locked";
  const idleMs = me
    ? Math.max(0, PROTECTION.AFK_AFTER_MS - (now - (me.lastActiveAt ?? me._creationTime)))
    : 0;
  const shieldMsLeft = prot.shieldUntil ? Math.max(0, prot.shieldUntil - now) : 0;
  const launchMsLeft = prot.launchAt ? Math.max(0, prot.launchAt - now) : 0;
  const hms = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };

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
    <Tabs defaultValue={sealed ? "defense" : "base"} className="flex h-full flex-col">
      <TabsList className="grid w-full grid-cols-5">
        <TabsTrigger value="base">Base</TabsTrigger>
        <TabsTrigger value="robot">Robot</TabsTrigger>
        <TabsTrigger value="upgrades">Upgrades</TabsTrigger>
        <TabsTrigger value="defense">Defense</TabsTrigger>
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
            disabled={sealed || !me?.hasBase || (me?.storageKg ?? 0) <= 0}
            title={sealed ? "Base is sealed — unlock it first" : undefined}
            onClick={onQueueProcessing}
          >
            <Flame className="size-4" />
            Process all stored waste
          </Button>
          {/* Sprint 2.13 — Storage Shipment */}
          {isManual && (
            <>
              {!shippingActive && (
                <Button
                  variant="outline"
                  className="mt-2 w-full cursor-pointer gap-2 border-yellow-400/50 text-yellow-300"
                  disabled={sealed || !me?.hasBase || (me?.storageKg ?? 0) <= 0}
                  onClick={onShipStorage}
                >
                  🚚 Ship all to burner (60s)
                </Button>
              )}
              {shippingActive && !shippingDone && (
                <div className="mt-2 rounded-md border border-yellow-400/30 bg-yellow-400/5 px-3 py-2">
                  <p className="font-mono text-[10px] font-bold text-yellow-300">
                    🚚 In transit: {fmtKg(shipping?.kg ?? 0)}
                  </p>
                  <p className="font-mono text-[9px] text-yellow-300/70">
                    {Math.max(0, Math.ceil(((shipping?.finishAt ?? 0) - now) / 1000))}s remaining
                  </p>
                </div>
              )}
              {shippingActive && shippingDone && (
                <Button
                  variant="outline"
                  className="mt-2 w-full cursor-pointer gap-2 border-green-400/50 text-green-300"
                  onClick={onCompleteShipment}
                >
                  ✅ Collect shipment ({fmtKg(shipping?.kg ?? 0)})
                </Button>
              )}
            </>
          )}
          <p className="mt-2 text-center font-mono text-[10px] text-muted-foreground">
            {sealed
              ? "sealed base — the existing burn queue keeps running, new processing is locked"
              : isManual
                ? "manual mode: ship or process · auto mode: process only"
                : "burn rate 2 kg/s · only burning removes waste from the world"}
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
              disabled={sealed || isManual}
              className="cursor-pointer"
            />
          </div>
          <p className="mt-2 text-center font-mono text-[10px] leading-4 text-muted-foreground">
            AUTO: the robot picks the nearest free cluster itself · 42 kg/h starter throughput reference
          </p>
          {/* Manual driving mode toggle */}
          <div className="mt-3 flex items-center justify-between rounded-md border border-border/70 bg-background/50 px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <Gamepad2 className="size-4 text-yellow-300" />
              Manual driving
            </span>
            <Switch
              checked={isManual}
              onCheckedChange={onToggleManual}
              disabled={sealed || me?.robot.state !== "idle"}
              className="cursor-pointer"
            />
          </div>
          {isManual && (
            <p className="mt-2 rounded-md border border-yellow-400/30 bg-yellow-400/5 px-2 py-1.5 font-mono text-[10px] text-yellow-300">
              WASD/Arrow keys · E = collect · Drive to base to unload & recharge
            </p>
          )}
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
                  disabled={maxed || sealed || (me?.toxBalance ?? 0) < cost}
                  title={sealed ? "Base is sealed — unlock it first" : undefined}
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
          &amp; recharge prices follow Design Freeze v0.3 (unchanged in v0.4); storage &amp; battery
          rebalanced in Sprint 2.10.
        </p>
      </TabsContent>

      {/* DEFENSE — Sprint 2.11 protection systems */}
      <TabsContent value="defense" className="mt-3 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* STATUS */}
        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
              <ShieldCheck className="size-4 text-primary" /> BASE STATUS
            </h3>
            <Badge
              variant="outline"
              className={`font-mono text-[10px] ${
                sealed
                  ? "border-red-500/60 text-red-400"
                  : afk
                    ? "border-yellow-400/60 text-yellow-300"
                    : "border-primary/40 text-primary"
              }`}
            >
              {launching
                ? `LAUNCHING · ${hms(launchMsLeft)}`
                : locked
                  ? `LOCKED · ${prot.lockReason === "collapse" ? "COLLAPSE" : "VOLUNTARY"}`
                  : afk
                    ? "AFK"
                    : "NORMAL"}
            </Badge>
          </div>
          <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            {locked && (
              <p className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-red-300">
                🔒 Base sealed{" "}
                {prot.lockReason === "collapse"
                  ? "automatically by the world collapse — your stockpile survived."
                  : "manually — generation stopped, robot parked, stockpile protected."}{" "}
                The existing burn queue keeps running.
              </p>
            )}
            {launching && (
              <p className="rounded-md border border-yellow-400/30 bg-yellow-400/5 px-2 py-1.5 text-yellow-300">
                🚀 Emergency Launch in {hms(launchMsLeft)} — when it completes the base and robot
                are destroyed ({PROTECTION.LAUNCH_FEE_TOX} TOX + 15% treasury). Cancel is free.
              </p>
            )}
            {!sealed && !afk && me?.hasBase && (
              <p className="rounded-md border border-border/60 bg-background/50 px-2 py-1.5">
                <Timer className="mr-1 inline size-3" />
                AFK protection in <span className="font-mono text-foreground">{hms(idleMs)}</span> —
                after 12 h of inactivity your base auto-locks at the next world collapse and keeps its
                stockpile.
              </p>
            )}
            {afk && me?.hasBase && (
              <p className="rounded-md border border-yellow-400/30 bg-yellow-400/5 px-2 py-1.5 text-yellow-300">
                ⚠ Base is AFK (12 h idle). It still generates and collects on autopilot, but at the next
                world collapse it auto-locks — any action brings it back to NORMAL.
              </p>
            )}
          </div>
        </div>

        {/* LOCK / LAUNCH */}
        <div className="rounded-lg border border-border bg-card/70 p-4">
          <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
            <Lock className="size-4 text-red-400" /> BASE LOCK / EMERGENCY LAUNCH
          </h3>
          {!sealed && (
            <>
              <Button
                variant="outline"
                className="mt-3 w-full cursor-pointer gap-2"
                disabled={!me?.hasBase}
                onClick={onLockBase}
              >
                <Lock className="size-4" />
                Lock base (free)
              </Button>
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                Seals your base: generation off, robot parked, storage/cargo preserved through world
                collapse. Unlocking costs {PROTECTION.UNLOCK_COST_TOX} TOX.
              </p>
            </>
          )}
          {locked && (
            <>
              <Button
                className="mt-3 w-full cursor-pointer gap-2"
                disabled={(me?.toxBalance ?? 0) < PROTECTION.UNLOCK_COST_TOX}
                onClick={onUnlockBase}
              >
                <Lock className="size-4" />
                Unlock base — {PROTECTION.UNLOCK_COST_TOX} TOX
              </Button>
              <Button
                variant="destructive"
                className="mt-2 w-full cursor-pointer gap-2"
                disabled={(me?.toxBalance ?? 0) < PROTECTION.LAUNCH_FEE_TOX}
                onClick={onLaunchBase}
              >
                <Rocket className="size-4" />
                Emergency Launch — {PROTECTION.LAUNCH_FEE_TOX} TOX + 15% treasury
              </Button>
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                Launch destroys the base and robot in {Math.round(PROTECTION.LAUNCH_WINDOW_MS / 60000)}{" "}
                min but you keep your TOX and get a re-entry grant. Costs are charged at completion;
                cancel is free.
              </p>
            </>
          )}
          {launching && (
            <Button
              variant="outline"
              className="mt-3 w-full cursor-pointer gap-2"
              onClick={onCancelLaunch}
            >
              <Rocket className="size-4" />
              Cancel launch (free)
            </Button>
          )}
        </div>

        {/* TOXIC SHIELD */}
        <div className="rounded-lg border border-border bg-card/70 p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">
              <ShieldCheck className="size-4 text-sky-400" /> TOXIC SHIELD
            </h3>
            <Badge
              variant="outline"
              className={`font-mono text-[10px] ${
                shieldMsLeft > 0 ? "border-sky-400/60 text-sky-300" : "text-muted-foreground"
              }`}
            >
              {shieldMsLeft > 0 ? `ACTIVE · ${hms(shieldMsLeft)}` : "INACTIVE"}
            </Badge>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
            While the world is CRITICAL (≥90%), an unshielded robot drains battery ×
            {PROTECTION.CRITICAL_DRAIN_MULT} in the field. A shield makes you immune for{" "}
            {Math.round(PROTECTION.SHIELD_DURATION_MS / 3_600_000)} h. It never stops the world from
            collapsing.
          </p>
          <Button
            variant="outline"
            className="mt-3 w-full cursor-pointer gap-2"
            disabled={sealed || !me?.hasBase || (me?.toxBalance ?? 0) < PROTECTION.SHIELD_COST_TOX}
            onClick={onActivateShield}
          >
            <ShieldCheck className="size-4" />
            Activate shield — {PROTECTION.SHIELD_COST_TOX} TOX
          </Button>
        </div>

        <p className="px-1 font-mono text-[10px] leading-4 text-muted-foreground">
          PROTECTION v0.1 — costs/durations are [PLAYTEST] placeholders
          (TOXIC_WORLD_PROTECTION_SYSTEMS_v0.1.md). Treasury −15% is a mock world vault.
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
            <StatRow
              label="Treasury (mock)"
              value={`${fmtTox(w?.treasuryTox ?? 0)} TOX`}
              accent="text-muted-foreground"
            />
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
