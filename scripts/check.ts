import "../worker/env";
import { generateText } from "ai";
import { config, enabled } from "@/lib/config";
import { fetchRepoEvents, fetchRepos } from "@/lib/github";
import { labelRepo } from "@/lib/liquid";
import { localAvailable, writerModel } from "@/lib/llm";
import { describeError, insert, listTables, query } from "@/lib/rawtree";
import * as sql from "@/lib/sql";
import Nimble from "@nimble-way/nimble-js";

/** One command to confirm every sponsor integration before demo time: pnpm check */

const ok = (label: string, detail = "") => console.log(`\x1b[32m  ok \x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
const bad = (label: string, detail: string) => console.log(`\x1b[31m  !! \x1b[0m ${label}  ${detail}`);
const skip = (label: string, detail: string) => console.log(`\x1b[90m  -- ${label}  ${detail}\x1b[0m`);

async function step(label: string, fn: () => Promise<string | void>) {
  try {
    ok(label, (await fn()) ?? "");
  } catch (error) {
    bad(label, describeError(error));
  }
}

console.log("\nRawTree");
if (!enabled.rawtree()) {
  skip("RawTree", "RAWTREE_API_KEY not set");
} else {
  await step("insert + read back", async () => {
    await insert("healthcheck", { note: "breakout check", ts: new Date().toISOString(), nested: { ok: true } });
    const [row] = await query<Record<string, unknown>>(
      "check",
      `SELECT count() AS n, max(${sql.time("ts")}) AS last FROM healthcheck WHERE ${sql.str("nested.ok")} = 'true'`,
    );
    return `${row?.n} rows, last ${row?.last}`;
  });
  const tables = await listTables().catch(() => []);
  console.log(`       tables: ${tables.map((t) => `${t.name} (${t.rows})`).join(", ") || "(none yet)"}`);
  const has = (name: string) => tables.some((t) => t.name === name);
  if (has("gh_events")) await step("candidates SQL", async () => `${(await query("check", sql.candidatesSql(5))).length} rows`);
  if (has("repo_events")) {
    await step("board SQL", async () => `${(await query("check", sql.boardSql(5))).length} rows`);
    await step("ticker SQL", async () => `${(await query("check", sql.tickerSql(5))).length} rows`);
    await step("firehose SQL", async () => (has("gh_events") ? `${(await query("check", sql.firehoseSql())).length} rows` : "skipped"));
  }
  if (has("repos")) await step("snapshot SQL", async () => `${(await query("check", sql.repoMetaSql(["vercel/next.js"]))).length} rows`);
  if (has("agent_events")) {
    await step("feed SQL", async () => `${(await query("check", sql.feedSql(5))).length} rows`);
    await step("inbox SQL", async () => `${(await query("check", sql.coverRequestsSql())).length} rows`);
    await step("resume SQL", async () => `${(await query("check", sql.unfinishedStoriesSql())).length} rows`);
  }
  if (has("bulletins")) await step("bulletins SQL", async () => `${(await query("check", sql.bulletinsSql(5))).length} rows`);
}

console.log("\nGitHub");
if (!enabled.github()) {
  skip("GitHub", "no token (set GITHUB_TOKEN or run gh auth login)");
} else {
  await step("GraphQL snapshot", async () => {
    const [snap] = await fetchRepos(["vercel/next.js"]);
    return `${snap.repo}: ${snap.stargazerCount.toLocaleString("en-US")} stars`;
  });
  await step("per-repo event feed", async () => {
    const events = await fetchRepoEvents("vercel/next.js", undefined, 1);
    return `${events.length} events, ${events.filter((e) => e.type === "WatchEvent").length} stars`;
  });
}

console.log("\nNimble");
if (!enabled.nimble()) {
  skip("Nimble", "NIMBLE_API_KEY not set");
} else {
  await step("search (lite)", async () => {
    const nimble = new Nimble({ apiKey: config.nimble.apiKey });
    const result = await nimble.search({ query: "RawTree Tinybird analytics database", search_depth: "lite", max_results: 3 });
    return `${result.total_results} results`;
  });
}

console.log("\nBlack Forest Labs");
if (!enabled.bfl()) {
  skip("FLUX", "BFL_API_KEY not set");
} else {
  await step("credits", async () => {
    const response = await fetch(`${config.bfl.baseUrl}/v1/credits`, { headers: { "x-key": config.bfl.apiKey } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { credits?: number };
    return `${body.credits} credits (~$${((body.credits ?? 0) / 100).toFixed(2)})`;
  });
}

console.log("\nScript writer (OpenAI-compatible)");
const writer = writerModel();
if (!writer) {
  skip("writer", "LLM_API_KEY / LLM_MODEL not set (template fallback will be used)");
} else {
  await step(`${config.llm.model} @ ${config.llm.baseUrl}`, async () => {
    const { text } = await generateText({ model: writer, prompt: "Reply with exactly: on air", maxOutputTokens: 800 });
    return JSON.stringify(text.trim());
  });
}

console.log("\nLiquid (on-device)");
if (!(await localAvailable())) {
  skip("LFM2.5", `no server at ${config.local.baseUrl} (see README: ollama pull ${config.local.model})`);
} else {
  await step(`${config.local.label} label`, async () => {
    const label = await labelRepo({
      repo: "vercel/next.js",
      description: "The React Framework",
      topics: ["react", "nextjs"],
      language: "JavaScript",
      readme: "",
    });
    return label ? `${label.category}: "${label.one_liner}" in ${label.latency_ms} ms` : "no output";
  });
}
console.log("");
