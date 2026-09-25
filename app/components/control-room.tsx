"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DashboardState } from "@/lib/state";
import { DeskConsole } from "./desk-console";
import { Board } from "./board";
import { Firehose } from "./firehose";
import { compact, sponsorOf } from "./format";
import { NewsroomFeed } from "./newsroom-feed";
import { currentProduction } from "./production";
import { ProgramMonitor } from "./program-monitor";
import { Rundown } from "./rundown";
import { SqlTile } from "./sql-tile";
import { Ticker } from "./ticker";

function useDashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    const fixture = new URLSearchParams(window.location.search).get("fixture") === "1";
    const load = async () => {
      try {
        const response = await fetch(fixture ? "/api/state?fixture=1" : "/api/state", { cache: "no-store" });
        const next = (await response.json()) as DashboardState;
        if (alive) {
          setState(next);
          setOffline(false);
        }
      } catch {
        if (alive) setOffline(true);
      }
    };
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return { state, offline };
}

function subscribeToSeconds(onTick: () => void) {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}

/** A UTC wall clock; empty on the server so hydration never mismatches. */
function useClock(): string {
  return useSyncExternalStore(
    subscribeToSeconds,
    () => new Date().toISOString().slice(11, 19),
    () => "",
  );
}

async function postJson(url: string, body: object) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = (await response.json().catch(() => ({}))) as { error?: string; repo?: string };
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

const LAMPS: { key: keyof DashboardState["sponsors"]; sponsor: string; label?: string }[] = [
  { key: "rawtree", sponsor: "rawtree" },
  { key: "github", sponsor: "github" },
  { key: "nimble", sponsor: "nimble" },
  { key: "flux", sponsor: "flux" },
  { key: "liquid", sponsor: "liquid", label: "Liquid on-device" },
  { key: "llm", sponsor: "llm" },
];

