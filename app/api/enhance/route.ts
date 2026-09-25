import { enabled } from "@/lib/config";
import { logEvent } from "@/lib/events";

/** Promote a draft bulletin to a full-quality render (FLUX 3 draft_enhance). */
export async function POST(request: Request) {
  if (!enabled.rawtree()) return Response.json({ error: "RawTree is not configured" }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { storyId?: string };
  const storyId = String(body.storyId ?? "").trim();
  if (!/^[a-z0-9-]{4,80}$/.test(storyId)) return Response.json({ error: "bad story id" }, { status: 400 });
  const requestId = crypto.randomUUID();
  await logEvent({
    story_id: storyId,
    step: "enhance.requested",
    sponsor: "flux",
    message: "Final render requested from the control room",
    data: { request_id: requestId },
  });
  return Response.json({ ok: true, requestId });
}
