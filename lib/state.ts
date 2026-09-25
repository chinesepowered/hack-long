import { anchorExists } from "./anchor";
import { config, enabled, isBreakout } from "./config";
import { localAvailableNow } from "./llm";
import { media, mediaUrl } from "./media";
import { describeError, listTables, queryWithStats, recentQueries, type TableStat } from "./rawtree";
import * as sql from "./sql";

export interface BoardEntry {
  repo: string;
  s1h: number;
  s6h: number;
  s24h: number;
  coveredSince: number;
  lastStar: number;
  stargazers: number;
  snapshotGain1h: number;
  description: string;
  language: string;
  languageColor: string;
  createdAt: string;
  avatar: string;
  topics: string[];
  spark: number[];
  category: string;
  oneLiner: string;
  labelLatencyMs: number;
  labelModel: string;
  breakout: boolean;
}

export interface Bulletin {
  storyId: string;
  repo: string;
  ts: number;
  headline: string;
  dialogue: string;
  videoUrl: string;
  posterUrl: string;
  captions: { text: string; url: string; domain: string; confidence: string }[];
  stars1h: number;
  stars24h: number;
  stargazers: number;
  category: string;
  oneLiner: string;
  confidence: string;
  costCredits: number;
  isFinal: boolean;
}

export interface FeedItem {
  ts: number;
  storyId: string;
  repo: string;
  step: string;
  sponsor: string;
  status: string;
  message: string;
}

export interface DashboardState {
  generatedAt: number;
  sponsors: Record<"rawtree" | "nimble" | "flux" | "llm" | "github" | "liquid", boolean> & { liquidLabel: string };
  database: string;
  /** Whether the anchor still exists yet (it is generated on the first worker run). */
  anchor: boolean;
  tables: TableStat[];
  board: BoardEntry[];
  ticker: { repo: string; login: string; avatar: string; ts: number }[];
  feed: FeedItem[];
  /** The last 20 minutes of broadcast-story steps, for the production strip. */
  storyFeed: FeedItem[];
  bulletins: Bulletin[];
  firehose: { hour: number; events: number; stars: number }[];
  queries: ReturnType<typeof recentQueries>;
  /** RawTree execution time per dashboard query, keyed by query label. */
  timings: Record<string, { elapsedMs: number; rowsRead: number }>;
  latency: { medianMs: number; maxMs: number; count: number };
  errors: string[];
  /** True only for the dev-only sample state served at /?fixture=1. */
  fixture?: boolean;
}

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value) || 0;
const s = (value: unknown) => (value === null || value === undefined ? "" : String(value));

const SPARK_BUCKETS = 24; // 20-minute buckets over 8 hours
const BUCKET_SECONDS = 20 * 60;

