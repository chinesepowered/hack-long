import { anchorKeyframe } from "@/lib/anchor";
import { downloadTo, submitEnhance, submitVideo, waitForResult, type BflTask } from "@/lib/bfl";
import { config, enabled } from "@/lib/config";
import { logEvent, type Sponsor } from "@/lib/events";
import { fetchReadme, fetchRepos } from "@/lib/github";
import { labelRepo, type RepoLabel } from "@/lib/liquid";
import { media, mediaPath } from "@/lib/media";
import {
  followProgress,
  getResearch,
  socialBuzz,
  startResearch,
  waitForRun,
  type Research,
  type ResearchRun,
} from "@/lib/nimble";
import { describeError, insert, query } from "@/lib/rawtree";
import { speakableName, videoPrompt, writeScript, type Script } from "@/lib/script";
import * as sql from "@/lib/sql";
import fs from "node:fs/promises";
import type { Tracker } from "./tracker";

export interface Metrics {
  s1h: number;
  s6h: number;
  s24h: number;
  coveredSince: number;
}

export interface StoryRequest {
  repo: string;
  trigger: "auto" | "request";
  metrics?: Metrics;
  /** Set when resuming a story after a restart. */
  storyId?: string;
  /** Step name -> recorded data, when resuming. */
  prior?: Map<string, unknown>;
}

type Row = Record<string, unknown>;

export async function repoMetrics(repo: string): Promise<Metrics> {
  const [row] = await query<Row>("story: velocity", sql.repoVelocitySql(repo));
  return {
    s1h: Number(row?.s1h) || 0,
    s6h: Number(row?.s6h) || 0,
    s24h: Number(row?.s24h) || 0,
    coveredSince: Number(row?.covered_since) || 0,
  };
}

function storyIdFor(repo: string): string {
  return `${Date.now().toString(36)}-${repo.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`.slice(0, 60);
}

function clock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(11, 16) + " UTC";
}

function researchPrompt(repo: string, description: string, metrics: Metrics, stargazers: number, memory: Row[]): string {
  const lines = [
    `The GitHub repository ${repo} is gaining stars unusually fast right now: ${metrics.s1h} new stars in the last hour, ${stargazers.toLocaleString("en-US")} in total.`,
    `Its description: ${description || "(none)"}.`,
  ];
  if (memory.length) {
    lines.push(
      `We last reported on it at ${clock(Number(memory[0].ts))}, when it had ${Number(memory[0].stargazers).toLocaleString("en-US")} stars. Focus on what is new since then.`,
    );
  }
  lines.push(
    "Find out:",
    "1. What it is and what problem it solves, in plain English.",
    "2. Who built it (company, lab, or person).",
    "3. Why it is getting attention right now: a launch, release, announcement, viral post or news coverage, with dates.",
    "4. Where developers are discussing it (Hacker News, Reddit, X, blogs) and what they are saying.",
    "Be specific and cite sources.",
  );
  return lines.join("\n");
}

/** FLUX credits spent over the last 24 hours, from what the desk recorded in RawTree. */
async function fluxCreditsSpent(): Promise<number> {
  const [row] = await query<Row>("budget: FLUX spend", sql.fluxSpendSql(24)).catch(() => [] as Row[]);
  return Number(row?.credits) || 0;
}

