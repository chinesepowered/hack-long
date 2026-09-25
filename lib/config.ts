import { execSync } from "node:child_process";
import path from "node:path";

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name).toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

export const config = {
  // Runtime media directory; excluded from build tracing on purpose.
  dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), env("DATA_DIR", "data")),
  rawtree: {
    apiKey: env("RAWTREE_API_KEY"),
    database: env("RAWTREE_DATABASE", "breakout"),
    baseUrl: env("RAWTREE_BASE_URL", "https://api.rawtree.com"),
  },
  nimble: {
    apiKey: env("NIMBLE_API_KEY"),
    // "low" finishes in 10-30s (good for live demos); "medium" takes 1-3 min.
    effort: env("NIMBLE_EFFORT", "low") as "low" | "medium" | "high",
    agentName: env("NIMBLE_AGENT_NAME", "breakout-desk"),
  },
  bfl: {
    apiKey: env("BFL_API_KEY"),
    baseUrl: env("BFL_BASE_URL", "https://api.bfl.ai"),
    draft: bool("FLUX_DRAFT", true),
    duration: num("FLUX_DURATION", 12),
    resolution: env("FLUX_RESOLUTION", "hd"),
    // Credits are shared with other projects: auto-detected stories air as text unless this is on,
    // and all FLUX spend (videos and final cuts) is capped per rolling 24 hours.
    autoVideo: bool("FLUX_AUTO_VIDEO", false),
    dailyBudgetCredits: num("FLUX_DAILY_BUDGET_CREDITS", 800),
  },
  anchor: {
    id: env("ANCHOR_ID", "scout"),
    name: env("ANCHOR_NAME", "Scout"),
  },
  llm: {
    // Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Together, a local server...
    baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1"),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL"),
    structured: bool("LLM_STRUCTURED_OUTPUTS", true),
  },
  local: {
    // Liquid LFM2.5 running on this machine behind an OpenAI-compatible server (Ollama, llama.cpp).
    baseUrl: env("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1"),
    model: env("LOCAL_LLM_MODEL", "hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF"),
    label: env("LOCAL_LLM_LABEL", "LFM2.5-1.2B"),
    structured: bool("LOCAL_LLM_STRUCTURED_OUTPUTS", true),
  },
  worker: {
    backfillHours: num("BACKFILL_HOURS", 24),
    ingestEverySec: num("INGEST_EVERY_SECONDS", 600),
    trackEverySec: num("TRACK_EVERY_SECONDS", 120),
    detectEverySec: num("DETECT_EVERY_SECONDS", 120),
    candidateLimit: num("CANDIDATE_LIMIT", 30),
    maxTracked: num("MAX_TRACKED", 40),
    minStars1h: num("MIN_STARS_1H", 15),
    minStars6h: num("MIN_STARS_6H", 40),
    cooldownHours: num("COVER_COOLDOWN_HOURS", 12),
    concurrency: num("STORY_CONCURRENCY", 2),
    autoCover: bool("AUTO_COVER", true),
    maxAutoPerHour: num("MAX_AUTO_BULLETINS_PER_HOUR", 3),
    // "all" keeps streamed hours the same shape as URL-ingested ones; or a comma list of event types.
    gharchiveTypes: env("GHARCHIVE_FALLBACK_TYPES", "all"),
  },
};

let cachedGithubToken: string | undefined;

/** GITHUB_TOKEN, or whatever `gh auth token` returns if the GitHub CLI is logged in. */
export function githubToken(): string {
  if (cachedGithubToken !== undefined) return cachedGithubToken;
  cachedGithubToken = env("GITHUB_TOKEN");
  if (!cachedGithubToken) {
    try {
      cachedGithubToken = execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      cachedGithubToken = "";
    }
  }
  return cachedGithubToken;
}

export const enabled = {
  rawtree: () => Boolean(config.rawtree.apiKey),
  nimble: () => Boolean(config.nimble.apiKey),
  bfl: () => Boolean(config.bfl.apiKey),
  llm: () => Boolean(config.llm.apiKey && config.llm.model),
  github: () => Boolean(githubToken()),
};

/** A repo is a breakout when it is hot in absolute terms and fast relative to its size or age. */
export function isBreakout(entry: { s1h: number; s6h: number; stargazers: number; createdAt: string }): boolean {
  const hot = entry.s1h >= config.worker.minStars1h || entry.s6h >= config.worker.minStars6h;
  const ageDays = (Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000;
  const young = Number.isFinite(ageDays) && ageDays < 120;
  const relative = entry.stargazers < 5000 || entry.s6h / (entry.stargazers + 100) >= 0.002;
  return hot && (young || relative);
}
