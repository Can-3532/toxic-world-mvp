export function fmtKg(kg: number): string {
  if (kg >= 1_000_000) return `${(kg / 1_000_000).toFixed(2)} kt`;
  if (kg >= 1_000) return `${(kg / 1_000).toFixed(2)} t`;
  return `${Math.round(kg)} kg`;
}

export function fmtTons(kg: number): string {
  return (kg / 1_000_000).toFixed(2);
}

export function fmtSol(sol: number): string {
  if (sol === 0) return "0";
  if (sol >= 0.1) return sol.toFixed(3);
  return sol.toFixed(6).replace(/\.?0+$/, "");
}

export function fmtTox(tox: number): string {
  return Math.floor(tox).toLocaleString();
}

export function fmtTimeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
