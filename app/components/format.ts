export const SPONSORS: Record<string, { name: string; color: string }> = {
  rawtree: { name: "RawTree", color: "var(--rawtree)" },
  nimble: { name: "Nimble", color: "var(--nimble)" },
  flux: { name: "FLUX", color: "var(--flux)" },
  liquid: { name: "Liquid", color: "var(--liquid)" },
  github: { name: "GitHub", color: "var(--github)" },
  llm: { name: "Writer", color: "var(--llm)" },
  desk: { name: "Desk", color: "var(--desk)" },
};

export function sponsorOf(key: string) {
  return SPONSORS[key] ?? SPONSORS.desk;
}

export function ago(epochSeconds: number, now = Date.now()): string {
  if (!epochSeconds) return "";
  const seconds = Math.max(0, Math.round(now / 1000 - epochSeconds));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function utcTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(11, 19);
}

export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function full(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
