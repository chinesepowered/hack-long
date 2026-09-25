import { lit } from "./rawtree";

/*
 * Every table in Breakout is schemaless: rows go into RawTree exactly as the APIs
 * returned them, and types are applied at query time ("types live in SQL").
 *
 * Conventions:
 *  - Raw JSON paths are cast in an inner SELECT under `_`-prefixed names, and only the
 *    outer SELECT uses friendly names, so an alias never shadows the path it came from.
 *  - Times leave the database as Unix epoch seconds, so nothing downstream guesses timezones.
 *  - Counts can arrive as strings (64-bit integers are quoted in JSON); callers use Number().
 */
export const str = (field: string) => `ifNull(accurateCastOrNull(${field}, 'String'), '')`;
export const num = (field: string) => `ifNull(accurateCastOrNull(${field}, 'Float64'), 0)`;
export const time = (field: string) => `parseDateTimeBestEffortOrNull(${str(field)})`;
const epoch = (expr: string) => `toUnixTimestamp(${expr})`;

const inList = (values: string[]) => (values.length ? values.map(lit).join(", ") : "''");

/* Tables
 *  gh_events     raw GH Archive firehose (every public event type, sampled by GitHub)
 *  repo_events   raw per-repo event feed for tracked repos (complete star log going forward)
 *  repos         GraphQL snapshots: exact star counts + metadata, one row per poll
 *  labels        on-device Liquid LFM2.5 classifications
 *  research      raw Nimble Web Search Agent results (answer + trust report)
 *  mentions      raw Nimble Search results (social buzz)
 *  bulletins     published broadcasts
 *  agent_events  the newsroom's flight recorder: every step, plus the request inbox
 *  ingest_log    which GH Archive hours are loaded (so restarts resume, not repeat)
 */

const starLog = `
  SELECT ${str("repo.name")} AS _repo, ${str("actor.login")} AS _user,
         ${str("actor.avatar_url")} AS _avatar, ${time("created_at")} AS _ts
  FROM repo_events
  WHERE ${str("type")} = 'WatchEvent'`;

const agentLog = `
  SELECT ${time("ts")} AS _ts, ${str("story_id")} AS _sid, ${str("repo")} AS _repo, ${str("step")} AS _step,
         ${str("sponsor")} AS _sponsor, ${str("status")} AS _status, ${str("message")} AS _message,
         ${str("data_json")} AS _data
  FROM agent_events`;

const bulletinRows = `
  SELECT ${str("story_id")} AS _sid, ${str("repo")} AS _repo, ${time("ts")} AS _ts, ${str("headline")} AS _headline,
         ${str("dialogue")} AS _dialogue, ${str("video_file")} AS _video, ${str("poster_file")} AS _poster,
         ${str("captions_json")} AS _captions, ${num("stars_1h")} AS _s1h, ${num("stars_24h")} AS _s24h,
         ${num("stargazers")} AS _stargazers, ${str("category")} AS _category, ${str("one_liner")} AS _one,
         ${str("confidence")} AS _confidence, ${num("cost_credits")} AS _cost,
         ${str("draft_cache_file")} AS _draft, ${num("is_final")} AS _final, ${str("trigger_kind")} AS _trigger,
         ${str("__raw_data.anchor_id")} AS _anchor -- a field older rows never had: read it from the raw JSON, which returns '' instead of failing
  FROM bulletins`;

/** Stage 1: candidates from the sampled firehose, ranked by stars, forks and distinct people. */
export function candidatesSql(limit: number) {
  return `
WITH (SELECT max(${time("created_at")}) FROM gh_events) AS data_now
SELECT
  _repo AS repo,
  countIf(_type = 'WatchEvent') AS stars,
  countIf(_type = 'ForkEvent') AS forks,
  uniqExactIf(_actor, _type NOT IN ('PushEvent', 'CreateEvent', 'DeleteEvent')) AS people,
  stars * 3 + forks * 2 + people AS heat
FROM (
  SELECT ${str("repo.name")} AS _repo, ${str("type")} AS _type, ${str("actor.login")} AS _actor,
         ${time("created_at")} AS _ts
  FROM gh_events
)
WHERE _ts > data_now - INTERVAL 24 HOUR
GROUP BY _repo
HAVING stars >= 2
ORDER BY heat DESC
LIMIT ${Math.floor(limit)}`;
}

/** Stage 2: exact star velocity from the raw per-repo star log. */
export function boardSql(limit = 20) {
  return `
SELECT
  _repo AS repo,
  uniqExactIf(_user, _ts > now() - INTERVAL 1 HOUR) AS s1h,
  uniqExactIf(_user, _ts > now() - INTERVAL 6 HOUR) AS s6h,
  uniqExactIf(_user, _ts > now() - INTERVAL 24 HOUR) AS s24h,
  ${epoch("min(_ts)")} AS covered_since,
  ${epoch("max(_ts)")} AS last_star
FROM (${starLog})
WHERE _ts > now() - INTERVAL 48 HOUR
GROUP BY _repo
HAVING s24h > 0
ORDER BY s1h DESC, s6h DESC
LIMIT ${Math.floor(limit)}`;
}

