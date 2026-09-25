import { enabled } from "@/lib/config";
import { askDesk } from "@/lib/desk-agent";
import { describeError } from "@/lib/rawtree";

/** Ask the desk: an agent with Nimble web tools and RawTree data tools. */
export async function POST(request: Request) {
  if (!enabled.rawtree()) return Response.json({ error: "RawTree is not configured" }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { question?: string };
  const question = String(body.question ?? "").trim().slice(0, 400);
  if (question.length < 4) return Response.json({ error: "Ask a full question, e.g. why is vercel/next.js trending?" }, { status: 400 });
  try {
    return Response.json(await askDesk(question));
  } catch (error) {
    return Response.json({ error: describeError(error) }, { status: 500 });
  }
}
