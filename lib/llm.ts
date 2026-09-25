import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { config, enabled } from "./config";

/*
 * Everything LLM-shaped goes through OpenAI-compatible endpoints via the Vercel AI SDK:
 *  - "writer": a cloud model for the anchor script (OpenAI, OpenRouter, anything compatible)
 *  - "local":  Liquid LFM2.5 running on this laptop behind Ollama or llama.cpp's server
 */

let writerProvider: ReturnType<typeof createOpenAICompatible> | null = null;
let localProvider: ReturnType<typeof createOpenAICompatible> | null = null;

export function writerModel(): LanguageModel | null {
  if (!enabled.llm()) return null;
  writerProvider ??= createOpenAICompatible({
    name: "writer",
    baseURL: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    supportsStructuredOutputs: config.llm.structured,
  });
  return writerProvider.chatModel(config.llm.model);
}

export function localModel(): LanguageModel {
  localProvider ??= createOpenAICompatible({
    name: "liquid-local",
    baseURL: config.local.baseUrl,
    apiKey: "local",
    supportsStructuredOutputs: config.local.structured,
  });
  return localProvider.chatModel(config.local.model);
}

let localCheck: { at: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

/** Is the on-device Liquid server up? Cached for a minute so the worker never stalls on it. */
export async function localAvailable(): Promise<boolean> {
  if (localCheck && Date.now() - localCheck.at < 60_000) return localCheck.ok;
  inFlight ??= (async () => {
    let ok = false;
    try {
      const response = await fetch(`${config.local.baseUrl.replace(/\/$/, "")}/models`, {
        signal: AbortSignal.timeout(1500),
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
    localCheck = { at: Date.now(), ok };
    inFlight = null;
    return ok;
  })();
  return inFlight;
}

/** Last known answer without waiting; refreshes in the background when stale. For the dashboard. */
export function localAvailableNow(): boolean {
  if (!localCheck || Date.now() - localCheck.at >= 60_000) void localAvailable();
  return localCheck?.ok ?? false;
}

/** AI SDK telemetry flags; spans are exported to RawTree when the worker registers @rawtree/otel. */
export function telemetry(functionId: string) {
  return { isEnabled: true, recordInputs: true, recordOutputs: true, functionId };
}
