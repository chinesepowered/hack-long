/** Next.js startup hook: the web server's AI SDK calls (Ask the desk) are traced into RawTree too. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.RAWTREE_API_KEY) {
    const { startTelemetry } = await import("./worker/otel");
    startTelemetry();
  }
}
