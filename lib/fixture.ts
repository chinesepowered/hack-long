import type { DashboardState } from "./state";

/**
 * Dev-only sample state (open /?fixture=1) so the UI can be built without keys.
 * Repos and sources are fictional on purpose; the UI labels this mode as sample data.
 */
export function fixtureState(): DashboardState {
  const now = Math.floor(Date.now() / 1000);
  const spark = (peak: number, shape: "rise" | "spike" | "steady") =>
    Array.from({ length: 24 }, (_, i) => {
      if (shape === "rise") return Math.round((peak * (i + 1) ** 2) / 576);
      if (shape === "spike") return i > 18 ? peak - (23 - i) * 3 : Math.round(peak * 0.08);
      return Math.round(peak * (0.5 + 0.3 * Math.sin(i / 3)));
    });
  const board = [
    ["tidepool-ai/tidepool", 142, 610, 1320, 18450, "TypeScript", "#3178c6", "AI agents", "Runs teams of coding agents from one shared task board", "rise", 45],
    ["octo-labs/lighthouse", 61, 290, 540, 4210, "Rust", "#dea584", "Infrastructure", "A single-binary observability collector for small clusters", "spike", 12],
    ["quietcomet/pagekite", 38, 170, 450, 9120, "Python", "#3572A5", "LLM tooling", "Turns any documentation site into an offline question-answer index", "steady", 200],
    ["fernwood/gridline", 22, 104, 260, 2870, "Go", "#00ADD8", "Data", "Columnar spreadsheet engine that queries CSVs in place", "rise", 30],
    ["mossbyte/sonar-ui", 17, 80, 190, 1320, "Svelte", "#ff3e00", "Web & UI", "Accessible chart components that read data aloud", "steady", 60],
  ] as const;
  return {
    generatedAt: Date.now(),
    sponsors: { rawtree: true, nimble: true, flux: true, llm: true, github: true, liquid: true, liquidLabel: "LFM2.5-1.2B" },
    database: "breakout",
    anchor: false,
    tables: [
      { name: "gh_events", rows: 2_184_330, bytes: 0 },
      { name: "repo_events", rows: 41_207, bytes: 0 },
      { name: "bulletins", rows: 7, bytes: 0 },
    ],
    board: board.map(([repo, s1h, s6h, s24h, stargazers, language, languageColor, category, oneLiner, shape, ageDays]) => ({
      repo,
      s1h,
      s6h,
      s24h,
      coveredSince: now - 7 * 3600,
      lastStar: now - 20,
      stargazers,
      snapshotGain1h: s1h,
      description: oneLiner,
      language,
      languageColor,
      createdAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      avatar: "",
      topics: [],
      spark: spark(s1h / 3, shape),
      category,
      oneLiner,
      labelLatencyMs: 212,
      labelModel: "LFM2.5-1.2B",
      breakout: s1h > 30,
    })),
    ticker: ["ada-l", "kenji", "marisol", "t-okafor", "priyanka", "dev-null", "lin", "gus"].map((login, i) => ({
      repo: board[i % 3][0],
      login,
      avatar: "",
      ts: now - i * 23,
    })),
    feed: [
      [now - 4, "nimble", "progress", "nimble.progress", "Reading 14 sources on news.example.com"],
      [now - 9, "nimble", "progress", "nimble.progress", "Searching forum.example.org for launch threads"],
      [now - 15, "nimble", "info", "nimble.started", 'Web Search Agent "breakout-desk" is researching (effort: low)'],
      [now - 16, "nimble", "info", "nimble.buzz", "Social pulse: 38 posts this week"],
      [now - 18, "liquid", "info", "liquid.labeled", 'On-device LFM2.5-1.2B: Infrastructure, "A single-binary observability collector" (184 ms, $0)'],
      [now - 19, "rawtree", "info", "memory.checked", "Memory: first time this desk covers it"],
      [now - 20, "desk", "info", "story.started", "Breakout detected: octo-labs/lighthouse gained 61 stars in the last hour"],
      [now - 95, "github", "info", "track.stars", "+212 new stars across 18 repos logged to RawTree"],
      [now - 400, "desk", "ok", "bulletin.published", 'ON AIR: "Tidepool doubles in a day"'],
      [now - 460, "flux", "ok", "flux.ready", "Bulletin rendered (72 credits)"],
      [now - 540, "rawtree", "ok", "ingest.hour", "Loaded 87,410 raw GitHub events (2026-09-25-17h UTC) via server-side URL ingest in 9.4s"],
    ].map(([ts, sponsor, status, step, message], i) => ({
      ts: ts as number,
      storyId: i < 7 ? "fixture-lighthouse" : "fixture-tidepool",
      repo: i < 7 ? "octo-labs/lighthouse" : "tidepool-ai/tidepool",
      step: step as string,
      sponsor: sponsor as string,
      status: status as string,
      message: message as string,
    })),
    storyFeed: [],
    bulletins: [
      {
        storyId: "fixture-tidepool",
        repo: "tidepool-ai/tidepool",
        ts: now - 400,
        headline: "Tidepool doubles in a day",
        dialogue:
          "Tidepool picked up one hundred forty stars in the last hour. It runs whole teams of coding agents from one shared task board, and a launch thread yesterday sent developers flocking to it.",
        videoUrl: "",
        posterUrl: "",
        captions: [
          { text: "Launch thread reached the front page yesterday", url: "https://news.example.com/item", domain: "news.example.com", confidence: "high" },
          { text: "Built by a four-person team in Lisbon", url: "https://blog.example.org/post", domain: "blog.example.org", confidence: "medium" },
        ],
        stars1h: 142,
        stars24h: 1320,
        stargazers: 18450,
        category: "AI agents",
        oneLiner: "Runs teams of coding agents from one shared task board",
        confidence: "high",
        costCredits: 72,
        isFinal: false,
      },
    ],
    firehose: Array.from({ length: 24 }, (_, i) => ({
      hour: (Math.floor(now / 3600) - 24 + i) * 3600,
      events: Math.round(80_000 + 12_000 * Math.sin(i / 3.5) + (i % 5) * 1500),
      stars: 180 + (i % 7) * 12,
    })),
    queries: [
      { label: "board: star velocity", sql: "SELECT _repo AS repo, uniqExactIf(_user, _ts > now() - INTERVAL 1 HOUR) AS s1h ...", at: new Date().toISOString(), elapsedMs: 38, roundTripMs: 121, rows: 16, rowsRead: 41_207 },
      { label: "firehose: events per hour", sql: "SELECT toUnixTimestamp(toStartOfHour(_ts)) AS hour_ts, count() AS events ...", at: new Date().toISOString(), elapsedMs: 64, roundTripMs: 150, rows: 24, rowsRead: 2_184_330 },
      { label: "feed: agent flight recorder", sql: "SELECT toUnixTimestamp(_ts) AS ts, _sid AS story_id ...", at: new Date().toISOString(), elapsedMs: 11, roundTripMs: 90, rows: 50, rowsRead: 3_120 },
    ],
    timings: {
      "board: star velocity": { elapsedMs: 38, rowsRead: 41_207 },
      "feed: agent flight recorder": { elapsedMs: 11, rowsRead: 3_120 },
      "firehose: events per hour": { elapsedMs: 64, rowsRead: 2_184_330 },
      bulletins: { elapsedMs: 9, rowsRead: 7 },
    },
    latency: { medianMs: 24, maxMs: 64, count: 4 },
    errors: [],
  };
}
