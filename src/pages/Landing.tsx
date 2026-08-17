import { motion } from "framer-motion";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  ArrowRight,
  Battery,
  Biohazard,
  Bot,
  ChevronRight,
  Coins,
  Factory,
  Flame,
  Globe,
  Package,
  Radiation,
  ShieldAlert,
  Skull,
  Trash2,
  TrendingUp,
  Users,
  Warehouse,
  Zap,
} from "lucide-react";
import { Link } from "react-router";

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: "easeOut" as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};

const LOOP_STEPS = [
  { icon: Factory, title: "Base", text: "0.1 SOL — deploys your collection outpost and 50 kg/h waste generator." },
  { icon: Bot, title: "Robot", text: "20 kg cargo, 100 battery. Your only hands in the wasteland." },
  { icon: Globe, title: "Global Waste Pool", text: "Every base feeds one shared pool. 10% starts collectable." },
  { icon: Trash2, title: "Collect", text: "Robots race to clusters (150–900 kg). First come, first reserved." },
  { icon: Warehouse, title: "Storage", text: "Hauled waste piles up — storage pressure is real." },
  { icon: Flame, title: "Process → Burn", text: "Only burning removes waste from the world. 2 kg/s." },
  { icon: Coins, title: "TOX Reward", text: "500 TOX per ton burned — 600 inside an active Burn Zone. TOX only, never SOL." },
  { icon: TrendingUp, title: "TOX → Upgrade", text: "Cargo, battery, recharge, storage. Grow your throughput." },
] as const;

const WORLD_RULES = [
  {
    icon: ShieldAlert,
    title: "90% — Critical",
    text: "No countdown. The world just keeps choking. Every base still generates waste, so it only gets worse.",
  },
  {
    icon: Skull,
    title: "100% — Collapse",
    text: "World 0 dies. The pool resets at 22.5% and a new world cycle begins for everyone.",
  },
  {
    icon: Activity,
    title: "Dynamic Replenishment",
    text: "Model C: replenishment = clip(0.05 × demand/generation, 0.05, 0.09). More demand, richer pool.",
  },
  {
    icon: Bot,
    title: "Batch / Reservation",
    text: "Clusters are reserved per robot. Low-level players always get a fair slice of the pool.",
  },
] as const;

const ROADMAP = [
  { label: "Game Design v0.3", pct: 100 },
  { label: "Economic Simulation", pct: 100 },
  { label: "Backend Spatial Engine", pct: 100 },
  { label: "Backend API + WebSocket", pct: 100 },
  { label: "Frontend Prototype", pct: 100 },
  { label: "Solana Mock Rail", pct: 100 },
  { label: "Frontend ↔ Backend", pct: 72 },
  { label: "Real Solana Settlement", pct: 18 },
  { label: "Vertical Slice v0.1", pct: 12 },
] as const;

