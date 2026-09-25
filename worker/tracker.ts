import { config } from "@/lib/config";
import { logEvent } from "@/lib/events";
import {
  archiveHour,
  archiveUrl,
  downloadHour,
  fetchRepoEvents,
  fetchRepos,
  publishedHours,
  type GithubEvent,
  type RepoSnapshot,
} from "@/lib/github";
import { describeError, insert, insertFromUrl, query } from "@/lib/rawtree";
import * as sql from "@/lib/sql";

/** Insert in batches; a batch RawTree rejects is split until the bad rows are isolated and skipped. */
async function insertResilient(table: string, rows: object[], batchSize = 1000): Promise<number> {
  let inserted = 0;
  const attempt = async (batch: object[]): Promise<void> => {
    if (!batch.length) return;
    try {
      inserted += await insert(table, batch, batch.length);
    } catch (error) {
      if (batch.length === 1) {
        console.error(`skipped one row RawTree could not parse: ${describeError(error).slice(0, 120)}`);
        return;
      }
      const middle = Math.ceil(batch.length / 2);
      await attempt(batch.slice(0, middle));
      await attempt(batch.slice(middle));
    }
  };
  for (let i = 0; i < rows.length; i += batchSize) await attempt(rows.slice(i, i + batchSize));
  return inserted;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * Keeps RawTree fed:
 *  - the hourly GH Archive firehose (server-side URL ingest when possible)
 *  - GraphQL snapshots of exact star counts for every tracked repo
 *  - the raw per-repo event feed, which is the star log velocity is computed from
 */
export class Tracker {
  private urlIngestWorks: boolean | null = null;
  private loadedHours = new Set<string>();
  private lastEventId = new Map<string, bigint>();
  private candidates: string[] = [];
  private pinned = new Set<string>();
  private hot: string[] = [];
  readonly latest = new Map<string, RepoSnapshot>();

  /** Resume from what RawTree already holds, so a restart never re-ingests or double-logs. */
  async init() {
    try {
      const hours = await query<{ archive_hour: string }>("resume: loaded hours", sql.ingestedHoursSql());
      // RawTree infers date-like strings as DateTime, so "2026-09-25-17" comes back as
      // "2026-09-25 17:00:00". Normalize back to GH Archive's hour key.
      hours.forEach((h) => {
        const asDate = new Date(`${String(h.archive_hour).replace(" ", "T")}Z`);
        this.loadedHours.add(Number.isNaN(asDate.getTime()) ? String(h.archive_hour) : archiveHour(asDate));
      });
    } catch {
      // First run: the table does not exist yet.
    }
    try {
      const ids = await query<{ repo: string; max_id: string }>("resume: last event ids", sql.lastEventIdsSql());
      ids.forEach((row) => this.lastEventId.set(row.repo, BigInt(row.max_id || "0")));
      this.hot = ids.map((row) => row.repo);
    } catch {
      // First run.
    }
    if (this.loadedHours.size) await this.refreshCandidates().catch(() => undefined);
  }

  pin(repo: string) {
    this.pinned.add(repo);
  }

  setHot(repos: string[]) {
    this.hot = repos;
  }

  tracked(): string[] {
    return [...new Set([...this.pinned, ...this.hot.slice(0, 15), ...this.candidates])].slice(0, config.worker.maxTracked);
  }

  /* ------------------------------------------------------------ firehose */

  async ingestArchive() {
    const pending = publishedHours(config.worker.backfillHours)
      .filter((hour) => !this.loadedHours.has(hour))
      .reverse(); // newest first, so the board has fresh data within a minute
    for (const hour of pending) {
      try {
        await this.ingestHour(hour);
        // Rank candidates as soon as the newest hour lands; the rest of the backfill can take minutes.
        if (!this.candidates.length) await this.refreshCandidates().catch(() => undefined);
      } catch (error) {
        await logEvent({ step: "ingest.failed", sponsor: "rawtree", status: "error", message: `GH Archive ${hour}: ${describeError(error)}` });
      }
    }
    if (pending.length || !this.candidates.length) await this.refreshCandidates();
  }

  private async ingestHour(hour: string) {
    const started = performance.now();
    let mode = "";
    let inserted: number | null = null;
    if (this.urlIngestWorks !== false) {
      try {
        inserted = await insertFromUrl("gh_events", archiveUrl(hour));
        mode = "url";
        this.urlIngestWorks = true;
      } catch (error) {
        // URL import infers one type per JSON path from a sample; an hour where GitHub mixes
        // types in the same field (e.g. issue field values) is rejected, so stream that hour instead.
        await logEvent({
          step: "ingest.fallback",
          sponsor: "rawtree",
          message: `URL ingest rejected ${hour}h (${describeError(error).slice(0, 90)}); streaming it through the JSON insert API`,
        });
        if (this.urlIngestWorks === null) this.urlIngestWorks = false;
      }
    }
    if (!mode) {
      const types = config.worker.gharchiveTypes === "all" ? null : new Set(config.worker.gharchiveTypes.split(","));
      const rows = await downloadHour(hour, types);
      inserted = await insertResilient("gh_events", rows);
      mode = "stream";
    }
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    await insert("ingest_log", { archive_hour: hour, mode, inserted, seconds, ts: new Date().toISOString() });
    this.loadedHours.add(hour);
    await logEvent({
      step: "ingest.hour",
      sponsor: "rawtree",
      status: "ok",
      message: `Loaded ${inserted === null ? "an hour of" : inserted.toLocaleString("en-US")} raw GitHub events (${hour}h UTC) via ${mode === "url" ? "server-side URL ingest" : "streamed insert"} in ${seconds}s`,
      data: { hour, mode, inserted, seconds },
    });
  }

  async refreshCandidates() {
    const rows = await query<{ repo: string; stars: string; forks: string; people: string; heat: string }>(
      "candidates: firehose ranking",
      sql.candidatesSql(config.worker.candidateLimit),
    );
    const previous = new Set(this.candidates);
    this.candidates = rows.map((r) => r.repo);
    const fresh = this.candidates.filter((repo) => !previous.has(repo));
    if (fresh.length) {
      await logEvent({
        step: "candidates.ranked",
        sponsor: "rawtree",
        message: `Firehose ranking: ${rows.length} candidates, top ${this.candidates.slice(0, 3).join(", ")}`,
        data: { top: rows.slice(0, 10) },
      });
    }
  }

  /* ------------------------------------------------------ tracked repos */

  async pollTracked() {
    await this.pollRepos(this.tracked());
  }

  /** Snapshot star counts and pull new raw events. Returns the new events per repo. */
  async pollRepos(names: string[]): Promise<Map<string, GithubEvent[]>> {
    const fresh = new Map<string, GithubEvent[]>();
    if (!names.length) return fresh;
    const snapshots = await fetchRepos(names);
    const fetchedAt = new Date().toISOString();
    await insert(
      "repos",
      snapshots.map((s) => ({
        repo: s.repo,
        description: s.description,
        url: s.url,
        homepage: s.homepage,
        language: s.language,
        language_color: s.languageColor,
        topics: s.topics,
        topics_csv: s.topics.join(","),
        stargazer_count: s.stargazerCount,
        fork_count: s.forkCount,
        created_at: s.createdAt,
        pushed_at: s.pushedAt,
        owner_avatar: s.ownerAvatar,
        is_archived: s.isArchived,
        is_fork: s.isFork,
        fetched_at: fetchedAt,
      })),
    );
    snapshots.forEach((s) => this.latest.set(s.repo, s));

    let newStars = 0;
    await pool(
      snapshots.filter((s) => !s.isArchived),
      4,
      async (snap) => {
        const after = this.lastEventId.get(snap.repo);
        try {
          const events = await fetchRepoEvents(snap.repo, after, after === undefined ? 3 : 2);
          if (!events.length) return;
          await insert("repo_events", events, 300);
          this.lastEventId.set(snap.repo, BigInt(events[0].id));
          fresh.set(snap.repo, events);
          newStars += events.filter((e) => e.type === "WatchEvent").length;
        } catch (error) {
          console.error(`events ${snap.repo}: ${describeError(error)}`);
        }
      },
    );
    if (newStars > 0) {
      await logEvent({
        step: "track.stars",
        sponsor: "github",
        message: `+${newStars} new stars across ${fresh.size} repos logged to RawTree`,
        data: { repos: snapshots.length, newStars },
      });
    }
    return fresh;
  }
}
