import { describeError, insert } from "./rawtree";

export type Sponsor = "rawtree" | "nimble" | "flux" | "liquid" | "github" | "llm" | "desk";

export interface AgentEvent {
  story_id?: string;
  repo?: string;
  step: string;
  sponsor: Sponsor;
  status?: "info" | "ok" | "error" | "progress";
  message: string;
  data?: unknown;
}

const colors: Record<Sponsor, string> = {
  rawtree: "\x1b[32m",
  nimble: "\x1b[35m",
  flux: "\x1b[33m",
  liquid: "\x1b[36m",
  github: "\x1b[37m",
  llm: "\x1b[34m",
  desk: "\x1b[31m",
};

/**
 * The newsroom's flight recorder. Every step lands in RawTree's agent_events table:
 * it drives the live feed in the UI, doubles as the request inbox, and is what a
 * restarted worker reads to resume unfinished stories.
 */
export async function logEvent(event: AgentEvent): Promise<void> {
  const row = {
    ts: new Date().toISOString(),
    story_id: event.story_id ?? "",
    repo: event.repo ?? "",
    step: event.step,
    sponsor: event.sponsor,
    status: event.status ?? "info",
    message: event.message,
    data_json: event.data === undefined ? "" : JSON.stringify(event.data),
  };
  const tag = `${colors[event.sponsor]}[${event.sponsor}]\x1b[0m`;
  const who = event.repo ? ` ${event.repo}` : "";
  console.log(`${new Date().toLocaleTimeString()} ${tag}${who} ${event.message}`);
  try {
    await insert("agent_events", row);
  } catch (error) {
    console.error(`  (could not record event in RawTree: ${describeError(error)})`);
  }
}
