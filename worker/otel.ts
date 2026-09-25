import { aiSdkIntegration, registerOTel, type RawTreeOtelHandle } from "@rawtree/otel";
import { config } from "@/lib/config";

/**
 * Every AI SDK call the desk makes (script writing, on-device labeling) is traced
 * and exported to RawTree as raw OpenTelemetry spans, next to the rest of its data.
 */
export function startTelemetry(): RawTreeOtelHandle | null {
  if (!config.rawtree.apiKey) return null;
  try {
    return registerOTel({
      apiKey: config.rawtree.apiKey,
      database: config.rawtree.database,
      baseUrl: config.rawtree.baseUrl,
      serviceName: "breakout-newsroom",
      environment: "hackathon",
      integrations: [aiSdkIntegration()],
    });
  } catch (error) {
    console.warn("OpenTelemetry export to RawTree disabled:", error instanceof Error ? error.message : error);
    return null;
  }
}
