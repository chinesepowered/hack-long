import Nimble from "@nimble-way/nimble-js";
import { config } from "./config";

let client: Nimble | null = null;

function nimble(): Nimble {
  if (!config.nimble.apiKey) throw new Error("NIMBLE_API_KEY is not set");
  client ??= new Nimble({ apiKey: config.nimble.apiKey, maxRetries: 2, timeout: 90_000 });
  return client;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ResearchRun {
  runId: string;
  agentId: string;
  interactionId: string;
  effort: string;
}

/**
 * Starts a Web Search Agent run on a named, persistent agent. Reusing the same
 * agent_name means Nimble's own memory of sources and retrieval paths carries
 * across every story the desk researches.
 */
export async function startResearch(input: string, effort = config.nimble.effort): Promise<ResearchRun> {
  const run = await nimble().agents.run({
    input,
    agent_name: config.nimble.agentName,
    effort,
    enable_events: true,
  });
  return { runId: run.id, agentId: run.web_search_agent_id, interactionId: run.interaction_id, effort: run.effort };
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Run events are structured: task_run.state (queued, running, completed) and
 * task_run.progress_stats (sources considered and read, with a sample of URLs).
 */
function eventMessage(event: unknown): string | null {
  if (typeof event === "string") return event.trim() || null;
  if (!event || typeof event !== "object") return null;
  const e = event as {
    type?: string;
    run?: { status?: string };
    source_stats?: { num_sources_considered?: number; num_sources_read?: number; sources_read_sample?: string[] };
    message?: string;
  };
  if (e.type === "task_run.progress_stats" && e.source_stats) {
    const stats = e.source_stats;
    const sample = [...new Set((stats.sources_read_sample ?? []).map(domain))].slice(0, 4).join(", ");
    return `Read ${stats.num_sources_read ?? 0} of ${stats.num_sources_considered ?? 0} sources${sample ? `: ${sample}` : ""}`;
  }
  if (e.type === "task_run.state" && e.run?.status) {
    return e.run.status === "running" ? "Agent is searching and reading the live web" : `Run ${e.run.status}`;
  }
  return typeof e.message === "string" && e.message.trim() ? e.message.trim() : null;
}

/** Live progress over server-sent events. Best effort: polling stays the source of truth. */
export async function followProgress(run: ResearchRun, onMessage: (message: string) => void, signal: AbortSignal) {
  try {
    const stream = await nimble().agents.runs.streamEvents(run.runId, { agent_id: run.agentId }, { signal });
    for await (const event of stream) {
      const message = eventMessage(event);
      if (message) onMessage(message);
    }
  } catch {
    // Stream closed, aborted, or events unavailable for this run.
  }
}

export async function waitForRun(run: ResearchRun, timeoutMs = 20 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await nimble().agents.runs.get(run.runId, { agent_id: run.agentId });
    if (!current.is_active) return current.status;
    await sleep(4000);
  }
  return "timeout";
}

export interface Claim {
  callout: number;
  confidence: string;
  reasoning: string;
  url: string;
  title: string;
  excerpt: string;
  sourceCategory: string;
}

export interface Research {
  content: string;
  confidence: string;
  reasoning: string;
  claims: Claim[];
  sources: { url: string; title: string; type: string; category: string }[];
  raw: unknown;
}

export async function getResearch(run: ResearchRun): Promise<Research> {
  const result = await nimble().agents.runs.result(run.runId, { agent_id: run.agentId });
  if ("error" in result) throw new Error(`Nimble run failed: ${result.error.message}`);
  const output = result.output;
  const trust = output.trust;
  const claims: Claim[] = trust.claims.map((claim, index) => {
    const first = claim.citations[0];
    return {
      callout: "callout" in claim ? claim.callout : index + 1,
      confidence: claim.confidence,
      reasoning: claim.reasoning,
      url: first?.url ?? "",
      title: first?.title ?? "",
      excerpt: first?.excerpts?.[0] ?? "",
      sourceCategory: first?.source_category ?? "",
    };
  });
  return {
    content: typeof output.content === "string" ? output.content : JSON.stringify(output.content),
    confidence: trust.confidence,
    reasoning: trust.reasoning,
    claims,
    sources: trust.sources.map((s) => ({
      url: s.url,
      title: s.title ?? "",
      type: s.type,
      category: s.source_category ?? "",
    })),
    raw: result,
  };
}

/** Quick social pulse from Nimble Search (focus modes only work at lite depth). */
export async function socialBuzz(query: string) {
  return nimble().search({ query, focus: "social", search_depth: "lite", max_results: 10, time_range: "week" });
}
