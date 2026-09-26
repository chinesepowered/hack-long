import "../worker/env";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

/**
 * Records a narrated demo of the running control room: pnpm demo:video
 *  1. ElevenLabs narrates each segment (cached by text, so re-runs are free)
 *  2. Playwright drives the real dashboard in Chrome, timed to the narration
 *  3. ffmpeg mixes narration + the bulletin's own lip-synced audio onto the recording
 * Needs the web app and worker running, plus ELEVENLABS_API_KEY.
 */

const BASE = process.env.DEMO_URL ?? "http://localhost:3000";
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? "onwK4e9ZLuTAKqWW03F9"; // "Daniel, Steady Broadcaster"
const MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
const QUESTION = process.env.DEMO_QUESTION ?? "Which repos gained the most stars in the last hour, and why is the top one taking off?";
const STORY = process.env.DEMO_STORY ?? ""; // repo whose video bulletin to feature; defaults to the newest one
const ASSIGN_REPO = process.env.DEMO_ASSIGN_REPO ?? ""; // set to film a live assignment (spends research + video credits)
const DATA = path.resolve(process.env.DATA_DIR ?? "data");
const OUT = path.join(DATA, "demo");
const KEY = process.env.ELEVENLABS_API_KEY ?? "";

interface Segment {
  id: string;
  text?: string;
  focus?: string[];
  /** May return the time (seconds into the recording) where audioFile should start, when it is only known live. */
  action?: (page: Page) => Promise<number | void>;
  /** For segments with no narration: how long to hold, and an audio file to place at the segment start. */
  holdSeconds?: number;
  audioFile?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probeSeconds(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim();
  return Number(out) || 0;
}

async function narrate(text: string): Promise<string> {
  const file = path.join(OUT, `vo-${createHash("sha1").update(`${VOICE}:${MODEL}:${text}`).digest("hex").slice(0, 12)}.mp3`);
  try {
    await fs.access(file);
    return file;
  } catch {
    // not cached yet
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "Content-Type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15 } }),
  });
  if (!response.ok) throw new Error(`ElevenLabs HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

/** Outline the tiles the narration is talking about. */
async function focus(page: Page, labels: string[]) {
  await page.evaluate((names) => {
    document.querySelectorAll(".demo-focus").forEach((el) => el.classList.remove("demo-focus"));
    for (const name of names) document.querySelector(`[aria-label="${name}"]`)?.classList.add("demo-focus");
  }, labels);
}

interface DemoState {
  bulletins: { videoUrl: string; repo: string; headline: string; isFinal: boolean }[];
  board: { repo: string }[];
}

async function main() {
  if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set");
  await fs.mkdir(OUT, { recursive: true });
  const state = (await (await fetch(`${BASE}/api/state`)).json()) as DemoState;
  const bulletin = state.bulletins.find((b) => b.videoUrl && (!STORY || b.repo === STORY));
  if (STORY && !bulletin) throw new Error(`no video bulletin for ${STORY}`);
  const bulletinFile = bulletin ? path.join(DATA, bulletin.videoUrl.replace(/^\/api\/media\//, "")) : "";

  let started = 0;
  const clock = () => (performance.now() - started) / 1000;

  const segments: Segment[] = [
    {
      id: "intro",
      text: "This is Breakout: a live AI news desk for the fastest-rising projects on GitHub. It has been running all day, and everything it sees, does and says lives in RawTree.",
      focus: ["Program"],
    },
    {
      id: "firehose",
      text: "Every hour, RawTree pulls the public GitHub event firehose straight from GH Archive with server-side URL ingest. Millions of raw events, no schema. Every tile on this wall is a live query, and the median runs in milliseconds.",
      focus: ["Firehose", "Queries"],
    },
    {
      id: "board",
      text: "RawTree ranks candidates from the firehose, then logs each repo's own event stream to measure exact star velocity. When a repo breaks out, the desk opens a story.",
      focus: ["The board"],
    },
    {
      id: "pipeline",
      text: "Every story runs the same beat. Memory from RawTree. Triage by a Liquid model on this laptop. Cited research from a Nimble web search agent. A script. Then FLUX 3 puts Scout, our beagle anchor, on camera with lip-synced audio. Every clip starts from the same pinned frame, so Scout looks the same in every story.",
      focus: ["Program", "Newsroom log"],
    },
  ];
  if (bulletin && bulletinFile) {
    segments.push({
      id: "bulletin",
      focus: ["Program"],
      holdSeconds: probeSeconds(bulletinFile) + 0.8,
      audioFile: bulletinFile,
      action: async (page) => {
        await page.getByRole("button", { name: "Replay" }).click();
        // Place the bulletin's audio where playback really restarted, so the lip sync survives the mix.
        // No named functions in here: tsx wraps them in a __name() helper that does not exist in the browser.
        const playhead = await page.locator('[aria-label="Program"] video').evaluate(async (video: HTMLVideoElement) => {
          const deadline = Date.now() + 8000;
          while ((video.paused || video.currentTime < 0.2) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return video.paused ? -1 : video.currentTime;
        });
        if (playhead < 0) throw new Error("the bulletin never started playing; check that /api/media serves it");
        return clock() - playhead;
      },
    });
    segments.push({
      id: "final",
      text: bulletin.isFinal
        ? "That was a final cut. Every video starts as a seventy-two cent draft, and when one is worth keeping, a producer clicks Render final cut and FLUX re-renders that same take in full 1080p."
        : "That was a seventy-two cent draft. When one is worth keeping, a producer clicks Render final cut, and FLUX re-renders that same take in full 1080p.",
      focus: ["Program"],
    });
  }
  segments.push({
    id: "ask",
    text: "Judges can ask the desk anything. The agent uses Nimble's AI SDK tools for the live web and RawTree tools for the data, and every call it makes is recorded in the newsroom log.",
    focus: ["Desk console", "Newsroom log"],
    action: async (page) => {
      await page.getByRole("button", { name: "Ask the desk" }).click();
      await page.locator("#desk-input").pressSequentially(QUESTION, { delay: 18 });
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await page.locator('[aria-label="Desk console"] [aria-live="polite"]').waitFor({ timeout: 90_000 });
      await sleep(4000);
    },
  });
  if (ASSIGN_REPO) {
    segments.push({
      id: "assign",
      text: "Or hand it a repo. The request lands in RawTree, the worker picks it up, and the production strip lights up stage by stage.",
      focus: ["Desk console", "Program"],
      action: async (page) => {
        await page.getByRole("button", { name: "Assign a story" }).click();
        await page.locator("#desk-input").pressSequentially(ASSIGN_REPO, { delay: 30 });
        await page.getByRole("button", { name: "Assign", exact: true }).click();
        await sleep(12_000);
      },
    });
  }
  segments.push({
    id: "outro",
    text: "RawTree is its memory. Nimble, its eyes. FLUX, its face and voice. And Liquid, its reflexes. This is Breakout.",
    focus: [],
  });

  console.log("Narrating with ElevenLabs...");
  const narration = new Map<string, { file: string; seconds: number }>();
  for (const segment of segments) {
    if (!segment.text) continue;
    const file = await narrate(segment.text);
    narration.set(segment.id, { file, seconds: probeSeconds(file) });
  }

  console.log(`Recording the control room${bulletin ? `, featuring ${bulletin.repo}` : ""}...`);
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
  });
  started = performance.now();
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: ".demo-focus{outline:3px solid #ffb547!important;outline-offset:-3px;transition:outline-color .3s}",
  });
  // The first frames are a blank page, then an empty wall until /api/state lands: start the cut once data is up.
  await page
    .waitForFunction(() => document.querySelectorAll('[aria-label="The board"] li').length > 0, null, { timeout: 30_000 })
    .catch(() => console.warn("  board never filled; keeping the whole recording"));
  // Pin the featured bulletin before the cut starts, so a newer story can't take over the program monitor mid-take.
  if (bulletin) await page.locator('nav[aria-label="Rundown"] button', { hasText: bulletin.headline }).click();
  await sleep(1000);
  const head = clock();
  await sleep(1000);

  const placements: { file: string; at: number }[] = [];
  for (const segment of segments) {
    const at = clock();
    await focus(page, segment.focus ?? []);
    const voice = narration.get(segment.id);
    if (voice) placements.push({ file: voice.file, at });
    const minimum = sleep(((voice?.seconds ?? 0) + (segment.holdSeconds ?? 0) + 0.6) * 1000);
    const [, audioAt] = await Promise.all([minimum, segment.action?.(page)]);
    if (segment.audioFile) placements.push({ file: segment.audioFile, at: typeof audioAt === "number" ? audioAt : at + 0.3 });
    console.log(`  ${segment.id} at ${(at - head).toFixed(1)}s`);
  }
  await focus(page, []);
  await sleep(2000);
  const total = clock();
  const video = page.video();
  await context.close();
  await browser.close();
  const raw = await video!.path();

  console.log("Mixing and encoding...");
  const inputs = placements.flatMap((p) => ["-i", p.file]);
  const delays = placements.map((p, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round((p.at - head) * 1000))}:all=1[a${i}]`).join(";");
  const mix = `${placements.map((_, i) => `[a${i}]`).join("")}amix=inputs=${placements.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  const trim = `[0:v]trim=start=${head.toFixed(3)},setpts=PTS-STARTPTS[vout]`;
  const output = path.join(OUT, `breakout-demo-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.mp4`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i", raw,
      ...inputs,
      "-filter_complex", `${trim};${delays};${mix}`,
      "-map", "[vout]",
      "-map", "[aout]",
      "-t", (total - head).toFixed(2),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-c:a", "aac",
      "-b:a", "192k",
      output,
    ],
    { stdio: "inherit" },
  );
  await fs.rm(raw, { force: true });
  console.log(`\nDemo video: ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