export async function runStory(request: StoryRequest, tracker: Tracker): Promise<void> {
  const repo = request.repo;
  const storyId = request.storyId ?? storyIdFor(repo);
  const prior = request.prior ?? new Map<string, unknown>();
  const log = (step: string, sponsor: Sponsor, message: string, data?: unknown, status?: "info" | "ok" | "error" | "progress") =>
    logEvent({ story_id: storyId, repo, step, sponsor, message, data, status });

  try {
    const snapshot = tracker.latest.get(repo) ?? (await fetchRepos([repo]))[0];
    if (!snapshot) throw new Error("repository not found on GitHub");
    const metrics = request.metrics ?? (await repoMetrics(repo));
    const trigger = (prior.get("story.started") as { trigger?: string } | undefined)?.trigger ?? request.trigger;

    if (prior.has("story.started")) {
      await log("story.resumed", "desk", `Resuming after a restart: ${[...prior.keys()].pop()} was the last step on record`);
    } else {
      await log(
        "story.started",
        "desk",
        trigger === "request"
          ? `Assignment from the floor: cover ${repo} (${metrics.s1h} stars in the last hour)`
          : `Breakout detected: ${repo} gained ${metrics.s1h} stars in the last hour`,
        { trigger, metrics, stargazers: snapshot.stargazerCount },
      );
    }

    // 1. Long-horizon memory, straight from RawTree.
    const memory = await query<Row>("story: memory", sql.memorySql(repo)).catch(() => [] as Row[]);
    await log(
      "memory.checked",
      "rawtree",
      memory.length
        ? `Memory: covered ${memory.length} time${memory.length > 1 ? "s" : ""} before, last at ${clock(Number(memory[0].ts))} ("${memory[0].headline}")`
        : "Memory: first time this desk covers it",
      { previous: memory },
    );

    const readme = await fetchReadme(repo);

    // 2. On-device triage with Liquid LFM2.5.
    let label = (prior.get("liquid.labeled") as RepoLabel | undefined) ?? null;
    if (!label) {
      label = await labelRepo({
        repo,
        description: snapshot.description,
        topics: snapshot.topics,
        language: snapshot.language,
        readme,
      }).catch((error) => {
        console.error("liquid label failed:", describeError(error));
        return null;
      });
      if (label) {
        await insert("labels", { repo, ...label, ts: new Date().toISOString() });
        await log("liquid.labeled", "liquid", `On-device ${label.model}: ${label.category}, "${label.one_liner}" (${label.latency_ms} ms, $0)`, label);
      } else {
        await log("liquid.skipped", "liquid", "On-device model not running; skipping local triage");
      }
    }

    // 3. Nimble: social pulse, then a cited deep-research run.
    let buzz: { title: string; url: string }[] = [];
    let research: Research | null = null;
    if (enabled.nimble()) {
      try {
        const found = await socialBuzz(`"${speakableName(repo)}" ${repo}`);
        buzz = found.results.map((r) => ({ title: r.title, url: r.url }));
        await insert("mentions", { story_id: storyId, repo, ts: new Date().toISOString(), total_results: found.total_results, results: found.results });
        await log("nimble.buzz", "nimble", `Social pulse: ${found.total_results} posts this week`, { top: buzz.slice(0, 5) });
      } catch (error) {
        console.error("nimble search failed:", describeError(error));
      }

      let run = prior.get("nimble.started") as ResearchRun | undefined;
      if (!run) {
        run = await startResearch(researchPrompt(repo, snapshot.description, metrics, snapshot.stargazerCount, memory));
        await log("nimble.started", "nimble", `Web Search Agent "${config.nimble.agentName}" is researching (effort: ${run.effort})`, run);
      }
      const abort = new AbortController();
      let lastMessage = "";
      let lastAt = 0;
      const progress = followProgress(
        run,
        (message) => {
          if (message === lastMessage || Date.now() - lastAt < 300) return;
          lastMessage = message;
          lastAt = Date.now();
          void log("nimble.progress", "nimble", message, undefined, "progress");
        },
        abort.signal,
      );
      const status = await waitForRun(run);
      abort.abort();
      await progress;
      if (status === "completed") {
        research = await getResearch(run);
        await insert("research", {
          story_id: storyId,
          repo,
          ts: new Date().toISOString(),
          run_id: run.runId,
          agent_id: run.agentId,
          content: research.content,
          confidence: research.confidence,
          claims: research.claims,
          sources: research.sources,
          raw: research.raw,
        });
        const high = research.claims.filter((c) => c.confidence === "high").length;
        await log(
          "nimble.completed",
          "nimble",
          `Research done: ${research.claims.length} cited claims (${high} high confidence), ${research.sources.length} sources`,
          { claims: research.claims.length, confidence: research.confidence },
          "ok",
        );
      } else {
        await log("nimble.failed", "nimble", `Research run ended as ${status}; writing from GitHub data only`, undefined, "error");
      }
    }

    // 4. The script.
    let script = prior.get("script.written") as Script | undefined;
    if (!script) {
      script = await writeScript({
        repo,
        description: snapshot.description,
        language: snapshot.language,
        createdAt: snapshot.createdAt,
        stargazers: snapshot.stargazerCount,
        s1h: metrics.s1h,
        s6h: metrics.s6h,
        s24h: metrics.s24h,
        coveredSinceHours: metrics.coveredSince ? (Date.now() / 1000 - metrics.coveredSince) / 3600 : 6,
        oneLiner: label?.one_liner,
        category: label?.category,
        readme,
        research,
        buzz,
        memory: memory.map((m) => ({
          ts: clock(Number(m.ts)),
          headline: String(m.headline),
          dialogue: String(m.dialogue),
          stargazers: Number(m.stargazers) || 0,
        })),
      });
      await log("script.written", "llm", `Script by ${script.writer}: "${script.headline}"`, script);
    }

    // 5. FLUX 3: the anchor reads it on camera, lip-synced.
    let videoFile = "";
    let draftCacheFile = "";
    let cost = 0;
    let anchorId = "";
    const resumingVideo = prior.has("flux.submitted");
    const spent = enabled.bfl() && !resumingVideo ? await fluxCreditsSpent() : 0;
    if (enabled.bfl() && !resumingVideo && trigger === "auto" && !config.bfl.autoVideo) {
      await log("flux.skipped", "flux", "Auto-detected story airs as text to save FLUX credits; assign it to get a video");
    } else if (enabled.bfl() && !resumingVideo && spent >= config.bfl.dailyBudgetCredits) {
      await log("flux.skipped", "flux", `Daily FLUX budget reached (${Math.round(spent)} of ${config.bfl.dailyBudgetCredits} credits); publishing as text`);
    } else if (enabled.bfl()) {
      // A video failure (no credits, moderation, timeout) never kills the story: it airs as text.
      try {
        let task = prior.get("flux.submitted") as (BflTask & { draft: boolean; anchorId?: string }) | undefined;
        if (!task) {
          const keyframe = await anchorKeyframe();
          const submitted = await submitVideo({
            prompt: videoPrompt(script.dialogue),
            keyframe,
            duration: config.bfl.duration,
            draft: config.bfl.draft,
            resolution: config.bfl.resolution,
          });
          task = { ...submitted, draft: config.bfl.draft, anchorId: keyframe ? config.anchor.id : "improvised" };
          await log(
            "flux.submitted",
            "flux",
            `FLUX 3 ${task.draft ? "draft" : "render"} submitted: ${config.bfl.duration}s, ${keyframe ? `${config.anchor.name} pinned as frame one` : "no anchor still, improvising"}, audio on`,
            task,
          );
        }
        // Renders started before the anchor was pinned carry no anchorId; keep them out of the rundown.
        anchorId = task.anchorId ?? "improvised";
        const result = await waitForResult(task, (status) => void log("flux.status", "flux", `FLUX 3: ${status}`, undefined, "progress"));
        if (result.status !== "Ready" || !result.result?.sample) throw new Error(`FLUX 3 ended as "${result.status}"`);
        videoFile = media.bulletinVideo(storyId);
        await downloadTo(result.result.sample, mediaPath(videoFile));
        if (typeof result.result.draft_cache === "string") {
          draftCacheFile = media.draftCache(storyId);
          await downloadTo(result.result.draft_cache, mediaPath(draftCacheFile)).catch(() => {
            draftCacheFile = "";
          });
        }
        cost = result.cost ?? 0;
        await log("flux.ready", "flux", `Bulletin rendered (${cost} credits)`, { videoFile, draftCacheFile, cost }, "ok");
      } catch (error) {
        videoFile = "";
        draftCacheFile = "";
        await log("flux.skipped", "flux", `FLUX 3 unavailable (${describeError(error).slice(0, 120)}); publishing a text bulletin`, undefined, "error");
      }
    } else {
      await log("flux.skipped", "flux", "No BFL key; publishing a text bulletin");
    }

    // 6. Publish.
    const confidence = research?.confidence ?? "";
    await insert("bulletins", {
      story_id: storyId,
      repo,
      ts: new Date().toISOString(),
      trigger_kind: trigger,
      anchor_id: videoFile ? anchorId : "",
      headline: script.headline,
      dialogue: script.dialogue,
      captions_json: JSON.stringify(script.captions),
      video_file: videoFile,
      poster_file: media.anchor,
      draft_cache_file: draftCacheFile,
      is_final: config.bfl.draft ? 0 : 1,
      stars_1h: metrics.s1h,
      stars_6h: metrics.s6h,
      stars_24h: metrics.s24h,
      stargazers: snapshot.stargazerCount,
      category: label?.category ?? "",
      one_liner: label?.one_liner ?? "",
      confidence,
      writer: script.writer,
      cost_credits: cost,
    });
    await log("bulletin.published", "desk", `ON AIR: "${script.headline}"`, { videoFile }, "ok");
  } catch (error) {
    await log("story.failed", "desk", `Story failed: ${describeError(error)}`, { error: describeError(error) }, "error");
  }
}

