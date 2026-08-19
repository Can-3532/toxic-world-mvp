import { useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BURN_ZONE_MULTIPLIER, TOX_PER_TON, WORLD, type UpgradeTrack } from "@/convex/gameParams";
import { useAuth } from "@/hooks/use-auth";
import { useKeyboardControl } from "@/hooks/useKeyboardControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorldMap } from "@/components/game/WorldMap";
import { Panels } from "@/components/game/Panels";
import { ControlHUD } from "@/components/game/ControlHUD";
import { fmtKg, fmtSol, fmtTox } from "@/components/game/format";
import { toast } from "sonner";
import { Biohazard, Coins, Flame, Gamepad2, House, Loader2, LogOut, Skull, Zap } from "lucide-react";
import { Link, useNavigate } from "react-router";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function Game() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const lastFrameRef = useRef(performance.now());

  const me = useQuery(api.game.me);
  const world = useQuery(api.world.worldState);
  const clusters = useQuery(api.world.clusters);
  const leaderboard = useQuery(api.game.leaderboard);
  const events = useQuery(api.world.events);

  const ensurePlayer = useMutation(api.game.ensurePlayer);
  const buyBase = useMutation(api.game.buyBase);
  const commandRobot = useMutation(api.game.commandRobot);
  const toggleAuto = useMutation(api.game.toggleAuto);
  const queueProcessing = useMutation(api.game.queueProcessing);
  const upgrade = useMutation(api.game.upgrade);
  const lockBase = useMutation(api.game.lockBase);
  const unlockBase = useMutation(api.game.unlockBase);
  const activateShield = useMutation(api.game.activateShield);
  const launchBase = useMutation(api.game.launchBase);
  const cancelLaunch = useMutation(api.game.cancelLaunch);
  // Sprint 2.13 — manual driving mutations
  const toggleManualMode = useMutation(api.game.toggleManualMode);
  const moveRobotManual = useMutation(api.game.moveRobotManual);
  const collectManual = useMutation(api.game.collectManual);
  const dropCargo = useMutation(api.game.dropCargo);
  const buyExtraBattery = useMutation(api.game.buyExtraBattery);
  const shipStorage = useMutation(api.game.shipStorage);
  const completeShipment = useMutation(api.game.completeShipment);
  const depositAtBurnZone = useMutation(api.game.depositAtBurnZone);

  const { getDirection, setEnabled, isMoving } = useKeyboardControl();

  useEffect(() => {
    void ensurePlayer().catch((e) => console.error("[game] ensurePlayer:", e));
  }, [ensurePlayer]);

  const isManual = me?.manual ?? false;
  const manualRobotState = me?.robot?.state === "driving";

  // Enable/disable keyboard control — always on while in manual mode
  useEffect(() => {
    setEnabled(isManual);
  }, [isManual, setEnabled]);

  // Manual driving loop: read keys, send movement mutation each frame
  useEffect(() => {
    if (!isManual) return;
    let rafId: number;
    const loop = () => {
      const now = performance.now();
      const dtMs = now - lastFrameRef.current;
      lastFrameRef.current = now;
      const dir = getDirection();
      if (dir.dx !== 0 || dir.dy !== 0) {
        void moveRobotManual({
          dx: dir.dx,
          dy: dir.dy,
          dtMs,
        }).catch(() => {});
      }
      rafId = requestAnimationFrame(loop);
    };
    lastFrameRef.current = performance.now();
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isManual, getDirection, moveRobotManual]);

  const frac = world?.world ? world.world.pollutionKg / world.world.capacityKg : 0;
  const status = world?.world?.status ?? "safe";
  const critical = frac >= WORLD.CRITICAL_FRAC;
  const zone = world?.zone ?? null;
  const zoneActive = zone?.status === "active";
  const protState = me?.protection?.state ?? "normal";
  const sealed = (protState === "locked" || protState === "launching") && !!me?.hasBase;

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const handleCommand = async (clusterId: Id<"wasteClusters">) => {
    if (!me?.hasBase) {
      toast.error("No base", { description: "Deploy your base first." });
      return;
    }
    if (sealed) {
      toast.error("Base sealed", { description: "Unlock your base before commanding the robot." });
      return;
    }
    if (isManual) {
      // In manual mode, try collecting instead
      try {
        await collectManual();
        toast.success("Collected waste");
      } catch (e) {
        toast.error("Collect failed", { description: errMsg(e) });
      }
      return;
    }
    try {
      await commandRobot({ clusterId });
    } catch (e) {
      toast.error("Command rejected", { description: errMsg(e) });
    }
  };

  const handleBuyBase = async () => {
    try {
      await buyBase();
      toast.success("Base deployed", {
        description: "Your robot is online. It will start collecting automatically.",
      });
    } catch (e) {
      toast.error("Deployment failed", { description: errMsg(e) });
    }
  };

  const handleToggleAuto = async () => {
    try {
      await toggleAuto();
    } catch (e) {
      toast.error("Could not toggle", { description: errMsg(e) });
    }
  };

  const handleQueueProcessing = async () => {
    try {
      const res = await queueProcessing();
      toast.success("Processing started", {
        description: `${fmtKg(res.queuedKg)} moved to the burner.`,
      });
    } catch (e) {
      toast.error("Burner offline", { description: errMsg(e) });
    }
  };

  const handleUpgrade = async (track: UpgradeTrack) => {
    try {
      const res = await upgrade({ track });
      toast.success(`${track} upgraded`, {
        description: `Now level ${res.level}.`,
      });
    } catch (e) {
      toast.error("Upgrade failed", { description: errMsg(e) });
    }
  };

  const handleToggleManual = async () => {
    try {
      const res = await toggleManualMode();
      toast.success(
        res.manual ? "Manual mode ON" : "Auto mode ON",
        {
          description: res.manual
            ? "Use WASD / Arrow keys to drive. E to collect nearby waste."
            : "Robot returns to autonomous mode.",
        },
      );
    } catch (e) {
      toast.error("Toggle failed", { description: errMsg(e) });
    }
  };

  const handleCollectManual = async () => {
    try {
      await collectManual();
      toast.success("Collected waste");
    } catch (e) {
      toast.error("Collect failed", { description: errMsg(e) });
    }
  };

  const handleDropCargo = async () => {
    try {
      const res = await dropCargo();
      toast.success("Cargo dropped", { description: `${fmtKg(res.droppedKg)} waste discarded.` });
    } catch (e) {
      toast.error("Drop failed", { description: errMsg(e) });
    }
  };

  const handleBuyBattery = async () => {
    try {
      const res = await buyExtraBattery();
      toast.success("Extra battery", { description: `+${res.battery} battery. Cost: ${res.cost} TOX.` });
    } catch (e) {
      toast.error("Battery failed", { description: errMsg(e) });
    }
  };

  const handleShipStorage = async () => {
    try {
      const res = await shipStorage();
      toast.success("Shipment started", {
        description: `${fmtKg(res.kg)} in transit — 60s to burn.`,
      });
    } catch (e) {
      toast.error("Ship failed", { description: errMsg(e) });
    }
  };

  const handleCompleteShipment = async () => {
    try {
      const res = await completeShipment();
      toast.success("Shipment arrived", {
        description: `${fmtKg(res.queuedKg)} entered the burner.`,
      });
    } catch (e) {
      toast.error("Shipment not ready", { description: errMsg(e) });
    }
  };

  const handleDepositBurnZone = async () => {
    try {
      const res = await depositAtBurnZone();
      toast.success("Direct burn!", {
        description: `${fmtKg(res.burnedKg)} burned → +${Math.floor(res.tox)} TOX (×${res.zoneMultiplier})`,
      });
    } catch (e) {
      toast.error("Burn zone deposit failed", { description: errMsg(e) });
    }
  };

  const handleLockBase = async () => {
    try {
      await lockBase();
      toast.success("Base locked", {
        description: "Sealed — generation stopped, robot parked, stockpile protected.",
      });
    } catch (e) {
      toast.error("Lock failed", { description: errMsg(e) });
    }
  };

  const handleUnlockBase = async () => {
    try {
      await unlockBase();
      toast.success("Base unlocked", { description: "Operations resumed." });
    } catch (e) {
      toast.error("Unlock failed", { description: errMsg(e) });
    }
  };

  const handleActivateShield = async () => {
    try {
      await activateShield();
      toast.success("Toxic Shield active", {
        description: "Your robot is immune to critical-state battery drain for 2h.",
      });
    } catch (e) {
      toast.error("Shield failed", { description: errMsg(e) });
    }
  };

  const handleLaunchBase = async () => {
    try {
      await launchBase();
      toast.success("Launch armed", {
        description: "Base will self-destruct in 5 min unless cancelled.",
      });
    } catch (e) {
      toast.error("Launch failed", { description: errMsg(e) });
    }
  };

  const handleCancelLaunch = async () => {
    try {
      await cancelLaunch();
      toast.success("Launch cancelled", { description: "Base remains sealed." });
    } catch (e) {
      toast.error("Cancel failed", { description: errMsg(e) });
    }
  };

  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-primary" />
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* HEADER */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Biohazard className="size-4" />
            </span>
            <span className="hidden font-mono text-xs font-bold tracking-[0.2em] sm:inline">
              TOXIC<span className="text-primary">WORLD</span>
            </span>
          </Link>

          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`font-mono text-[10px] tracking-widest ${
                critical ? "animate-blink border-red-500/60 text-red-400" : "border-primary/40 text-primary"
              }`}
            >
              {critical ? "CRITICAL" : isManual ? "MANUAL" : zoneActive ? "BURN ZONE" : "WORLD 0 · LIVE"}
            </Badge>
            <div className="hidden h-2 w-24 overflow-hidden rounded-full bg-muted sm:block">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  critical ? "bg-red-500" : frac >= 0.6 ? "bg-yellow-400" : "bg-primary"
                }`}
                style={{ width: `${Math.min(100, frac * 100)}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Manual mode toggle */}
            {me.hasBase && !sealed && (
              <Button
                variant={isManual ? "default" : "outline"}
                size="sm"
                className="cursor-pointer gap-1.5"
                onClick={handleToggleManual}
                title={isManual ? "Switch to auto mode" : "Switch to manual WASD driving"}
              >
                <Gamepad2 className="size-3.5" />
                {isManual ? "MANUAL" : "AUTO"}
              </Button>
            )}
            <span
              title="Simulated demo balance — SOL is used only for the mock base purchase, never for burn rewards"
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs font-bold text-primary"
            >
              <Coins className="size-3.5" />
              {fmtSol(me.solBalance)} SOL*
            </span>
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs font-bold text-yellow-300">
              <Zap className="size-3.5" />
              {fmtTox(me.toxBalance)} TOX
            </span>
            <Button variant="ghost" size="icon" onClick={handleSignOut} title="Sign out" className="cursor-pointer">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
        {(critical || zoneActive) && <div className="hazard-stripes-dark h-1.5 w-full" />}
      </header>

      {/* SEALED BANNER */}
      {sealed && (
        <div className="animate-blink border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-center font-mono text-xs font-bold tracking-[0.2em] text-red-400">
          BASE SEALED — {protState === "launching" ? "EMERGENCY LAUNCH COUNTDOWN ACTIVE" : "GENERATION OFF · ROBOT PARKED · STOCKPILE PROTECTED"}. OPEN THE DEFENSE TAB.
        </div>
      )}

      {/* CRITICAL / BURN ZONE BANNER */}
      {critical && (
        <div className="animate-blink border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-center font-mono text-xs font-bold tracking-[0.2em] text-red-400">
          WORLD CRITICAL — POLLUTION ABOVE 90%. BURN WASTE OR EVERYTHING COLLAPSES.
        </div>
      )}
      {zoneActive && zone && !critical && (
        <div className="border-b border-yellow-400/40 bg-yellow-400/10 px-4 py-2 text-center font-mono text-xs font-bold tracking-[0.18em] text-yellow-300">
          BURN ZONE ACTIVE at ({Math.round(zone.x)}, {Math.round(zone.y)}) — x{BURN_ZONE_MULTIPLIER} TOX
          rewards ({Math.round(TOX_PER_TON * BURN_ZONE_MULTIPLIER)} / t) ·{" "}
          {Math.max(0, Math.ceil((zone.expiresAt - Date.now()) / 1000))}s left
        </div>
      )}

      {/* MANUAL MODE BANNER */}
      {isManual && me.hasBase && (
        <div className="border-b border-sky-400/40 bg-sky-400/10 px-4 py-2 text-center font-mono text-xs font-bold tracking-[0.18em] text-sky-300">
          MANUAL MODE — WASD/ARROWS to drive · E to collect nearby waste · Drive to base to unload
        </div>
      )}

      {/* MAIN */}
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* MAP */}
        <div className="relative">
          <WorldMap clusters={clusters ?? []} me={me} zone={zone} onCommand={handleCommand} isManual={isManual} />

          {/* Manual mode HUD overlay */}
          {isManual && me.hasBase && (
            <ControlHUD
              me={me}
              onDropCargo={handleDropCargo}
              onBuyBattery={handleBuyBattery}
            />
          )}

          {/* no-base overlay */}
          {!me.hasBase && (
            <div className="absolute inset-0 z-40 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm">
              <div className="mx-4 w-full max-w-sm rounded-lg border border-primary/50 bg-card p-6 text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <House className="size-6" />
                </span>
                <h2 className="mt-4 text-xl font-bold tracking-tight">Deploy your base</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Your outpost generates <span className="text-foreground">50 kg/h</span> into the global
                  waste pool and houses your robot. Price:{" "}
                  <span className="font-mono font-bold text-primary">0.1 SOL</span>.
                </p>
                <div className="mt-4 flex items-center justify-center gap-2 font-mono text-xs text-muted-foreground">
                  <Coins className="size-3.5" />
                  Balance: {fmtSol(me.solBalance)} SOL
                </div>
                <Button
                  className="mt-4 w-full cursor-pointer gap-2"
                  size="lg"
                  disabled={me.solBalance < WORLD.BASE_PRICE_SOL}
                  onClick={handleBuyBase}
                >
                  <House className="size-4" />
                  Buy base — {WORLD.BASE_PRICE_SOL} SOL
                </Button>
                <p className="mt-3 font-mono text-[10px] leading-4 text-muted-foreground">
                  SIMULATED PURCHASE — no wallet, no transaction, no real funds. Genesis grant already on
                  your ledger. Burn rewards pay TOX only.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* PANELS */}
        <Panels
          me={me}
          world={world ?? undefined}
          leaderboard={leaderboard ?? undefined}
          events={events ?? undefined}
          onToggleAuto={handleToggleAuto}
          onQueueProcessing={handleQueueProcessing}
          onUpgrade={handleUpgrade}
          onLockBase={handleLockBase}
          onUnlockBase={handleUnlockBase}
          onActivateShield={handleActivateShield}
          onLaunchBase={handleLaunchBase}
          onCancelLaunch={handleCancelLaunch}
          onToggleManual={handleToggleManual}
          onShipStorage={handleShipStorage}
          onCompleteShipment={handleCompleteShipment}
        />
      </main>

      <footer className="border-t border-border px-4 py-3">
        <p className="mx-auto flex max-w-7xl items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>
            SIM · 1 tick = 1 game minute · robot speed 6 m/s · rewards {TOX_PER_TON} TOX/t, Burn Zone x
            {BURN_ZONE_MULTIPLIER} ({Math.round(TOX_PER_TON * BURN_ZONE_MULTIPLIER)} TOX/t)
          </span>
          <span className="hidden items-center gap-1 sm:flex">
            <Flame className="size-3 text-yellow-400" />
            {fmtTox(me.toxBalance)} TOX · <Skull className="size-3 text-red-500" />
            {user?.name ?? "Scavenger"}
          </span>
        </p>
      </footer>
    </div>
  );
}
