import { nimbleExtract, nimbleSearch } from "@nimble-way/ai-sdk";
import { generateText, stepCountIs, tool, type LanguageModel, type Tool } from "ai";
import { z } from "zod";
import { config, enabled } from "./config";
import { logEvent, type Sponsor } from "./events";
import { localAvailable, localModel, telemetry, writerModel } from "./llm";
import { describeError, listTables, query, queryWithStats, recentQueries } from "./rawtree";
import * as sql from "./sql";

/*
 * "Ask the desk": an agent over the same data the dashboard shows.
 *  - Nimble's official AI SDK tools (search, read a page) for the live web
 *  - RawTree tools: a parameterized repo endpoint, and guarded read-only SQL
 * Every tool call is written to the flight recorder, so the room watches it work.
 */

const SYSTEM = `You are the research desk of BREAKOUT, a live newsroom that tracks the fastest-rising open-source repos on GitHub.
Answer the question from the floor in at most 120 words, in plain spoken English.
- For anything about a specific repo, call repoStats first: it returns live star velocity, total stars, and firehose activity from RawTree.
- For aggregate questions ("what is hot in Rust?", "which repos gained the most stars?"), call sqlQuery.
- For why, who and what questions, use webSearch, then readPage on the most promising result if needed.
- Quote numbers with their time window. Never invent numbers or sources.
- Cite web sources inline as [1], [2] and end with a "Sources:" list of their URLs.

sqlQuery runs read-only ClickHouse SQL on RawTree. Tables are schemaless JSON; cast in SQL:
  string: ifNull(accurateCastOrNull(<path>, 'String'), '')
  time:   parseDateTimeBestEffortOrNull(ifNull(accurateCastOrNull(<path>, 'String'), ''))
Cast inside an inner SELECT using _prefixed aliases, then aggregate outside. Tables:
  gh_events    sampled GitHub firehose: type ('WatchEvent' is a star, 'ForkEvent', 'PullRequestEvent', 'IssuesEvent', 'PushEvent'), repo.name, actor.login, created_at
  repo_events  complete event feed for tracked repos, same shape; stars are type 'WatchEvent'
  repos        snapshots: repo, stargazer_count, language, description, created_at, fetched_at
  labels       on-device Liquid labels: repo, category, one_liner, ts
  bulletins    what aired: repo, ts, headline, dialogue, stars_1h, stargazers
Example:
SELECT _repo AS repo, count() AS stars FROM (SELECT ifNull(accurateCastOrNull(repo.name, 'String'), '') AS _repo, ifNull(accurateCastOrNull(type, 'String'), '') AS _type, parseDateTimeBestEffortOrNull(ifNull(accurateCastOrNull(created_at, 'String'), '')) AS _ts FROM repo_events) WHERE _type = 'WatchEvent' AND _ts > now() - INTERVAL 6 HOUR GROUP BY _repo ORDER BY stars DESC LIMIT 10`;

export interface AskStep {
  tool: string;
  sponsor: Sponsor;
  input: string;
  summary: string;
  ms: number;
}

export interface AskResult {
  askId: string;
  answer: string;
  model: string;
  steps: AskStep[];
}

type AnyTool = Tool<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function lastQueryMs(): number {
  return recentQueries(1)[0]?.elapsedMs ?? 0;
}

function guardSql(text: string): string {
  const trimmed = text.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only SELECT queries are allowed");
  if (trimmed.includes(";")) throw new Error("One statement at a time");
  return /\blimit\s+\d+/i.test(trimmed) ? trimmed : `${trimmed}\nLIMIT 50`;
}

