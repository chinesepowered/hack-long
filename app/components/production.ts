import type { FeedItem } from "@/lib/state";

export interface Stage {
  key: string;
  label: string;
  sponsor: string;
  state: "done" | "active" | "pending" | "skipped";
  detail?: string;
}

export interface Production {
  storyId: string;
  repo: string;
  stages: Stage[];
  startedAt: number;
}

const STAGES: { key: string; label: string; sponsor: string; start?: string[]; done: string[]; skip?: string[] }[] = [
  { key: "memory", label: "Memory", sponsor: "rawtree", done: ["memory.checked"] },
  { key: "liquid", label: "On-device triage", sponsor: "liquid", done: ["liquid.labeled"], skip: ["liquid.skipped"] },
  { key: "nimble", label: "Web research", sponsor: "nimble", start: ["nimble.started", "nimble.progress", "nimble.buzz"], done: ["nimble.completed"], skip: ["nimble.failed"] },
  { key: "script", label: "Script", sponsor: "llm", done: ["script.written"] },
  { key: "flux", label: "Video", sponsor: "flux", start: ["flux.submitted", "flux.status"], done: ["flux.ready"], skip: ["flux.skipped"] },
  { key: "air", label: "On air", sponsor: "desk", done: ["bulletin.published"] },
];

/** The story currently in production, reconstructed from the flight recorder. */
export function currentProduction(feed: FeedItem[], now = Date.now()): Production | null {
  // feed is newest first, so the first story seen is the most recent one.
  const byStory = new Map<string, FeedItem[]>();
  for (const item of feed) {
    if (!item.storyId) continue;
    byStory.set(item.storyId, [...(byStory.get(item.storyId) ?? []), item]);
  }
  for (const [storyId, items] of byStory) {
    const steps = new Set(items.map((i) => i.step));
    // Only broadcast stories (not Ask the desk questions), and only unfinished ones.
    if (!steps.has("story.started") && !steps.has("story.resumed")) continue;
    if (steps.has("bulletin.published") || steps.has("story.failed")) continue;
    if (now / 1000 - Math.max(...items.map((i) => i.ts)) > 15 * 60) continue;

    const stages: Stage[] = STAGES.map((stage) => {
      const related = [...(stage.start ?? []), ...stage.done, ...(stage.skip ?? [])];
      const latest = items.find((i) => related.includes(i.step));
      const done = stage.done.some((s) => steps.has(s));
      const skipped = stage.skip?.some((s) => steps.has(s)) ?? false;
      const started = stage.start?.some((s) => steps.has(s)) ?? false;
      return {
        key: stage.key,
        label: stage.label,
        sponsor: stage.sponsor,
        state: done ? "done" : skipped ? "skipped" : started ? "active" : "pending",
        detail: latest?.message,
      };
    });
    // Where the desk is working now: the first stage that is not finished.
    const open = stages.find((s) => s.state === "pending" || s.state === "active");
    if (open) open.state = "active";
    return { storyId, repo: items[0].repo, stages, startedAt: Math.min(...items.map((i) => i.ts)) };
  }
  return null;
}
