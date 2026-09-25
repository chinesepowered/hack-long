import { config, isBreakout } from "@/lib/config";
import { logEvent } from "@/lib/events";
import { fetchReadme, fetchRepos, isRepoName } from "@/lib/github";
import { labelRepo } from "@/lib/liquid";
import { localAvailable } from "@/lib/llm";
import { describeError, insert, query } from "@/lib/rawtree";
import * as sql from "@/lib/sql";
import { enhanceStory, repoMetrics, runStory, type StoryRequest } from "./story";
import type { Tracker } from "./tracker";

type Row = Record<string, unknown>;

function parse(json: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(json || "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The editor: decides what gets covered, runs stories with bounded concurrency, and reads the inbox. */
export class Desk {
  private active = new Set<string>();
  private queue: StoryRequest[] = [];
  private handled = new Set<string>();
  private budgetNoticeAt = 0;
  private lastBreakouts = new Set<string>();
  private labeled: Set<string> | null = null;

  constructor(private tracker: Tracker) {}

  private enqueue(request: StoryRequest) {
    if (this.active.has(request.repo) || this.queue.some((q) => q.repo === request.repo)) return;
    // Requests from the floor jump the queue.
    if (request.trigger === "request") this.queue.unshift(request);
    else this.queue.push(request);
    this.pump();
  }

  private pump() {
    while (this.active.size < config.worker.concurrency && this.queue.length) {
      const request = this.queue.shift()!;
      this.active.add(request.repo);
      void runStory(request, this.tracker).finally(() => {
        this.active.delete(request.repo);
        this.pump();
      });
    }
  }

  /** Stories that were mid-flight when the worker stopped pick up where they left off. */
  async resume() {
    let rows: Row[] = [];
    try {
      rows = await query<Row>("resume: unfinished stories", sql.unfinishedStoriesSql());
    } catch {
      return;
    }
    for (const row of rows) {
      const storyId = String(row.story_id);
      const events = await query<Row>("resume: story events", sql.storyEventsSql(storyId));
      const prior = new Map<string, unknown>();
      for (const event of events) {
        const data = parse(event.data_json);
        if (Object.keys(data).length) prior.set(String(event.step), data);
        else if (!prior.has(String(event.step))) prior.set(String(event.step), {});
      }
      const started = prior.get("story.started") as { trigger?: "auto" | "request" } | undefined;
      this.tracker.pin(String(row.repo));
      this.enqueue({ repo: String(row.repo), trigger: started?.trigger ?? "auto", storyId, prior });
    }
    if (rows.length) {
      await logEvent({ step: "desk.resumed", sponsor: "desk", message: `Picked up ${rows.length} unfinished stor${rows.length === 1 ? "y" : "ies"} from RawTree` });
    }
  }

  async detect() {
    const board = await query<Row>("detect: star velocity", sql.boardSql(30));
    const repos = board.map((r) => String(r.repo));
    this.tracker.setHot(repos);
    if (!repos.length) return;
    const meta = await query<Row>("detect: snapshots", sql.repoMetaSql(repos));
    const entries = board.map((row) => {
      const m = meta.find((x) => x.repo === row.repo) ?? {};
      return {
        repo: String(row.repo),
        s1h: Number(row.s1h) || 0,
        s6h: Number(row.s6h) || 0,
        s24h: Number(row.s24h) || 0,
        coveredSince: Number(row.covered_since) || 0,
        stargazers: Number(m.stargazers) || 0,
        createdAt: String(m.created_at ?? ""),
      };
    });
    await this.labelBoard(repos);
    const breakouts = entries.filter((e) => e.stargazers > 0 && isBreakout(e));
    const newlyHot = breakouts.filter((b) => !this.lastBreakouts.has(b.repo));
    this.lastBreakouts = new Set(breakouts.map((b) => b.repo));
    if (newlyHot.length) {
      await logEvent({
        step: "detect.breakouts",
        sponsor: "rawtree",
        message: `Breakouts on the board: ${newlyHot
          .slice(0, 5)
          .map((b) => `${b.repo} (+${b.s1h}/h)`)
          .join(", ")}${newlyHot.length > 5 ? ` and ${newlyHot.length - 5} more` : ""}`,
        data: { breakouts: newlyHot },
      });
    }
    if (!config.worker.autoCover) return;

    for (const candidate of breakouts) {
      if (this.active.has(candidate.repo) || this.queue.some((q) => q.repo === candidate.repo)) continue;
      const memory = await query<Row>("detect: memory", sql.memorySql(candidate.repo, 1)).catch(() => [] as Row[]);
      const lastCovered = Number(memory[0]?.ts) || 0;
      if (lastCovered && Date.now() / 1000 - lastCovered < config.worker.cooldownHours * 3600) continue;
      const [recent] = await query<Row>("detect: auto budget", sql.autoBulletinsSinceSql(1)).catch(() => [{ n: 0 }]);
      if ((Number(recent?.n) || 0) + this.active.size >= config.worker.maxAutoPerHour) {
        if (Date.now() - this.budgetNoticeAt > 30 * 60_000) {
          this.budgetNoticeAt = Date.now();
          await logEvent({ step: "desk.budget", sponsor: "desk", message: `Hourly auto-bulletin budget reached (${config.worker.maxAutoPerHour}); holding ${candidate.repo}` });
        }
        return;
      }
      this.enqueue({ repo: candidate.repo, trigger: "auto", metrics: candidate });
      return; // at most one new auto story per detection cycle
    }
  }

  /**
   * On-device triage for the whole board, not just stories: a few unlabeled repos per
   * cycle go through Liquid LFM2.5 on this machine, so every row gets a category for $0.
   */
  private async labelBoard(repos: string[]) {
    if (!(await localAvailable())) return;
    if (!this.labeled) {
      this.labeled = new Set<string>();
      try {
        const rows = await query<Row>("labels: already labeled", sql.labeledReposSql());
        rows.forEach((row) => this.labeled!.add(String(row.repo)));
      } catch {
        // No labels table yet.
      }
    }
    for (const repo of repos.filter((r) => !this.labeled!.has(r)).slice(0, 4)) {
      this.labeled.add(repo);
      const snapshot = this.tracker.latest.get(repo);
      if (!snapshot) continue;
      try {
        const readme = await fetchReadme(repo).catch(() => "");
        const label = await labelRepo({
          repo,
          description: snapshot.description,
          topics: snapshot.topics,
          language: snapshot.language,
          readme: readme.slice(0, 800),
        });
        if (!label) continue;
        await insert("labels", { repo, ...label, ts: new Date().toISOString(), source: "board" });
        await logEvent({
          repo,
          step: "liquid.labeled",
          sponsor: "liquid",
          message: `On-device ${label.model}: ${label.category}, "${label.one_liner}" (${label.latency_ms} ms, $0)`,
          data: label,
        });
      } catch (error) {
        console.error(`liquid label ${repo}: ${describeError(error)}`);
      }
    }
  }

  /** The inbox: judges ask for a repo (or a final render) from the UI; requests arrive as rows in RawTree. */
  async handleInbox() {
    let requests: Row[] = [];
    let enhances: Row[] = [];
    let done: Row[] = [];
    try {
      [requests, enhances, done] = await Promise.all([
        query<Row>("inbox: cover requests", sql.coverRequestsSql()),
        query<Row>("inbox: final renders", sql.enhanceRequestsSql()),
        query<Row>("inbox: handled", sql.acceptedRequestsSql()),
      ]);
    } catch {
      return; // agent_events does not exist until the first event is written
    }
    done.forEach((row) => {
      const id = parse(row.data_json).request_id;
      if (typeof id === "string") this.handled.add(id);
    });

    for (const row of requests) {
      const data = parse(row.data_json);
      const requestId = String(data.request_id ?? "");
      if (!requestId || this.handled.has(requestId)) continue;
      this.handled.add(requestId);
      const asked = String(row.repo);
      try {
        const [snapshot] = isRepoName(asked) ? await fetchRepos([asked]) : [];
        if (!snapshot) {
          await logEvent({ repo: asked, step: "cover.rejected", sponsor: "desk", status: "error", message: `No public repo called ${asked}`, data: { request_id: requestId } });
          continue;
        }
        const repo = snapshot.repo;
        await logEvent({ repo, step: "cover.accepted", sponsor: "desk", message: `On it: ${repo}`, data: { request_id: requestId } });
        this.tracker.pin(repo);
        await this.tracker.pollRepos([repo]);
        this.enqueue({ repo, trigger: "request", metrics: await repoMetrics(repo) });
      } catch (error) {
        await logEvent({ repo: asked, step: "cover.rejected", sponsor: "desk", status: "error", message: `Could not take ${asked}: ${describeError(error)}`, data: { request_id: requestId } });
      }
    }

    for (const row of enhances) {
      const data = parse(row.data_json);
      const requestId = String(data.request_id ?? "");
      if (!requestId || this.handled.has(requestId)) continue;
      this.handled.add(requestId);
      await logEvent({ story_id: String(row.story_id), step: "enhance.accepted", sponsor: "flux", message: "Final render requested", data: { request_id: requestId } });
      void enhanceStory(String(row.story_id));
    }
  }
}