export default function Landing() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const world = useQuery(api.world.worldState);

  const frac = world?.world ? world.world.pollutionKg / world.world.capacityKg : 0;
  const status = world?.world?.status ?? "safe";
  const statusColor =
    status === "critical" ? "text-red-400" : status === "collapsed" ? "text-red-500" : "text-primary";
  const statusLabel =
    status === "critical" ? "WORLD CRITICAL" : status === "collapsed" ? "COLLAPSED" : "WORLD OPERATIONAL";
  const gaugeColor =
    frac >= 0.9 ? "bg-red-500" : frac >= 0.6 ? "bg-yellow-400" : "bg-primary";

  const enterHref = isAuthenticated ? "/game" : "/auth";

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      {/* hazard top bar */}
      <div className="hazard-stripes h-2 w-full opacity-90" />

      {/* ambient background */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/15 blur-[140px]" />
        <div className="absolute bottom-0 right-0 h-[420px] w-[520px] rounded-full bg-yellow-400/8 blur-[120px]" />
        <div className="grid-floor absolute inset-0 opacity-40" />
        <div className="scanlines absolute inset-0 opacity-60" />
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            className="animate-float-up absolute bottom-0 h-1.5 w-1.5 rounded-full bg-primary/70"
            style={{
              left: `${(i * 7.3 + 4) % 100}%`,
              animationDelay: `${i * 0.9}s`,
              animationDuration: `${8 + (i % 5) * 2}s`,
            }}
          />
        ))}
      </div>

      {/* NAV */}
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Biohazard className="size-5" />
          </span>
          <span className="font-mono text-sm font-bold tracking-[0.22em]">
            TOXIC<span className="text-primary">WORLD</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <a href="#loop" className="transition-colors hover:text-foreground">The Loop</a>
          <a href="#rules" className="transition-colors hover:text-foreground">World Rules</a>
          <a href="#economy" className="transition-colors hover:text-foreground">Economy</a>
          <a href="#roadmap" className="transition-colors hover:text-foreground">Roadmap</a>
        </nav>
        <Button asChild className="cursor-pointer gap-1.5">
          <Link to={enterHref}>
            {isAuthenticated ? "Enter the World" : "Get Started"}
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </header>

      {/* HERO */}
      <motion.section
        variants={stagger}
        initial="hidden"
        animate="show"
        className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center px-5 pb-16 pt-14 text-center sm:pt-20"
      >
        <motion.div variants={fadeUp}>
          <Badge variant="outline" className="gap-2 border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] tracking-[0.2em] text-primary">
            <Radiation className="size-3.5 animate-pulse-toxic" />
            MULTIPLAYER SURVIVAL · TOX ECONOMY
          </Badge>
        </motion.div>

        <motion.h1
          variants={fadeUp}
          className="mt-7 max-w-4xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
        >
          The world is drowning.
          <br />
          <span className="text-primary text-glow-toxic">Burn it for TOX.</span>
        </motion.h1>

        <motion.p
          variants={fadeUp}
          className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg"
        >
          Deploy a base, send your robot into the <span className="text-foreground">global waste pool</span>,
          haul clusters back, and burn them in your processing center. Every kg incinerated pays you —
          and every kg you leave behind chokes the world toward collapse.
        </motion.p>

        <motion.div variants={fadeUp} className="mt-9 flex flex-wrap items-center justify-center gap-4">
          <Button asChild size="lg" className="cursor-pointer gap-2 px-7 text-base">
            <Link to={enterHref}>
              {isAuthenticated ? "Deploy your Base" : "Claim 0.1 SOL Grant"}
              <ChevronRight className="size-5" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="cursor-pointer gap-2 px-7 text-base">
            <a href="#loop">How the economy works</a>
          </Button>
        </motion.div>

        {/* LIVE WORLD PANEL */}
        <motion.div variants={fadeUp} className="mt-14 w-full max-w-3xl">
          <div className="rounded-lg border border-border bg-card/80 backdrop-blur">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <span className="flex items-center gap-2 font-mono text-xs font-semibold tracking-[0.18em] text-muted-foreground">
                <span className="size-2 animate-pulse-toxic rounded-full bg-primary" />
                LIVE WORLD TELEMETRY
              </span>
              <span className={`font-mono text-xs font-bold tracking-[0.18em] ${statusColor}`}>
                {statusLabel}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              <div className="bg-card px-5 py-4 text-left">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Pollution</p>
                <p className="mt-1 font-mono text-2xl font-bold text-foreground">
                  {(frac * 100).toFixed(1)}<span className="text-sm text-muted-foreground">%</span>
                </p>
              </div>
              <div className="bg-card px-5 py-4 text-left">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Global Waste</p>
                <p className="mt-1 font-mono text-2xl font-bold text-foreground">
                  {world?.world ? `${(world.world.pollutionKg / 1_000_000).toFixed(2)}` : "—"}
                  <span className="text-sm text-muted-foreground"> kt</span>
                </p>
              </div>
              <div className="bg-card px-5 py-4 text-left">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Collectable Pool</p>
                <p className="mt-1 font-mono text-2xl font-bold text-primary">
                  {world?.world ? `${(world.world.collectableKg / 1000).toFixed(1)}` : "—"}
                  <span className="text-sm text-muted-foreground"> t</span>
                </p>
              </div>
              <div className="bg-card px-5 py-4 text-left">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Active Collectors</p>
                <p className="mt-1 flex items-center gap-2 font-mono text-2xl font-bold text-foreground">
                  {world?.activePlayers ?? "—"}
                  <Users className="size-4 text-muted-foreground" />
                </p>
              </div>
            </div>
            <div className="border-t border-border px-5 py-4">
              <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>World 0 — capacity 10,000 t</span>
                <span>Critical at 90% · Collapse at 100%</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <motion.div
                  className={`h-full rounded-full ${gaugeColor}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, frac * 100)}%` }}
                  transition={{ duration: 1.1, ease: "easeOut" }}
                />
              </div>
            </div>
          </div>
        </motion.div>

        {/* QUICK STATS */}
        <motion.div variants={fadeUp} className="mt-12 grid w-full max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: "Base price", v: "0.1 SOL*" },
            { k: "Starter generation", v: "50 kg/h" },
            { k: "Burn reward", v: "500 TOX / t" },
            { k: "Burn Zone", v: "600 TOX / t" },
          ].map((s) => (
            <div key={s.k} className="rounded-md border border-border/70 bg-card/60 px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{s.k}</p>
              <p className="mt-1 font-mono text-base font-bold text-primary">{s.v}</p>
            </div>
          ))}
        </motion.div>
      </motion.section>

      {/* THE LOOP */}
      <section id="loop" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="text-center"
        >
          <motion.p variants={fadeUp} className="font-mono text-xs font-semibold tracking-[0.28em] text-primary">
            THE LOOP
          </motion.p>
          <motion.h2 variants={fadeUp} className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Everything you earn flows through one circuit
          </motion.h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-60px" }}
          className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {LOOP_STEPS.map((s, i) => (
            <motion.div
              key={s.title}
              variants={fadeUp}
              className="group relative rounded-lg border border-border bg-card/70 p-5 transition-colors hover:border-primary/50"
            >
              <div className="flex items-center justify-between">
                <s.icon className="size-5 text-primary" />
                <span className="font-mono text-[10px] text-muted-foreground">0{i + 1}</span>
              </div>
              <h3 className="mt-4 font-mono text-sm font-bold tracking-wide">{s.title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{s.text}</p>
              {i < LOOP_STEPS.length - 1 && (
                <ChevronRight className="absolute -right-3 top-1/2 hidden size-4 -translate-y-1/2 text-primary/70 lg:block" />
              )}
            </motion.div>
          ))}
        </motion.div>
      </section>

      {/* WORLD RULES */}
      <section id="rules" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="text-center"
        >
          <motion.p variants={fadeUp} className="font-mono text-xs font-semibold tracking-[0.28em] text-yellow-400">
            SURVIVAL PRESSURE
          </motion.p>
          <motion.h2 variants={fadeUp} className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            The world is a shared enemy
          </motion.h2>
          <motion.p variants={fadeUp} className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every base pumps waste into the same pool. Robots compete for clusters. Only burning actually
            cleans the world — and the world collapses if you don&apos;t.
          </motion.p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-60px" }}
          className="mt-12 grid gap-4 sm:grid-cols-2"
        >
          {WORLD_RULES.map((r) => (
            <motion.div
              key={r.title}
              variants={fadeUp}
              className="flex gap-4 rounded-lg border border-border bg-card/70 p-6 transition-colors hover:border-yellow-400/40"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-yellow-400/10 text-yellow-400">
                <r.icon className="size-5" />
              </span>
              <div>
                <h3 className="font-mono text-sm font-bold tracking-wide">{r.title}</h3>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{r.text}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </section>

      {/* ECONOMY */}
      <section id="economy" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="grid items-start gap-10 lg:grid-cols-2"
        >
          <motion.div variants={fadeUp}>
            <p className="font-mono text-xs font-semibold tracking-[0.28em] text-primary">ECONOMY · DESIGN FREEZE v0.4</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Balanced in simulation, verified by invariant
            </h2>
            <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
              The economy was tuned through 1 / 10 / 100 / 1,000 / 10,000 player simulations. Waste
              accounting is invariant-checked to machine precision — what the server burns is exactly
              what left the world.
            </p>
            <div className="mt-6 rounded-md border border-border/70 bg-card/60 p-4 font-mono text-xs leading-6 text-muted-foreground">
              <p className="text-primary">$ spawn = $ collect + $ burn + $ residual</p>
              <p>// mass conservation enforced every tick — no double counting, no mass destruction</p>
            </div>
          </motion.div>

          <motion.div variants={fadeUp} className="overflow-hidden rounded-lg border border-border bg-card/70">
            <div className="border-b border-border px-5 py-3 font-mono text-xs font-semibold tracking-[0.18em] text-muted-foreground">
              FROZEN PARAMETERS
            </div>
            <div className="divide-y divide-border">
              {[
                ["Normal burn reward", "500 TOX / t"],
                ["Burn Zone reward", "600 TOX / t (×1.2)"],
                ["SOL burn reward", "REMOVED (v0.4)"],
                ["World capacity", "10,000 t"],
                ["World 0 starting pollution", "50%"],
                ["World 1+ starting pollution", "22.5%"],
                ["Initial collectable", "10% of global"],
                ["Cluster size", "150 – 900 kg"],
                ["Active clusters", "500"],
                ["Replenishment", "Dynamic Model C"],
                ["Allocation", "Batch / Reservation"],
                ["Cargo L2→L5 (TOX)", "150 / 225 / 340 / 510"],
                ["Recharge L2→L5 (TOX)", "20 / 30 / 45 / 65"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono font-semibold text-foreground">{v}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      </section>

      {/* ROADMAP */}
      <section id="roadmap" className="relative z-10 mx-auto w-full max-w-6xl px-5 py-20">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
          className="text-center"
        >
          <motion.p variants={fadeUp} className="font-mono text-xs font-semibold tracking-[0.28em] text-primary">
            BUILD STATUS
          </motion.p>
          <motion.h2 variants={fadeUp} className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            From design doc to vertical slice
          </motion.h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-60px" }}
          className="mx-auto mt-12 max-w-3xl space-y-3"
        >
          {ROADMAP.map((r) => (
            <motion.div key={r.label} variants={fadeUp} className="flex items-center gap-4">
              <span className="w-56 shrink-0 text-right font-mono text-xs text-muted-foreground">{r.label}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                <motion.div
                  className={`h-full rounded-full ${r.pct >= 100 ? "bg-primary" : r.pct >= 60 ? "bg-yellow-400" : "bg-red-500/80"}`}
                  initial={{ width: 0 }}
                  whileInView={{ width: `${r.pct}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.9, ease: "easeOut" }}
                />
              </div>
              <span className="w-10 shrink-0 font-mono text-xs font-bold text-foreground">{r.pct}%</span>
            </motion.div>
          ))}
        </motion.div>
      </section>

      {/* FINAL CTA */}
      <section className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-24 pt-8">
        <div className="relative overflow-hidden rounded-xl border border-primary/40 bg-card/80 px-6 py-14 text-center">
          <div className="pointer-events-none absolute inset-0 opacity-40">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,color-mix(in_oklch,var(--primary)_25%,transparent),transparent_60%)]" />
          </div>
          <h2 className="relative text-3xl font-bold tracking-tight text-glow-toxic sm:text-5xl">
            Your robot is waiting.
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
            New players receive a <span className="text-foreground">0.1 SOL genesis grant</span> (simulated)
            to deploy their first base in the MVP demo. SOL exists only on the mock entry side — every kg
            burned pays <span className="text-foreground">TOX</span>, not SOL. Real Solana settlement remains
            a future rail.
          </p>
          <div className="relative mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button asChild size="lg" className="cursor-pointer gap-2 px-8 text-base">
              <Link to={enterHref}>
                {isAuthenticated ? "Enter the World" : "Claim Grant & Deploy"}
                <ArrowRight className="size-5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="cursor-pointer gap-2 px-8 text-base">
              <Link to={enterHref}>
                <Flame className="size-5" />
                Start Burning
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="relative z-10 border-t border-border">
        <div className="hazard-stripes h-1.5 w-full opacity-80" />
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 sm:flex-row">
          <div className="flex items-center gap-2">
            <Biohazard className="size-4 text-primary" />
            <span className="font-mono text-xs font-bold tracking-[0.22em]">
              TOXIC<span className="text-primary">WORLD</span>
            </span>
            <span className="ml-2 hidden font-mono text-[10px] text-muted-foreground sm:inline">
              MVP SIMULATION BUILD · v0.1
            </span>
          </div>
          <p className="max-w-md text-center font-mono text-[10px] leading-4 text-muted-foreground sm:text-right">
            WASTE IS NOT REMOVED UNTIL BURNED. NO REAL FUNDS. NO REAL SOLANA YET — MOCK ECONOMY RAIL ACTIVE.
          </p>
        </div>
      </footer>
    </div>
  );
}
