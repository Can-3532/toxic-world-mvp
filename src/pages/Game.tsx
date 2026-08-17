import { useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { WORLD, UPGRADES, type UpgradeTrack } from "@/convex/gameParams";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorldMap } from "@/components/game/WorldMap";
import { Panels } from "@/components/game/Panels";
import { fmtKg, fmtSol, fmtTox } from "@/components/game/format";
import { toast } from "sonner";
import {
  Biohazard,
  Coins,
  House,
  Loader2,
  LogOut,
  Skull,
  Zap,
} from "lucide-react";
import { Link, useNavigate } from "react-router";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function Game() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

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

  useEffect(() => {
    void ensurePlayer().catch((e) => console.error("[game] ensurePlayer:", e));
  }, [ensurePlayer]);

  const frac = world?.world ? world.world.pollutionKg / world.world.capacityKg : 0;
  const status = world?.world?.status ?? "safe";
  const critical = frac >= WORLD.CRITICAL_FRAC;

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const handleCommand = async (clusterId: Id<"wasteClusters">) => {
    if (!me?.hasBase) {
      toast.error("No base", { description: "Deploy your base first." });
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
      toast.success(`${UPGRADES[track].label} upgraded`, {
        description: `Now level ${res.level}.`,
      });
    } catch (e) {
      toast.error("Upgrade failed", { description: errMsg(e) });
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
              {critical ? "⚠ CRITICAL" : "WORLD 0 · LIVE"}
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
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs font-bold text-primary">
              <Coins className="size-3.5" />
              {fmtSol(me.solBalance)} SOL
            </span>
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs font-bold text-yellow-300">
              <Zap className="size-3.5" />
              {fmtTox(me.toxBalance)} TOX
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleSignOut}
              title="Sign out"
              className="cursor-pointer"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
        {critical && (
          <div className="hazard-stripes-dark h-1.5 w-full" />
        )}
      </header>

      {/* CRITICAL BANNER */}
      {critical && (
        <div className="animate-blink border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-center font-mono text-xs font-bold tracking-[0.2em] text-red-400">
          ☣ WORLD CRITICAL — POLLUTION ABOVE 90%. BURN WASTE OR EVERYTHING COLLAPSES.
        </div>
      )}

      {/* MAIN */}
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* MAP */}
        <div className="relative">
          <WorldMap clusters={clusters ?? []} me={me} onCommand={handleCommand} />

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
                  MVP DEMO · genesis grant already on your ledger
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
        />
      </main>

      <footer className="border-t border-border px-4 py-3">
        <p className="mx-auto flex max-w-7xl items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>
            SIM · 1 tick = 1 game minute · robot speed 6 m/s · rewards at ${WORLD.REWARD_USD_PER_TON}/ton
          </span>
          <span className="hidden items-center gap-1 sm:flex">
            <Skull className="size-3 text-red-500" />
            {user?.name ?? "Scavenger"}
          </span>
        </p>
      </footer>
    </div>
  );
}

