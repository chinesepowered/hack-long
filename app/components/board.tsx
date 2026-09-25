"use client";

/* eslint-disable @next/next/no-img-element */
import type { BoardEntry } from "@/lib/state";
import { compact, full } from "./format";
import { Tile, type Latency } from "./tile";

function level(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

/** 24 squares, 20 minutes each: the contribution graph, turned into a star clock. */
function HeatStrip({ series }: { series: number[] }) {
  const max = Math.max(...series);
  return (
    <div className="heat w-full" role="img" aria-label={`Stars per 20 minutes over the last 8 hours: ${series.join(", ")}`}>
      {series.map((value, i) => (
        <span key={i} data-level={level(value, max)} />
      ))}
    </div>
  );
}

export function Board({
  entries,
  onCover,
  covering,
  latency,
}: {
  latency?: Latency;
  entries: BoardEntry[];
  onCover: (repo: string) => void;
  covering: Set<string>;
}) {
  return (
    <Tile title="The board" note="stars in the last hour, from the raw event log" sponsor="rawtree" sponsorLabel="RawTree SQL" latency={latency}>
      {entries.length === 0 ? (
        <p className="p-4 text-muted">Waiting for the first star log. The worker fills this within a couple of minutes of starting.</p>
      ) : (
        <ol className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
          {entries.map((entry, index) => {
            const [owner, name] = entry.repo.split("/");
            const assigned = covering.has(entry.repo);
            return (
              <li
                key={entry.repo}
                className="grid grid-cols-[1.5rem_2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line/60 px-3 py-2"
              >
                <span className="cond text-right text-2xl font-bold text-faint">{index + 1}</span>
                {entry.avatar ? (
                  <img src={entry.avatar} alt="" className="h-9 w-9 rounded-sm bg-tile-raised" />
                ) : (
                  <span className="h-9 w-9 rounded-sm bg-tile-raised" />
                )}
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <a href={`https://github.com/${entry.repo}`} target="_blank" rel="noreferrer" className="semi truncate text-lg leading-tight font-bold hover:underline">
                      <span className="font-normal text-muted">{owner}/</span>
                      {name}
                    </a>
                    {entry.breakout ? (
                      <span className="semi shrink-0 rounded-sm bg-tally px-1.5 text-xs font-bold text-white">Breakout</span>
                    ) : null}
                  </div>
                  <p className="truncate text-sm text-muted">
                    {entry.category ? (
                      <span
                        className="mr-1.5 font-semibold"
                        style={{ color: "var(--liquid)" }}
                        title={`Labeled on-device by ${entry.labelModel} in ${entry.labelLatencyMs} ms`}
                      >
                        {entry.category}
                      </span>
                    ) : null}
                    {entry.oneLiner || entry.description || " "}
                  </p>
                  <div className="mt-1 flex items-center gap-3">
                    <div className="w-full max-w-[16rem]">
                      <HeatStrip series={entry.spark} />
                    </div>
                    <button
                      type="button"
                      onClick={() => onCover(entry.repo)}
                      disabled={assigned}
                      className="semi shrink-0 rounded-sm px-1.5 text-sm font-semibold text-muted hover:bg-tile-raised hover:text-text disabled:text-faint"
                    >
                      {assigned ? "Assigned" : "Cover this"}
                    </button>
                  </div>
                </div>
                <div className="text-right">
                  <div className="cond text-3xl leading-none font-extrabold text-star">+{full(entry.s1h)}</div>
                  <div className="text-xs text-muted">{compact(entry.stargazers)} total</div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Tile>
  );
}
