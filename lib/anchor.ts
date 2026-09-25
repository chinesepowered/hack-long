import fs from "node:fs/promises";
import { downloadTo, submitImage, waitForResult } from "./bfl";
import { media, mediaPath } from "./media";

/**
 * Scout, the desk's beagle news hound. Every bulletin opens on this exact frame, so he
 * stays the same anchor all day, and nobody mistakes AI-written news for a real journalist.
 */
export const ANCHOR_PROMPT = [
  "Cinematic still from a late-night technology news broadcast.",
  "A beagle news anchor with floppy ears and a warm, alert expression sits upright at a sleek glass news desk,",
  "wearing a tiny charcoal blazer over a white collared shirt, front paws resting on the desk,",
  "looking directly into the camera, mouth closed.",
  "Behind the anchor, a wide curved LED wall shows an abstract glowing grid of small green squares, like a code contribution graph, over deep navy blue.",
  "Moody studio lighting: soft key light on the face, cool blue rim light, a little atmospheric haze.",
  "Medium shot at eye level, 35mm lens, shallow depth of field, photorealistic and charming.",
  "No text, no logos, no captions, no watermark.",
].join(" ");

export async function anchorExists(): Promise<boolean> {
  try {
    await fs.access(mediaPath(media.anchor));
    return true;
  } catch {
    return false;
  }
}

/** Generates the studio still with FLUX.2 [pro] at 16:9 and saves it to DATA_DIR/anchor/studio.jpg. */
export async function generateAnchor(onStatus?: (status: string) => void): Promise<string> {
  const task = await submitImage("flux-2-pro", { prompt: ANCHOR_PROMPT, width: 1536, height: 864 });
  const result = await waitForResult(task, (status) => onStatus?.(status), 5 * 60_000);
  const url = result.result?.sample;
  if (result.status !== "Ready" || !url) throw new Error(`Anchor image ended with status ${result.status}`);
  const file = mediaPath(media.anchor);
  await downloadTo(url, file);
  return file;
}

/** The anchor still as base64, ready to pin as frame 0 of a FLUX 3 video. */
export async function anchorKeyframe(): Promise<string | undefined> {
  try {
    return (await fs.readFile(mediaPath(media.anchor))).toString("base64");
  } catch {
    return undefined;
  }
}
