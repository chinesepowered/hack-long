import "./env";
import { anchorExists, generateAnchor } from "@/lib/anchor";
import { config, enabled } from "@/lib/config";
import { logEvent } from "@/lib/events";
import { localAvailable } from "@/lib/llm";
import { describeError } from "@/lib/rawtree";
import { Desk } from "./desk";
import { startTelemetry } from "./otel";
import { Tracker } from "./tracker";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `task` forever, `everySeconds` apart, never overlapping itself and never dying on an error. */
function loop(name: string, everySeconds: number, task: () => Promise<void>, delaySeconds = 0) {
  void (async () => {
    if (delaySeconds) await sleep(delaySeconds * 1000);
    for (;;) {
      try {
        await task();
      } catch (error) {
        console.error(`[${name}] ${describeError(error)}`);
      }
      await sleep(everySeconds * 1000);
    }
  })();
}

async function main() {
  const on = (flag: boolean) => (flag ? "\x1b[32mon\x1b[0m" : "\x1b[90moff\x1b[0m");
  console.log(`
  BREAKOUT newsroom worker
  RawTree   ${on(enabled.rawtree())}  database "${config.rawtree.database}"
  GitHub    ${on(enabled.github())}
  Nimble    ${on(enabled.nimble())}  agent "${config.nimble.agentName}", effort ${config.nimble.effort}
  FLUX      ${on(enabled.bfl())}  ${config.bfl.draft ? "drafts" : config.bfl.resolution}, ${config.bfl.duration}s
  Writer    ${on(enabled.llm())}  ${config.llm.model || "(template fallback)"}
  Liquid    ${on(await localAvailable())}  ${config.local.model} @ ${config.local.baseUrl}
  Auto      ${on(config.worker.autoCover)}  max ${config.worker.maxAutoPerHour}/hour
`);

  if (!enabled.rawtree()) {
    console.error("RAWTREE_API_KEY is required: RawTree is where everything lives. Add it to .env.local.");
    process.exit(1);
  }
  if (!enabled.github()) {
    console.error("A GitHub token is required (GITHUB_TOKEN, or log in with `gh auth login`).");
    process.exit(1);
  }

  const telemetry = startTelemetry();
  const shutdown = async () => {
    await telemetry?.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (enabled.bfl() && !(await anchorExists())) {
    try {
      await logEvent({ step: "anchor.generating", sponsor: "flux", message: "Casting the anchor: generating the studio still with FLUX.2 [pro]" });
      await generateAnchor();
      await logEvent({ step: "anchor.ready", sponsor: "flux", status: "ok", message: "Anchor still ready; every bulletin opens on this frame" });
    } catch (error) {
      console.error(`anchor: ${describeError(error)} (bulletins will fall back to text-to-video)`);
    }
  }

  const tracker = new Tracker();
  await tracker.init();
  const desk = new Desk(tracker);
  await logEvent({ step: "desk.online", sponsor: "desk", status: "ok", message: "Newsroom online" });
  await desk.resume();

  loop("inbox", 4, () => desk.handleInbox());
  loop("firehose", config.worker.ingestEverySec, () => tracker.ingestArchive());
  loop("track", config.worker.trackEverySec, () => tracker.pollTracked(), 20);
  loop("detect", config.worker.detectEverySec, () => desk.detect(), 45);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
