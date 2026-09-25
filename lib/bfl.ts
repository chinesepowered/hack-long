import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

const TERMINAL = new Set(["Ready", "Request Moderated", "Content Moderated", "Error", "Task not found"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface BflTask {
  id: string;
  polling_url: string;
  cost?: number | null;
}

export interface BflResult {
  id: string;
  status: string;
  result?: { sample?: string; draft_cache?: string; [key: string]: unknown } | null;
  progress?: number | null;
  details?: Record<string, unknown> | null;
  cost?: number;
}

async function submit(endpoint: string, body: object): Promise<BflTask> {
  const response = await fetch(`${config.bfl.baseUrl}/v1/${endpoint}`, {
    method: "POST",
    headers: { "x-key": config.bfl.apiKey, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`FLUX ${endpoint} HTTP ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as BflTask;
}

/**
 * FLUX 3 video with synchronized, lip-synced audio. With a keyframe (base64 or URL),
 * the clip opens on that exact frame, which is how every bulletin keeps the same
 * anchor and studio.
 */
export function submitVideo(input: { prompt: string; keyframe?: string; duration: number; draft: boolean; resolution: string }) {
  const common = {
    prompt: input.prompt,
    duration: input.duration,
    draft: input.draft,
    // Drafts always render at hd; the API rejects anything else.
    resolution: input.draft ? "hd" : input.resolution,
    aspect_ratio: "16:9",
    generate_audio: true,
  };
  return submit(
    "flux-3-video",
    input.keyframe ? { ...common, mode: "i2v", keyframes: input.keyframe } : { ...common, mode: "t2v" },
  );
}

/** Re-render a chosen draft at full quality: same shot, same seed, nothing re-interpreted. */
export function submitEnhance(draftCache: string, resolution = "fhd") {
  return submit("flux-3-video", { mode: "draft_enhance", draft_cache: draftCache, resolution });
}

export function submitImage(
  model: "flux-2-pro" | "flux-2-klein-4b" | "flux-2-max",
  input: { prompt: string; width: number; height: number },
) {
  return submit(model, { prompt: input.prompt, width: input.width, height: input.height, output_format: "jpeg" });
}

export async function waitForResult(
  task: Pick<BflTask, "polling_url">,
  onStatus?: (status: string, progress: number | null) => void,
  timeoutMs = 15 * 60_000,
): Promise<BflResult> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const response = await fetch(task.polling_url, { headers: { "x-key": config.bfl.apiKey, accept: "application/json" } });
    if (response.ok) {
      const body = (await response.json()) as BflResult;
      if (body.status !== last) {
        last = body.status;
        onStatus?.(body.status, body.progress ?? null);
      }
      if (TERMINAL.has(body.status)) return body;
    }
    await sleep(3000);
  }
  throw new Error("FLUX task timed out");
}

/** Result URLs are signed and expire, so everything is downloaded the moment it is ready. */
export async function downloadTo(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
}
