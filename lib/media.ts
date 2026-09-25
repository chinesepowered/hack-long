import path from "node:path";
import { config } from "./config";

/** Generated files live in DATA_DIR (not public/, which Next only serves if present at build time). */
export const media = {
  anchor: "anchor/studio.jpg",
  bulletinVideo: (storyId: string) => `bulletins/${storyId}.mp4`,
  bulletinFinal: (storyId: string) => `bulletins/${storyId}.final.mp4`,
  draftCache: (storyId: string) => `bulletins/${storyId}.draft.bin`,
};

export function mediaPath(relative: string): string {
  const resolved = path.resolve(config.dataDir, relative);
  if (!resolved.startsWith(config.dataDir)) throw new Error("path escapes DATA_DIR");
  return resolved;
}

export function mediaUrl(relative: string): string {
  return relative ? `/api/media/${relative}` : "";
}
