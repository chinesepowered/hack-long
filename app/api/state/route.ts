import type { NextRequest } from "next/server";
import { fixtureState } from "@/lib/fixture";
import { getDashboardState } from "@/lib/state";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" && request.nextUrl.searchParams.get("fixture") === "1") {
    return Response.json({ ...fixtureState(), fixture: true }, { headers: { "Cache-Control": "no-store" } });
  }
  const state = await getDashboardState();
  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
}
