import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { config } from "./config";
import { localAvailable, localModel, telemetry, writerModel } from "./llm";
import type { Claim, Research } from "./nimble";

export interface StoryFacts {
  repo: string;
  description: string;
  language: string;
  createdAt: string;
  stargazers: number;
  s1h: number;
  s6h: number;
  s24h: number;
  coveredSinceHours: number;
  oneLiner?: string;
  category?: string;
  readme: string;
  research: Research | null;
  buzz: { title: string; url: string }[];
  memory: { ts: string; headline: string; dialogue: string; stargazers: number }[];
}

export interface Caption {
  text: string;
  url: string;
  domain: string;
  confidence: string;
}

export interface Script {
  headline: string;
  dialogue: string;
  captions: Caption[];
  writer: string;
}

const ScriptSchema = z.object({
  headline: z.string().describe("On-screen banner, 3 to 7 words, no trailing period"),
  dialogue: z.string().describe("Exactly what the anchor says aloud"),
  captions: z
    .array(
      z.object({
        text: z.string().describe("A short on-screen fact, at most 60 characters"),
        claim: z.number().int().describe("The research claim number that supports it"),
      }),
    )
    .describe("Two or three on-screen facts"),
});

/** "paperclipai/paperclip" -> "Paperclip". Anchors should not read slashes aloud. */
export function speakableName(repo: string): string {
  const name = repo.split("/")[1] ?? repo;
  return name
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function wordBudget(): [number, number] {
  // Roughly 2.4 spoken words per second, leaving a beat at each end.
  const max = Math.max(14, Math.round(config.bfl.duration * 2.4) - 2);
  return [Math.round(max * 0.8), max];
}

function ageLabel(createdAt: string): string {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return "unknown age";
  if (days < 1) return "created today";
  if (days < 60) return `${days} days old`;
  return `${Math.round(days / 30)} months old`;
}

function claimsBlock(claims: Claim[]): string {
  return claims
    .slice(0, 12)
    .map((c) => `[${c.callout}] (${c.confidence}) ${c.reasoning} | source: ${domainOf(c.url)} | "${c.excerpt.slice(0, 200)}"`)
    .join("\n");
}

function buildPrompt(facts: StoryFacts): string {
  const [minWords, maxWords] = wordBudget();
  const memory = facts.memory.length
    ? facts.memory
        .map((m) => `- ${m.ts}: "${m.headline}" (it had ${m.stargazers.toLocaleString("en-US")} stars) said: ${m.dialogue}`)
        .join("\n")
    : "(never covered before)";
  return `PROJECT: ${facts.repo} (say it as "${speakableName(facts.repo)}")
WHAT IT IS: ${facts.oneLiner || facts.description || "(no description)"}
CATEGORY: ${facts.category || "unknown"} | LANGUAGE: ${facts.language || "unknown"} | ${ageLabel(facts.createdAt)}
MOMENTUM: ${facts.s1h} new stars in the last hour, ${facts.s6h} in the last ${Math.min(6, Math.max(1, Math.round(facts.coveredSinceHours)))} hours tracked, ${facts.stargazers.toLocaleString("en-US")} total.

RESEARCH (from a live web research agent; cite claim numbers):
${facts.research ? facts.research.content.slice(0, 2500) : "(no research available)"}

CLAIMS:
${facts.research ? claimsBlock(facts.research.claims) : "(none)"}

SOCIAL POSTS SEEN THIS WEEK:
${facts.buzz.slice(0, 5).map((b) => `- ${b.title}`).join("\n") || "(none)"}

WHAT THE DESK ALREADY SAID ABOUT IT:
${memory}

README EXCERPT:
${facts.readme.slice(0, 900) || "(none)"}

Write the bulletin. Dialogue: ${minWords} to ${maxWords} words.`;
}

const SYSTEM = `You write spoken bulletins for BREAKOUT, a live broadcast about the fastest-rising open-source projects on GitHub. The anchor is Scout, a beagle and the desk's news hound, who reads your dialogue on camera.
Rules:
- Dialogue is spoken English: no markdown, no URLs, no emoji, no parentheses, no slashes. Spell numbers the way an anchor says them.
- Open with the momentum (a concrete star number), then what the project is, then why it is taking off right now.
- Use only facts from the research, claims and README. Never invent names, dates or numbers.
- If the desk covered this project before, do not repeat yourself: open with what changed since then.
- Headline: 3 to 7 words for the on-screen banner.
- Captions: two or three short on-screen facts, each tied to the claim number that supports it.
- Scout may use one light dog pun (sniffing out, fetching, on the scent) when it fits naturally. Facts come first.`;

async function generate(model: LanguageModel, facts: StoryFacts, functionId: string) {
  const { output } = await generateText({
    model,
    system: SYSTEM,
    prompt: buildPrompt(facts),
    output: Output.object({ schema: ScriptSchema }),
    // Reasoning models spend part of this budget thinking before they answer.
    maxOutputTokens: 4000,
    experimental_telemetry: telemetry(functionId),
  });
  return output;
}

function attachSources(captions: { text: string; claim: number }[], claims: Claim[]): Caption[] {
  return captions.slice(0, 3).map((caption) => {
    const claim = claims.find((c) => c.callout === caption.claim) ?? claims[0];
    return {
      text: caption.text.slice(0, 80),
      url: claim?.url ?? "",
      domain: domainOf(claim?.url ?? ""),
      confidence: claim?.confidence ?? "",
    };
  });
}

function fallbackScript(facts: StoryFacts): Script {
  const name = speakableName(facts.repo);
  const what = (facts.oneLiner || facts.description || "an open-source project").replace(/[.\s]+$/, "");
  const [, maxWords] = wordBudget();
  const dialogue = `${name} is breaking out on GitHub, with ${facts.s1h} new stars in the last hour. It is ${what.charAt(0).toLowerCase()}${what.slice(1)}. We are watching it closely.`
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ");
  const claims = facts.research?.claims ?? [];
  return {
    headline: `${name} is breaking out`,
    dialogue,
    captions: claims.slice(0, 3).map((c) => ({
      text: (c.excerpt || c.reasoning).slice(0, 70),
      url: c.url,
      domain: domainOf(c.url),
      confidence: c.confidence,
    })),
    writer: "template",
  };
}

/** Cloud writer first, then on-device Liquid, then a template, so a bulletin always ships. */
export async function writeScript(facts: StoryFacts): Promise<Script> {
  const claims = facts.research?.claims ?? [];
  const attempts: { model: LanguageModel; label: string }[] = [];
  const writer = writerModel();
  if (writer) attempts.push({ model: writer, label: config.llm.model });
  if (await localAvailable()) attempts.push({ model: localModel(), label: `${config.local.label} (on-device)` });

  for (const attempt of attempts) {
    // Hosted reasoning models occasionally return an empty completion; one retry clears it.
    for (let tryNumber = 1; tryNumber <= 2; tryNumber++) {
      try {
        const output = await generate(attempt.model, facts, "anchor-script");
        if (output.dialogue.trim().split(/\s+/).length < 6) continue;
        return {
          headline: output.headline.replace(/[.!]+$/, ""),
          dialogue: output.dialogue.replace(/\s+/g, " ").trim(),
          captions: attachSources(output.captions, claims),
          writer: attempt.label,
        };
      } catch (error) {
        console.error(`script writer ${attempt.label} failed (try ${tryNumber}):`, error instanceof Error ? error.message : error);
      }
    }
  }
  return fallbackScript(facts);
}

/**
 * The FLUX 3 prompt. Per BFL's guidance: quote the line, give it a visible speaker,
 * say the mouth moves on each word, and forbid on-screen text so the words are
 * spoken rather than burned in. Our own chyrons are overlaid in the browser.
 */
export function videoPrompt(dialogue: string): string {
  const line = dialogue.replace(/"/g, "'");
  return [
    "Scout, the beagle news anchor from the opening frame, sits at the glass desk of a dark, modern broadcast studio in his charcoal blazer.",
    `He looks straight into the camera and says, in a warm, friendly, upbeat broadcast voice: "${line}"`,
    "His mouth and jowls open and close precisely on each word, with natural blinks, small head tilts and ears that shift as he speaks.",
    "Slow, steady push-in toward Scout. The glowing green grid on the wall behind him pulses gently.",
    "Audio: only his voice, soft studio room tone, and a quiet, low news music bed underneath.",
    "These are the only words spoken. No on-screen text, no subtitles, no captions.",
  ].join(" ");
}