/** Latest GraphQL snapshot per repo, plus the exact star-count change over the last hour. */
export function repoMetaSql(repos: string[]) {
  return `
SELECT
  _repo AS repo,
  argMax(_description, _f) AS description,
  argMax(_language, _f) AS language,
  argMax(_color, _f) AS language_color,
  argMax(_stars, _f) AS stargazers,
  argMax(_created, _f) AS created_at,
  argMax(_avatar, _f) AS avatar,
  argMax(_topics, _f) AS topics,
  argMax(_stars, _f) - argMinIf(_stars, _f, _f > now() - INTERVAL 1 HOUR) AS snapshot_gain_1h,
  count() AS snapshots
FROM (
  SELECT
    ${str("repo")} AS _repo,
    ${str("description")} AS _description,
    ${str("language")} AS _language,
    ${str("language_color")} AS _color,
    ${num("stargazer_count")} AS _stars,
    ${str("created_at")} AS _created,
    ${str("owner_avatar")} AS _avatar,
    ${str("topics_csv")} AS _topics,
    ${time("fetched_at")} AS _f
  FROM repos
)
WHERE _repo IN (${inList(repos)})
GROUP BY _repo`;
}

/** Stars per 20-minute bucket over the last 8 hours, for the board sparklines. */
export function sparklineSql(repos: string[]) {
  return `
SELECT _repo AS repo, ${epoch("toStartOfInterval(_ts, INTERVAL 20 MINUTE)")} AS bucket, uniqExact(_user) AS n
FROM (${starLog})
WHERE _repo IN (${inList(repos)}) AND _ts > now() - INTERVAL 8 HOUR
GROUP BY repo, bucket
ORDER BY bucket`;
}

export function labelsSql(repos: string[]) {
  return `
SELECT _repo AS repo, argMax(_category, _t) AS category, argMax(_one, _t) AS one_liner,
       argMax(_latency, _t) AS latency_ms, argMax(_model, _t) AS model
FROM (
  SELECT ${str("repo")} AS _repo, ${str("category")} AS _category, ${str("one_liner")} AS _one,
         ${num("latency_ms")} AS _latency, ${str("model")} AS _model, ${time("ts")} AS _t
  FROM labels
)
WHERE _repo IN (${inList(repos)})
GROUP BY _repo`;
}

export function labeledReposSql() {
  return `SELECT DISTINCT _repo AS repo FROM (SELECT ${str("repo")} AS _repo FROM labels)`;
}

/** The live star ticker: real people starring tracked repos. */
export function tickerSql(limit = 40) {
  return `
SELECT DISTINCT _repo AS repo, _user AS login, _avatar AS avatar, ${epoch("_ts")} AS ts
FROM (${starLog})
WHERE _ts IS NOT NULL
ORDER BY ts DESC
LIMIT ${Math.floor(limit)}`;
}

/** Hourly volume of the raw firehose, for the "what RawTree is chewing on" panel. */
export function firehoseSql() {
  return `
SELECT ${epoch("toStartOfHour(_ts)")} AS hour_ts, count() AS events, countIf(_type = 'WatchEvent') AS stars
FROM (SELECT ${time("created_at")} AS _ts, ${str("type")} AS _type FROM gh_events)
WHERE _ts IS NOT NULL
GROUP BY hour_ts
ORDER BY hour_ts DESC
LIMIT 168`;
}

export function feedSql(limit = 60) {
  return `
SELECT ${epoch("_ts")} AS ts, _sid AS story_id, _repo AS repo, _step AS step, _sponsor AS sponsor,
       _status AS status, _message AS message
FROM (${agentLog})
WHERE _ts IS NOT NULL
ORDER BY ts DESC
LIMIT ${Math.floor(limit)}`;
}

/** Recent broadcast-story steps (not Ask the desk), for the production strip. */
export function recentStoryEventsSql(minutes = 20) {
  return `
SELECT ${epoch("_ts")} AS ts, _sid AS story_id, _repo AS repo, _step AS step, _sponsor AS sponsor,
       _status AS status, _message AS message
FROM (${agentLog})
WHERE _ts > now() - INTERVAL ${Math.floor(minutes)} MINUTE AND _sid != '' AND NOT startsWith(_sid, 'ask-')
ORDER BY ts DESC
LIMIT 300`;
}

/** FLUX credits recorded on bulletins over a rolling window, for the spend cap. */
export function fluxSpendSql(hours = 24) {
  return `SELECT sum(_cost) AS credits FROM (${bulletinRows}) WHERE _ts > now() - INTERVAL ${Math.floor(hours)} HOUR`;
}

