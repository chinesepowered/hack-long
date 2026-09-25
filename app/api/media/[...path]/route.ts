import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { mediaPath } from "@/lib/media";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Serves generated media from DATA_DIR, with byte ranges so the video player can seek. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/media/[...path]">) {
  const { path: parts } = await ctx.params;
  let file: string;
  try {
    file = mediaPath(parts.join("/"));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return new Response("Not found", { status: 404 });

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
