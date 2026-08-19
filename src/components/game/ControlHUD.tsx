import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  BURN_ZONE_MULTIPLIER,
  MANUAL,
  TOX_PER_TON,
  UPGRADES,
  WORLD,
} from "@/convex/gameParams";
import { fmtKg, fmtTox } from "./format";
import { Battery, AlertTriangle, Zap, Package, Rocket, Trash2, Compass } from "lucide-react";

type Player = Doc<"players">;

export function ControlHUD({
  me,
  onDropCargo,
  onBuyBattery,
}: {
  me: Player | null | undefined;
  onDropCargo: () => void;
  onBuyBattery: () => void;
}) {
  if (!me || !me.hasBase) return null;

  const r = me.robot;
  const bCap = UPGRADES.battery.caps[me.levels.battery - 1];
  const cCap = UPGRADES.cargo.caps[me.levels.cargo - 1];
  const batteryFrac = bCap > 0 ? r.battery / bCap : 0;
  const cargoFrac = cCap > 0 ? r.cargoKg / cCap : 0;

  // Distance to base
  const baseX = me.baseX ?? WORLD.MAP_SIZE / 2;
  const baseY = me.baseY ?? WORLD.MAP_SIZE / 2;
  const distToBase = Math.hypot(r.x - baseX, r.y - baseY);
  const returnEnergy =
    (distToBase / WORLD.TICK_SECONDS) * MANUAL.DRAIN_MOVING *
    ((2 * distToBase) / (MANUAL.MOVE_SPEED)) + 5;

  const isLow = batteryFrac <= MANUAL.LOW_BATTERY_FRAC;
  const isCritical = batteryFrac <= MANUAL.CRITICAL_BATTERY_FRAC;
  const batteryColor = isCritical
    ? "text-red-500"
    : isLow
      ? "text-yellow-400"
      : batteryFrac < 0.6
        ? "text-yellow-300"
        : "text-sky-400";
  const barColor = isCritical
    ? "bg-red-500"
    : isLow
      ? "bg-yellow-400"
      : batteryFrac < 0.6
        ? "bg-yellow-300"
        : "bg-sky-400";

  return (
    <>
      {/* HUD overlay at bottom-left of map */}
      <div className="pointer-events-auto absolute bottom-4 left-4 z-30 flex flex-col gap-2">
        {/* Battery */}
        <div className="rounded-md border border-border bg-background/90 px-3 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <Battery className={`size-4 ${batteryColor}`} />
            <span className={`font-mono text-xs font-bold ${batteryColor}`}>
              {Math.round(r.battery)}/{Math.round(bCap)}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor}`}
              style={{ width: `${Math.min(100, batteryFrac * 100)}%` }}
            />
          </div>
        </div>
        {/* Cargo */}
        <div className="rounded-md border border-border bg-background/90 px-3 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <Package className="size-4 text-primary" />
            <span className="font-mono text-xs font-bold text-foreground">
              {fmtKg(r.cargoKg)}/{fmtKg(cCap)}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${Math.min(100, cargoFrac * 100)}%` }}
            />
          </div>
        </div>
        {/* Distance to base */}
        <div className="rounded-md border border-border bg-background/90 px-3 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <Compass className="size-4 text-muted-foreground" />
            <span className="font-mono text-[10px] text-muted-foreground">
              Base: {Math.round(distToBase)}m
            </span>
          </div>
        </div>
      </div>

      {/* Low Battery Warning */}
      <AnimatePresence>
        {isLow && !isCritical && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="pointer-events-none absolute top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2"
          >
            <div className="animate-blink rounded-md border border-yellow-400/60 bg-yellow-400/15 px-6 py-3 text-center backdrop-blur">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-yellow-400" />
                <span className="font-mono text-sm font-bold tracking-wider text-yellow-300">
                  BATARYA AZALDI!
                </span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-yellow-300/80">
                {Math.round(r.battery)}/{Math.round(bCap)} — Base&apos;e dön veya Extra Battery al
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Critical Battery Decision Modal */}
      <AnimatePresence>
        {isCritical && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="mx-4 w-full max-w-sm rounded-lg border border-red-500/50 bg-card p-6"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-md bg-red-500/15">
                  <AlertTriangle className="size-5 text-red-400" />
                </span>
                <div>
                  <h2 className="font-mono text-sm font-bold tracking-wider text-red-400">
                    KRİTİK BATARYA
                  </h2>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {Math.round(r.battery)}/{Math.round(bCap)} — %{Math.round(batteryFrac * 100)}
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <span>Base mesafesi:</span>
                  <span className="font-mono text-foreground">{Math.round(distToBase)}m</span>
                </div>
                <div className="flex justify-between">
                  <span>Gidiş enerjisi:</span>
                  <span className="font-mono text-foreground">
                    ~{Math.round(returnEnergy)}
                  </span>
                </div>
              </div>

              <div className="mt-5 space-y-3">
                {/* Option A: Drop Cargo */}
                <button
                  type="button"
                  onClick={onDropCargo}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-yellow-400/50 bg-yellow-400/10 px-4 py-3 text-left transition-colors hover:bg-yellow-400/20"
                >
                  <Trash2 className="size-4 text-yellow-400" />
                  <div>
                    <p className="text-sm font-bold text-yellow-300">CARGO&apos;YU BIRAK</p>
                    <p className="font-mono text-[10px] text-yellow-300/70">
                      {fmtKg(r.cargoKg)} waste kaybolur · Base&apos;e dönebilirsin
                    </p>
                  </div>
                </button>

                {/* Option B: Buy Extra Battery */}
                <button
                  type="button"
                  onClick={onBuyBattery}
                  disabled={me.toxBalance < MANUAL.EXTRA_BATTERY_COST_TOX}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-sky-400/50 bg-sky-400/10 px-4 py-3 text-left transition-colors hover:bg-sky-400/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Zap className="size-4 text-sky-300" />
                  <div>
                    <p className="text-sm font-bold text-sky-300">
                      EXTRA BATTERY AL
                    </p>
                    <p className="font-mono text-[10px] text-sky-300/70">
                      -{MANUAL.EXTRA_BATTERY_COST_TOX} TOX · +{MANUAL.EXTRA_BATTERY_UNITS} battery · Cargo korunur
                    </p>
                  </div>
                </button>
              </div>

              <p className="mt-3 font-mono text-[9px] text-muted-foreground">
                Battery Failure = TBD — batarya tamamen 0&apos;a indiğinde ne olacağı test aşamasında.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Controls Legend */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-30 rounded-md border border-border bg-background/90 px-3 py-2 backdrop-blur">
        <p className="font-mono text-[10px] font-bold text-muted-foreground">KONTROLLER</p>
        <div className="mt-1 flex gap-1">
          <div className="grid grid-cols-3 gap-0.5">
            <span />
            <kbd className="flex size-6 items-center justify-center rounded border border-border bg-muted font-mono text-[10px]">
              W
            </kbd>
            <span />
            <kbd className="flex size-6 items-center justify-center rounded border border-border bg-muted font-mono text-[10px]">
              A
            </kbd>
            <kbd className="flex size-6 items-center justify-center rounded border border-border bg-muted font-mono text-[10px]">
              S
            </kbd>
            <kbd className="flex size-6 items-center justify-center rounded border border-border bg-muted font-mono text-[10px]">
              D
            </kbd>
          </div>
        </div>
        <p className="mt-1 font-mono text-[9px] text-muted-foreground">
          Cluster yakınında E = topla
        </p>
      </div>
    </>
  );
}
