import { RawTree, RawTreeError, type JsonObject } from "@rawtree/sdk";
import { config } from "./config";

let client: RawTree | null = null;

export function rawtree(): RawTree {
  if (!config.rawtree.apiKey) {
    throw new Error("RAWTREE_API_KEY is not set. RawTree is the backbone of Breakout; add a key to .env.local.");
  }
  client ??= new RawTree({
    apiKey: config.rawtree.apiKey,
    database: config.rawtree.database,
    baseUrl: config.rawtree.baseUrl,
    userAgent: "breakout-newsroom/0.1",
  });
  return client;
}

export interface QueryLogEntry {
  label: string;
  sql: string;
  at: string;
  /** Server-side execution time reported by RawTree, in ms. */
  elapsedMs: number;
  /** Wall-clock time including the network round trip, in ms. */
  roundTripMs: number;
  rows: number;
  rowsRead: number;
  error?: string;
}

const queryLog: QueryLogEntry[] = [];

export function recentQueries(limit = 12): QueryLogEntry[] {
  return queryLog.slice(-limit).reverse();
}

function remember(entry: QueryLogEntry) {
  queryLog.push(entry);
  if (queryLog.length > 200) queryLog.splice(0, queryLog.length - 200);
}

export function describeError(error: unknown): string {
  if (error instanceof RawTreeError) {
    return [error.status, error.error, error.message, error.hint].filter(Boolean).join(" | ");
  }
  return error instanceof Error ? error.message : String(error);
}

export interface QueryResult<Row> {
  rows: Row[];
  stats: QueryLogEntry;
}

/** Run SQL and keep RawTree's own timing with the result (used for the latency badges). */
export async function queryWithStats<Row = Record<string, unknown>>(label: string, sql: string): Promise<QueryResult<Row>> {
  const started = performance.now();
  try {
    const result = await rawtree().query<Row>({ sql });
    const stats: QueryLogEntry = {
      label,
      sql: sql.trim(),
      at: new Date().toISOString(),
      elapsedMs: Math.round((result.statistics?.elapsed ?? 0) * 1000),
      roundTripMs: Math.round(performance.now() - started),
      rows: result.rows,
      rowsRead: result.statistics?.rows_read ?? 0,
    };
    remember(stats);
    return { rows: result.data, stats };
  } catch (error) {
    remember({
      label,
      sql: sql.trim(),
      at: new Date().toISOString(),
      elapsedMs: 0,
      roundTripMs: Math.round(performance.now() - started),
      rows: 0,
      rowsRead: 0,
      error: describeError(error),
    });
    throw error;
  }
}

export async function query<Row = Record<string, unknown>>(label: string, sql: string): Promise<Row[]> {
  return (await queryWithStats<Row>(label, sql)).rows;
}

/** Insert rows as-is. Tables are created by RawTree on first insert; no schema anywhere. */
export async function insert(table: string, rows: object | object[], batchSize = 2000): Promise<number> {
  const list = Array.isArray(rows) ? rows : [rows];
  let inserted = 0;
  for (let i = 0; i < list.length; i += batchSize) {
    const values = list.slice(i, i + batchSize) as unknown as JsonObject[];
    if (values.length === 0) continue;
    const result = await rawtree().insert({ table, values });
    inserted += result.inserted ?? values.length;
  }
  return inserted;
}

/**
 * Server-side URL ingest: RawTree pulls the file itself, so a 75 MB hour of GitHub
 * events never touches our network. The SDK has no helper for this yet, so it is a
 * plain call to POST /v1/tables/{table}?url=...
 */
export async function insertFromUrl(table: string, url: string): Promise<number | null> {
  const endpoint = new URL(`/v1/tables/${encodeURIComponent(table)}`, config.rawtree.baseUrl);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("database", config.rawtree.database);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.rawtree.apiKey}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`URL ingest failed (${response.status}): ${text.slice(0, 300)}`);
  }
  try {
    const body = JSON.parse(text) as { inserted?: number | null };
    return body.inserted ?? null;
  } catch {
    return null;
  }
}

export interface TableStat {
  name: string;
  rows: number;
  bytes: number;
}

export async function listTables(): Promise<TableStat[]> {
  const { tables } = await rawtree().tables.list();
  return tables.map((t) => ({ name: t.name, rows: t.total_rows, bytes: t.total_bytes }));
}

/** SQL string literal with escaping, for values we build into queries. */
export function lit(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