export async function askDesk(question: string): Promise<AskResult> {
  const askId = `ask-${Date.now().toString(36)}`;
  let model: LanguageModel | null = writerModel();
  let modelLabel = config.llm.model;
  if (!model && (await localAvailable())) {
    model = localModel();
    modelLabel = `${config.local.label} (on-device)`;
  }
  if (!model) throw new Error("Set LLM_API_KEY and LLM_MODEL (or start the local Liquid server) to enable Ask the desk.");

  const steps: AskStep[] = [];
  const record = async (step: AskStep) => {
    steps.push(step);
    await logEvent({ story_id: askId, step: "ask.tool", sponsor: step.sponsor, message: `${step.summary}`, data: step });
  };

  /** Wrap a tool so every call is timed and written to the flight recorder. */
  const traced = (name: string, sponsor: Sponsor, base: AnyTool, describe: (input: any, output: any) => string): AnyTool => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const execute = base.execute;
    if (!execute) return base;
    return {
      ...base,
      execute: async (input: unknown, options: Parameters<NonNullable<AnyTool["execute"]>>[1]) => {
        const started = performance.now();
        try {
          const output = await execute(input, options);
          await record({ tool: name, sponsor, input: JSON.stringify(input).slice(0, 300), summary: describe(input, output), ms: Math.round(performance.now() - started) });
          return output;
        } catch (error) {
          await record({ tool: name, sponsor, input: JSON.stringify(input).slice(0, 300), summary: `${name} failed: ${describeError(error)}`, ms: Math.round(performance.now() - started) });
          throw error;
        }
      },
    } as AnyTool;
  };

  const tools: Record<string, AnyTool> = {
    repoStats: traced(
      "repoStats",
      "rawtree",
      tool({
        description: "Live stats for one GitHub repo from RawTree: star velocity, total stars, and firehose activity by event type.",
        inputSchema: z.object({ repo: z.string().describe("owner/name") }),
        execute: async ({ repo }) => {
          const [velocity] = await query<Record<string, unknown>>("ask: repo velocity", sql.repoVelocitySql(repo)).catch(() => [undefined]);
          const [meta] = await query<Record<string, unknown>>("ask: repo snapshot", sql.repoMetaSql([repo])).catch(() => [undefined]);
          const firehose = await query<Record<string, unknown>>("ask: repo firehose", sql.repoFirehoseSql(repo)).catch(() => []);
          return {
            repo,
            starsLastHour: Number(velocity?.s1h) || 0,
            starsLast6h: Number(velocity?.s6h) || 0,
            starsLast24h: Number(velocity?.s24h) || 0,
            totalStars: Number(meta?.stargazers) || null,
            description: meta?.description ?? null,
            language: meta?.language ?? null,
            firehoseActivity: firehose.map((f) => ({ type: f.type, events: Number(f.events), people: Number(f.people) })),
            note: "Star velocity is exact for tracked repos; firehose activity comes from GitHub's sampled public feed.",
          };
        },
      }),
      (input, output) => `RawTree repoStats(${input.repo}): +${output.starsLastHour} stars last hour, ${output.firehoseActivity.length} event types (${lastQueryMs()} ms)`,
    ),
    sqlQuery: traced(
      "sqlQuery",
      "rawtree",
      tool({
        description: "Run one read-only ClickHouse SELECT on RawTree and get rows back. Follow the casting rules in your instructions.",
        inputSchema: z.object({ sql: z.string() }),
        execute: async ({ sql: text }) => {
          try {
            const { rows, stats } = await queryWithStats<Record<string, unknown>>("ask: agent SQL", guardSql(text));
            return { rows: rows.slice(0, 30), rowCount: rows.length, elapsedMs: stats.elapsedMs, rowsRead: stats.rowsRead };
          } catch (error) {
            return { error: describeError(error).slice(0, 400) };
          }
        },
      }),
      (_input, output) =>
        output.error
          ? `RawTree SQL error, retrying: ${String(output.error).slice(0, 90)}`
          : `RawTree SQL: ${output.rowCount} rows from ${Number(output.rowsRead).toLocaleString("en-US")} scanned in ${output.elapsedMs} ms`,
    ),
  };

  if (enabled.nimble()) {
    tools.webSearch = traced(
      "webSearch",
      "nimble",
      nimbleSearch({ apiKey: config.nimble.apiKey, searchDepth: "lite", maxResults: 5 }) as AnyTool,
      (input, output) => `Nimble search "${input.query}": ${output?.results?.length ?? 0} results`,
    );
    tools.readPage = traced(
      "readPage",
      "nimble",
      nimbleExtract({ apiKey: config.nimble.apiKey, format: "markdown", maxContentLength: 6000 }) as AnyTool,
      (input) => `Nimble read ${input.url}`,
    );
  }

  await logEvent({ story_id: askId, step: "ask.question", sponsor: "desk", message: `Question from the floor: "${question}"` });
  const tables = await listTables().catch(() => []);
  const available = tables.map((t) => `${t.name} (${t.rows.toLocaleString("en-US")} rows)`).join(", ");
  const result = await generateText({
    model,
    system: `${SYSTEM}

Tables that exist right now: ${available || "unknown"}. Only query these.`,
    prompt: question,
    tools,
    stopWhen: stepCountIs(7),
    maxOutputTokens: 4000,
    experimental_telemetry: telemetry("ask-the-desk"),
  });
  const answer = result.text.trim() || "The desk could not find an answer to that.";
  await logEvent({ story_id: askId, step: "ask.answered", sponsor: "desk", status: "ok", message: `Answered with ${steps.length} tool calls`, data: { answer, model: modelLabel } });
  return { askId, answer, model: modelLabel, steps };
}
