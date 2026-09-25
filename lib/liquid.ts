import { generateText, Output } from "ai";
import { z } from "zod";
import { config } from "./config";
import { localAvailable, localModel, telemetry } from "./llm";

export const CATEGORIES = [
  "AI agents",
  "LLM tooling",
  "AI models",
  "Developer tools",
  "Infrastructure",
  "Data",
  "Security",
  "Web & UI",
  "Mobile",
  "Games",
  "Learning",
  "Other",
] as const;

const LabelSchema = z.object({
  category: z.enum(CATEGORIES),
  one_liner: z.string().describe("What the project does, in at most 14 plain-English words"),
  audience: z.string().describe("Who it is for, 2 to 5 words"),
});

export type RepoLabel = z.infer<typeof LabelSchema> & { latency_ms: number; model: string };

/**
 * On-device triage with Liquid LFM2.5: every repo the desk looks at is labeled
 * locally, for free, before anything expensive (research, video) is spent on it.
 * Returns null when the local server is not running, and the pipeline carries on.
 */
export async function labelRepo(input: {
  repo: string;
  description: string;
  topics: string[];
  language: string;
  readme: string;
}): Promise<RepoLabel | null> {
  if (!(await localAvailable())) return null;
  const started = performance.now();
  const { output } = await generateText({
    model: localModel(),
    system:
      "You label open-source GitHub repositories. Reply only with the requested JSON. Be concrete and plain-spoken.",
    prompt: [
      `Repository: ${input.repo}`,
      `Description: ${input.description || "(none)"}`,
      `Language: ${input.language || "unknown"}`,
      `Topics: ${input.topics.join(", ") || "(none)"}`,
      `README excerpt: ${input.readme.slice(0, 1200) || "(none)"}`,
    ].join("\n"),
    output: Output.object({ schema: LabelSchema }),
    maxOutputTokens: 200,
    temperature: 0.1,
    experimental_telemetry: telemetry("liquid-label-repo"),
  });
  return { ...output, latency_ms: Math.round(performance.now() - started), model: config.local.label };
}