/** Re-render a draft at full quality: same shot, same seed, nothing re-interpreted. */
export async function enhanceStory(storyId: string): Promise<void> {
  const [row] = await query<Row>("enhance: find bulletin", `${sql.bulletinsSql(200)}`).then((rows) =>
    rows.filter((r) => r.story_id === storyId),
  );
  const log = (step: string, message: string, data?: unknown, status?: "info" | "ok" | "error" | "progress") =>
    logEvent({ story_id: storyId, repo: String(row?.repo ?? ""), step, sponsor: "flux", message, data, status });
  try {
    if (!row?.draft_cache_file) throw new Error("no draft cache on record for this bulletin");
    const spent = await fluxCreditsSpent();
    if (spent >= config.bfl.dailyBudgetCredits) throw new Error(`daily FLUX budget reached (${Math.round(spent)} credits)`);
    const bundle = (await fs.readFile(mediaPath(String(row.draft_cache_file)))).toString("base64");
    const task = await submitEnhance(bundle, config.bfl.resolution === "hd" ? "fhd" : config.bfl.resolution);
    await log("enhance.submitted", "Rendering the chosen draft at full quality", task);
    const result = await waitForResult(task, (status) => void log("enhance.status", `Final render: ${status}`, undefined, "progress"));
    if (result.status !== "Ready" || !result.result?.sample) throw new Error(`final render ended as "${result.status}"`);
    const videoFile = media.bulletinFinal(storyId);
    await downloadTo(result.result.sample, mediaPath(videoFile));
    await insert("bulletins", {
      ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "ts")),
      captions_json: row.captions_json,
      video_file: videoFile,
      is_final: 1,
      cost_credits: (Number(row.cost_credits) || 0) + (result.cost ?? 0),
      ts: new Date().toISOString(),
    });
    await log("enhance.ready", `Final cut is on air (${result.cost ?? 0} credits)`, { videoFile }, "ok");
  } catch (error) {
    await log("enhance.failed", `Final render failed: ${describeError(error)}`, undefined, "error");
  }
}
