import { gunzipSync } from "node:zlib";
import { githubToken } from "./config";

/*
 * GitHub data sources (as of Sept 2026):
 *  - GH Archive: hourly dumps of the public event firehose. It is a sample now,
 *    good for spotting candidates, not for measuring them.
 *  - GraphQL: exact total star counts. Stargazer lists are no longer exposed
 *    (GraphQL returns none, REST /stargazers is 404), so we snapshot counts.
 *  - /repos/{owner}/{repo}/events: the raw per-repo event feed still includes
 *    WatchEvents (stars) with the user and timestamp. Polled continuously, it is
 *    a complete star log for every repo we track.
 */

/* ---------------------------------------------------------------- GH Archive */

/** GH Archive names hourly files like 2026-09-25-7 (UTC, hour not zero-padded). */
export function archiveHour(date: Date): string {
  const d = date.toISOString().slice(0, 10);
  return `${d}-${date.getUTCHours()}`;
}

export function archiveUrl(hour: string): string {
  return `https://data.gharchive.org/${hour}.json.gz`;
}

/** The last `count` hours whose files should already be published (they land ~5 min after the hour). */
export function publishedHours(count: number, now = new Date()): string[] {
  const latest = new Date(now.getTime() - 70 * 60 * 1000);
  latest.setUTCMinutes(0, 0, 0);
  const hours: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    hours.push(archiveHour(new Date(latest.getTime() - i * 3600 * 1000)));
  }
  return hours;
}

/** Fallback when server-side URL ingest is unavailable: download, filter, return raw rows. */
export async function downloadHour(hour: string, keepTypes: Set<string> | null): Promise<Record<string, unknown>[]> {
  const response = await fetch(archiveUrl(hour));
  if (!response.ok) throw new Error(`GH Archive ${hour}: HTTP ${response.status}`);
  const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (keepTypes && !keepTypes.has(String(event.type))) continue;
    rows.push(event);
  }
  return rows;
}

/* ----------------------------------------------------------------- helpers */

function headers(accept = "application/vnd.github+json"): Record<string, string> {
  const token = githubToken();
  return {
    Accept: accept,
    "User-Agent": "breakout-newsroom",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function isRepoName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
}

/* ----------------------------------------------------------------- GraphQL */

export interface RepoSnapshot {
  repo: string;
  description: string;
  url: string;
  homepage: string;
  language: string;
  languageColor: string;
  topics: string[];
  stargazerCount: number;
  forkCount: number;
  createdAt: string;
  pushedAt: string;
  ownerAvatar: string;
  isArchived: boolean;
  isFork: boolean;
}

interface GqlRepository {
  nameWithOwner: string;
  description: string | null;
  url: string;
  homepageUrl: string | null;
  stargazerCount: number;
  forkCount: number;
  createdAt: string;
  pushedAt: string | null;
  isArchived: boolean;
  isFork: boolean;
  primaryLanguage: { name: string; color: string | null } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  owner: { login: string; avatarUrl: string };
}

const REPO_FIELDS = `
  nameWithOwner description url homepageUrl stargazerCount forkCount createdAt pushedAt isArchived isFork
  primaryLanguage { name color }
  repositoryTopics(first: 6) { nodes { topic { name } } }
  owner { login avatarUrl }`;

/** Exact star counts and metadata for many repos, 20 per GraphQL request. Unknown repos are skipped. */
export async function fetchRepos(names: string[]): Promise<RepoSnapshot[]> {
  if (!githubToken()) throw new Error("No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.");
  const valid = [...new Set(names.filter(isRepoName))];
  const snapshots: RepoSnapshot[] = [];
  for (let i = 0; i < valid.length; i += 20) {
    const body = valid
      .slice(i, i + 20)
      .map((name, j) => {
        const [owner, repo] = name.split("/");
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${REPO_FIELDS} }`;
      })
      .join("\n");
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers("application/json"), "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { ${body} }` }),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const result = (await response.json()) as { data: Record<string, GqlRepository | null> | null };
    for (const r of Object.values(result.data ?? {})) {
      if (!r) continue;
      snapshots.push({
        repo: r.nameWithOwner,
        description: r.description ?? "",
        url: r.url,
        homepage: r.homepageUrl ?? "",
        language: r.primaryLanguage?.name ?? "",
        languageColor: r.primaryLanguage?.color ?? "",
        topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
        stargazerCount: r.stargazerCount,
        forkCount: r.forkCount,
        createdAt: r.createdAt,
        pushedAt: r.pushedAt ?? "",
        ownerAvatar: r.owner.avatarUrl,
        isArchived: r.isArchived,
        isFork: r.isFork,
      });
    }
  }
  return snapshots;
}

/* ------------------------------------------------------- per-repo event feed */

export interface GithubEvent {
  id: string;
  type: string;
  created_at: string;
  actor: { login: string; avatar_url?: string };
  repo: { name: string };
  [key: string]: unknown;
}

/**
 * Raw events for one repo, newest first, stopping once we reach `afterId`.
 * The API keeps up to 300 events per repo, 100 per page.
 */
export async function fetchRepoEvents(repo: string, afterId?: bigint, maxPages = 3): Promise<GithubEvent[]> {
  const events: GithubEvent[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/events?per_page=100&page=${page}`, {
      headers: headers(),
    });
    if (response.status === 404 || response.status === 422) break;
    if (!response.ok) throw new Error(`GitHub events ${repo}: HTTP ${response.status}`);
    const batch = (await response.json()) as GithubEvent[];
    let reachedKnown = false;
    for (const event of batch) {
      if (afterId !== undefined && BigInt(event.id) <= afterId) {
        reachedKnown = true;
        break;
      }
      events.push(event);
    }
    if (reachedKnown || batch.length < 100) break;
  }
  return events;
}

/** First ~1,800 characters of the README as plain text, for the classifier and script writer. */
export async function fetchReadme(repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}/readme`, {
    headers: headers("application/vnd.github.raw"),
  });
  if (!response.ok) return "";
  const raw = await response.text();
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);
}
