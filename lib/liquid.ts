import { generateText, Output } from "ai";
import { z } from "zod";
import { config } from "./config";
import { localAvailable, localModel, telemetry } from "./llm";

export const CATEGORIES = ["AI agents", "Learning", "Data & infra", "Apps & media", "Developer tools", "AI & LLMs", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

/*
 * Division of labor, from testing LFM2.5-1.2B on real repos: it writes accurate,
 * grounded one-liners from a description and README, but is unreliable at picking
 * from a category list. So the model does the language work and simple rules sort.
 */
const RULES: [Category, RegExp][] = [
  ["AI agents", /\bagents?\b|\bagentic\b/i],
  ["Learning", /\b(course|tutorial|curriculum|roadmap|awesome|cheat ?sheet|interview prep)\b|from scratch|for beginners/i],
  ["Data & infra", /\b(database|db|storage|sql|queue|cache|observability|kubernetes|server|infrastructure|spreadsheet|analytics|etl)\b/i],
  ["Apps & media", /\b(video|music|design|simulator|visuali[sz]\w*|game|photo|image|3d)\b/i],
  ["Developer tools", /\b(cli|sdk|library|framework|compiler|terminal|ide|plugin|devtools?|linter|testing)\b/i],
  ["AI & LLMs", /\b(llm|model|ai|gpt|prompt|rag|inference|transformer|diffusion)\b/i],
];

export function categorize(text: string): Category {
  return RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "Other";
}

/** Small models sometimes answer in the README's language; catch non-Latin scripts and common non-English words. */
function looksEnglish(text: string): boolean {
  return !/[^\u0000-ɏ -⁯]/.test(text) && !/\b(una|para|desde|und|der|les|pour|con)\b/i.test(text);
}

const LabelSchema = z.object({
  one_liner: z.string().describe("In English: what the project does, based only on its description and README, at most 14 words"),
});

export type RepoLabel = { one_liner: string; category: Category; latency_ms: number; model: string };

const SYSTEM = `You describe open-source GitHub repositories in plain English. Reply only with the requested JSON.
Always write in English. Base the one-liner on the description and README only; never guess from the owner or repository name.
Examples:
Description: "Fast, embeddable key-value store written in Go" -> {"one_liner":"An embeddable key-value store for Go programs"}
Description: "Turn your terminal into a pair programmer" -> {"one_liner":"An AI pair programmer that works in your terminal"}`;

/**
 * On-device triage with Liquid LFM2.5: every repo on the board gets a plain-English
 * one-liner written on this machine, for free, before anything expensive is spent on it.
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
    system: SYSTEM,
    prompt: [
      `Description: "${input.description || "(none)"}"`,
      `Topics: ${input.topics.join(", ") || "(none)"}`,
      `Language: ${input.language || "unknown"}`,
      `README excerpt: ${input.readme.slice(0, 700) || "(none)"}`,
      "Write the one_liner in English, even if the README is in another language.",
    ].join("\n"),
    output: Output.object({ schema: LabelSchema }),
    maxOutputTokens: 100,
    temperature: 0,
    experimental_telemetry: telemetry("liquid-label-repo"),
  });
  const oneLiner = looksEnglish(output.one_liner) ? output.one_liner : input.description.slice(0, 110);
  return {
    one_liner: oneLiner,
    category: categorize(`${input.description} ${input.topics.join(" ")} ${oneLiner}`),
    latency_ms: Math.round(performance.now() - started),
    model: config.local.label,
  };
}
