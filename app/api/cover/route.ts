import { enabled } from "@/lib/config";
import { logEvent } from "@/lib/events";
import { isRepoName } from "@/lib/github";

/** Accepts "owner/name" or a github.com URL. */
function normalize(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = /github\.com\/([^/\s]+\/[^/\s?#]+)/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

/** A judge asks the desk to cover a repo. The request lands in RawTree; the worker picks it up. */
export async function POST(request: Request) {
  if (!enabled.rawtree()) return Response.json({ error: "RawTree is not configured" }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { repo?: string };
  const repo = normalize(String(body.repo ?? ""));
  if (!isRepoName(repo)) return Response.json({ error: "Use owner/name, e.g. vercel/next.js" }, { status: 400 });
  const requestId = crypto.randomUUID();
  await logEvent({
    repo,
    step: "cover.requested",
    sponsor: "desk",
    message: `Request from the floor: cover ${repo}`,
    data: { request_id: requestId },
  });
  return Response.json({ ok: true, repo, requestId });
}