/** Video bulletins are shown only for the current anchor, so the rundown stays one consistent face. */
export function bulletinsSql(limit = 12, anchorId?: string) {
  return `
SELECT _sid AS story_id, _repo AS repo, ${epoch("_ts")} AS ts, _headline AS headline, _dialogue AS dialogue,
       _video AS video_file, _poster AS poster_file, _captions AS captions_json, _s1h AS stars_1h,
       _s24h AS stars_24h, _stargazers AS stargazers, _category AS category, _one AS one_liner,
       _confidence AS confidence, _cost AS cost_credits, _draft AS draft_cache_file, _final AS is_final,
       _anchor AS anchor_id
FROM (${bulletinRows})
WHERE _ts IS NOT NULL${anchorId ? ` AND (_video = '' OR _anchor = ${lit(anchorId)})` : ""}
ORDER BY ts DESC
LIMIT 1 BY story_id
LIMIT ${Math.floor(limit)}`;
}

/** Long-horizon memory: what has the desk already said about this repo? */
export function memorySql(repo: string, limit = 3) {
  return `
SELECT ${epoch("_ts")} AS ts, _headline AS headline, _dialogue AS dialogue, _s1h AS stars_1h, _stargazers AS stargazers
FROM (${bulletinRows})
WHERE _repo = ${lit(repo)} AND _ts IS NOT NULL
ORDER BY ts DESC
LIMIT ${Math.floor(limit)}`;
}

/** Velocity for a single repo (used when a judge asks the desk to cover something specific). */
export function repoVelocitySql(repo: string) {
  return `
SELECT
  uniqExactIf(_user, _ts > now() - INTERVAL 1 HOUR) AS s1h,
  uniqExactIf(_user, _ts > now() - INTERVAL 6 HOUR) AS s6h,
  uniqExactIf(_user, _ts > now() - INTERVAL 24 HOUR) AS s24h,
  ${epoch("min(_ts)")} AS covered_since
FROM (${starLog})
WHERE _repo = ${lit(repo)} AND _ts > now() - INTERVAL 48 HOUR`;
}

/** Everything the sampled firehose saw for one repo, by event type (the "X-ray" endpoint). */
export function repoFirehoseSql(repo: string) {
  return `
SELECT _type AS type, count() AS events, uniqExact(_actor) AS people,
       ${epoch("min(_ts)")} AS first_seen, ${epoch("max(_ts)")} AS last_seen
FROM (
  SELECT ${str("repo.name")} AS _repo, ${str("type")} AS _type, ${str("actor.login")} AS _actor,
         ${time("created_at")} AS _ts
  FROM gh_events
)
WHERE _repo = ${lit(repo)}
GROUP BY _type
ORDER BY events DESC`;
}

export function autoBulletinsSinceSql(hours: number) {
  return `
SELECT count() AS n
FROM (${bulletinRows})
WHERE _ts > now() - INTERVAL ${Math.floor(hours)} HOUR AND _trigger = 'auto'`;
}

export function ingestedHoursSql() {
  return `SELECT DISTINCT _hour AS archive_hour FROM (SELECT ${str("archive_hour")} AS _hour FROM ingest_log)`;
}

export function lastEventIdsSql() {
  return `
SELECT _repo AS repo, toString(max(_id)) AS max_id
FROM (SELECT ${str("repo.name")} AS _repo, toUInt64OrZero(${str("id")}) AS _id FROM repo_events)
GROUP BY _repo`;
}

export function coverRequestsSql() {
  return `
SELECT _repo AS repo, _data AS data_json, ${epoch("_ts")} AS ts
FROM (${agentLog})
WHERE _step = 'cover.requested' AND _ts > now() - INTERVAL 2 HOUR
ORDER BY ts`;
}

export function acceptedRequestsSql() {
  return `
SELECT _data AS data_json
FROM (${agentLog})
WHERE _step IN ('cover.accepted', 'cover.rejected', 'enhance.accepted') AND _ts > now() - INTERVAL 3 HOUR`;
}

export function enhanceRequestsSql() {
  return `
SELECT _sid AS story_id, _data AS data_json, ${epoch("_ts")} AS ts
FROM (${agentLog})
WHERE _step = 'enhance.requested' AND _ts > now() - INTERVAL 2 HOUR
ORDER BY ts`;
}

/** Stories that started but never finished, so a restarted worker can pick them up. */
export function unfinishedStoriesSql() {
  return `
SELECT _sid AS story_id, any(_repo) AS repo, groupArray(_step) AS steps
FROM (${agentLog})
WHERE _ts > now() - INTERVAL 6 HOUR AND _sid != ''
GROUP BY _sid
HAVING has(steps, 'story.started') AND NOT has(steps, 'bulletin.published') AND NOT has(steps, 'story.failed')`;
}

export function storyEventsSql(storyId: string) {
  return `
SELECT _step AS step, _data AS data_json, ${epoch("_ts")} AS ts
FROM (${agentLog})
WHERE _sid = ${lit(storyId)}
ORDER BY ts`;
}