function sparkSeries(rows: Row[], repo: string): number[] {
  const nowBucket = Math.floor(Date.now() / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;
  const series = new Array<number>(SPARK_BUCKETS).fill(0);
  for (const row of rows) {
    if (s(row.repo) !== repo) continue;
    const index = SPARK_BUCKETS - 1 - Math.round((nowBucket - n(row.bucket)) / BUCKET_SECONDS);
    if (index >= 0 && index < SPARK_BUCKETS) series[index] = n(row.n);
  }
  return series;
}

function parseCaptions(raw: string): Bulletin["captions"] {
  try {
    const parsed = JSON.parse(raw) as Bulletin["captions"];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function build(): Promise<DashboardState> {
  const errors: string[] = [];
  const state: DashboardState = {
    generatedAt: Date.now(),
    sponsors: {
      rawtree: enabled.rawtree(),
      nimble: enabled.nimble(),
      flux: enabled.bfl(),
      llm: enabled.llm(),
      github: enabled.github(),
      liquid: localAvailableNow(),
      liquidLabel: config.local.label,
    },
    database: config.rawtree.database,
    anchor: await anchorExists(),
    tables: [],
    board: [],
    ticker: [],
    feed: [],
    storyFeed: [],
    bulletins: [],
    firehose: [],
    queries: [],
    timings: {},
    latency: { medianMs: 0, maxMs: 0, count: 0 },
    errors,
  };
  if (!enabled.rawtree()) {
    errors.push("RAWTREE_API_KEY is not set");
    return state;
  }

  try {
    state.tables = await listTables();
  } catch (error) {
    errors.push(`tables: ${describeError(error)}`);
    return state;
  }
  const has = (table: string) => state.tables.some((t) => t.name === table);
  const safe = async (label: string, table: string, text: string): Promise<Row[]> => {
    if (!has(table)) return [];
    try {
      const { rows, stats } = await queryWithStats<Row>(label, text);
      state.timings[label] = { elapsedMs: stats.elapsedMs, rowsRead: stats.rowsRead };
      return rows;
    } catch (error) {
      errors.push(`${label}: ${describeError(error)}`);
      return [];
    }
  };

  const [boardRows, tickerRows, feedRows, bulletinRows, firehoseRows, storyRows] = await Promise.all([
    safe("board: star velocity", "repo_events", sql.boardSql(16)),
    safe("ticker: latest stars", "repo_events", sql.tickerSql(30)),
    safe("feed: agent flight recorder", "agent_events", sql.feedSql(50)),
    safe("bulletins", "bulletins", sql.bulletinsSql(12, config.anchor.id)),
    safe("firehose: events per hour", "gh_events", sql.firehoseSql()),
    safe("production: story steps", "agent_events", sql.recentStoryEventsSql(20)),
  ]);

  const repos = boardRows.map((r) => s(r.repo));
  const [metaRows, sparkRows, labelRows] = await Promise.all([
    repos.length ? safe("board: latest snapshots", "repos", sql.repoMetaSql(repos)) : Promise.resolve([]),
    repos.length ? safe("board: sparklines", "repo_events", sql.sparklineSql(repos)) : Promise.resolve([]),
    repos.length ? safe("board: on-device labels", "labels", sql.labelsSql(repos)) : Promise.resolve([]),
  ]);

  state.board = boardRows.map((row) => {
    const repo = s(row.repo);
    const meta = metaRows.find((m) => s(m.repo) === repo) ?? {};
    const label = labelRows.find((l) => s(l.repo) === repo) ?? {};
    const entry: BoardEntry = {
      repo,
      s1h: n(row.s1h),
      s6h: n(row.s6h),
      s24h: n(row.s24h),
      coveredSince: n(row.covered_since),
      lastStar: n(row.last_star),
      stargazers: n(meta.stargazers),
      snapshotGain1h: n(meta.snapshot_gain_1h),
      description: s(meta.description),
      language: s(meta.language),
      languageColor: s(meta.language_color),
      createdAt: s(meta.created_at),
      avatar: s(meta.avatar),
      topics: s(meta.topics).split(",").filter(Boolean),
      spark: sparkSeries(sparkRows, repo),
      category: s(label.category),
      oneLiner: s(label.one_liner),
      labelLatencyMs: n(label.latency_ms),
      labelModel: s(label.model),
      breakout: false,
    };
    entry.breakout = isBreakout(entry);
    return entry;
  });

  state.ticker = tickerRows.map((r) => ({ repo: s(r.repo), login: s(r.login), avatar: s(r.avatar), ts: n(r.ts) }));
  const toFeed = (r: Row): FeedItem => ({
    ts: n(r.ts),
    storyId: s(r.story_id),
    repo: s(r.repo),
    step: s(r.step),
    sponsor: s(r.sponsor),
    status: s(r.status),
    message: s(r.message),
  });
  state.storyFeed = storyRows.map(toFeed);
  state.feed = feedRows.map((r) => ({
    ts: n(r.ts),
    storyId: s(r.story_id),
    repo: s(r.repo),
    step: s(r.step),
    sponsor: s(r.sponsor),
    status: s(r.status),
    message: s(r.message),
  }));
  state.bulletins = bulletinRows.map((r) => ({
    storyId: s(r.story_id),
    repo: s(r.repo),
    ts: n(r.ts),
    headline: s(r.headline),
    dialogue: s(r.dialogue),
    videoUrl: mediaUrl(s(r.video_file)),
    posterUrl: mediaUrl(s(r.poster_file) || media.anchor),
    captions: parseCaptions(s(r.captions_json)),
    stars1h: n(r.stars_1h),
    stars24h: n(r.stars_24h),
    stargazers: n(r.stargazers),
    category: s(r.category),
    oneLiner: s(r.one_liner),
    confidence: s(r.confidence),
    costCredits: n(r.cost_credits),
    isFinal: n(r.is_final) === 1,
  }));
  state.firehose = firehoseRows.map((r) => ({ hour: n(r.hour_ts), events: n(r.events), stars: n(r.stars) })).reverse();
  state.queries = recentQueries(8);
  const times = Object.values(state.timings).map((t) => t.elapsedMs).sort((a, b) => a - b);
  state.latency = {
    medianMs: times.length ? times[Math.floor((times.length - 1) / 2)] : 0,
    maxMs: times.length ? times[times.length - 1] : 0,
    count: times.length,
  };
  return state;
}

let cache: { at: number; value: Promise<DashboardState> } | null = null;

/** Many viewers, one set of queries: results are shared for two seconds. */
export function getDashboardState(): Promise<DashboardState> {
  if (!cache || Date.now() - cache.at > 2000) {
    cache = { at: Date.now(), value: build() };
  }
  return cache.value;
}