export function ControlRoom() {
  const { state, offline } = useDashboard();
  const clock = useClock();
  const [pinned, setPinned] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [finalRequested, setFinalRequested] = useState<Set<string>>(new Set());
  const [covering, setCovering] = useState<Set<string>>(new Set());

  const bulletins = state?.bulletins ?? [];
  const latest = bulletins[0] ?? null;
  const selected = (pinned && bulletins.find((b) => b.storyId === pinned)) || latest;
  const production = useMemo(() => (state ? currentProduction(state.storyFeed?.length ? state.storyFeed : state.feed) : null), [state]);
  const rows = (table: string) => state?.tables.find((t) => t.name === table)?.rows ?? 0;
  const rawEvents = rows("gh_events") + rows("repo_events");

  const assign = async (repo: string) => {
    const result = await postJson("/api/cover", { repo });
    return result.repo ?? repo;
  };

  const cover = async (repo: string) => {
    setCovering((prev) => new Set(prev).add(repo));
    try {
      await assign(repo);
    } catch {
      setCovering((prev) => {
        const next = new Set(prev);
        next.delete(repo);
        return next;
      });
    }
  };

  const requestFinal = async (storyId: string) => {
    setFinalRequested((prev) => new Set(prev).add(storyId));
    await postJson("/api/enhance", { storyId }).catch(() => undefined);
  };

  return (
    <div className="flex min-h-screen flex-col lg:h-dvh">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-[#0a1628] px-4 py-2.5">
        <div className="flex items-center gap-4">
          <span className={`tally-light ${latest || production ? "live" : ""}`}>
            <span className="h-2.5 w-2.5 rounded-full bg-current" aria-hidden />
            {latest || production ? "ON AIR" : "STANDBY"}
          </span>
          <div>
            <h1 className="cond text-[2.1rem] leading-none font-extrabold">Breakout</h1>
            <p className="hidden text-sm text-muted 2xl:block">The live desk for GitHub&apos;s fastest-rising repos</p>
          </div>
          {state?.fixture ? (
            <span className="semi rounded-sm px-2 py-1 text-sm font-bold text-[#1b1203]" style={{ background: "var(--flux)" }}>
              Sample data, not live
            </span>
          ) : null}
        </div>

        <dl className="flex gap-5">
          <div>
            <dt className="text-xs text-muted">Raw events in RawTree</dt>
            <dd className="cond text-2xl font-bold">{compact(rawEvents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">On the board</dt>
            <dd className="cond text-2xl font-bold">{state?.board.length ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Median query</dt>
            <dd className="cond text-2xl font-bold" style={{ color: "var(--rawtree)" }}>
              {state?.latency.count ? `${state.latency.medianMs} ms` : "-"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Bulletins aired</dt>
            <dd className="cond text-2xl font-bold">{bulletins.length}</dd>
          </div>
        </dl>

        <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 xl:flex-nowrap" aria-label="Integrations">
          {LAMPS.map((lamp) => {
            const on = Boolean(state?.sponsors[lamp.key]);
            const meta = sponsorOf(lamp.sponsor);
            return (
              <li key={lamp.key} className={`semi flex items-center gap-1.5 text-sm font-semibold ${on ? "" : "opacity-40"}`} title={on ? "Connected" : "Not configured"}>
                <span className="tally-square" style={{ background: on ? meta.color : "var(--line)" }} aria-hidden />
                {lamp.label ?? meta.name}
                <span className="sr-only">{on ? "connected" : "not configured"}</span>
              </li>
            );
          })}
        </ul>
        <time className="cond text-3xl font-bold tabular-nums" aria-label="Current time in UTC">
          {clock ? `${clock} UTC` : ""}
        </time>
      </header>

      {offline || (state && state.errors.length && !state.tables.length) ? (
        <div className="border-b border-tally/50 bg-[#2a1216] px-4 py-2 text-[#ffc9c9]" role="alert">
          {offline
            ? "Can't reach the dashboard API. Check that pnpm dev is running."
            : state?.sponsors.rawtree
              ? `RawTree returned an error: ${state.errors[0]}`
              : "RawTree isn't connected. Add RAWTREE_API_KEY to .env.local, then restart the app and the worker."}
        </div>
      ) : null}

      <main className="room-grid">
        <div className="flex min-h-0 flex-col gap-1.5">
          <ProgramMonitor
            bulletin={selected}
            isLive={!pinned || selected?.storyId === latest?.storyId}
            anchorAvailable={Boolean(state?.anchor)}
            production={production}
            soundOn={soundOn}
            onSoundToggle={() => setSoundOn((on) => !on)}
            onRequestFinal={requestFinal}
            finalRequested={selected ? finalRequested.has(selected.storyId) : false}
          />
          <Rundown
            anchorAvailable={Boolean(state?.anchor)}
            bulletins={bulletins}
            selectedId={selected?.storyId}
            onSelect={(id) => setPinned(id === latest?.storyId ? null : id)}
          />
          <div className="grid min-h-[10.5rem] flex-1 grid-cols-1 gap-1.5 md:grid-cols-2 [&>section]:min-h-[10.5rem]">
            <Firehose hours={state?.firehose ?? []} totalEvents={rows("gh_events")} latency={state?.timings["firehose: events per hour"]} />
            <SqlTile queries={state?.queries ?? []} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-1.5">
          <div className="flex min-h-[18rem] flex-[1.25] flex-col [&>section]:flex-1">
            <Board entries={state?.board ?? []} onCover={cover} covering={covering} latency={state?.timings["board: star velocity"]} />
          </div>
          <div className="flex min-h-[14rem] flex-1 flex-col [&>section]:flex-1">
            <NewsroomFeed items={state?.feed ?? []} currentStory={production?.storyId} latency={state?.timings["feed: agent flight recorder"]} />
          </div>
          <DeskConsole onAssign={assign} />
        </div>
      </main>

      <Ticker items={state?.ticker ?? []} />
    </div>
  );
}
