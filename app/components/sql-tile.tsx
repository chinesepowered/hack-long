"use client";

import { useState } from "react";
import type { DashboardState } from "@/lib/state";
import { full } from "./format";
import { Tile } from "./tile";

/** The queries behind this screen, with RawTree's own timings. */
export function SqlTile({ queries }: { queries: DashboardState["queries"] }) {
  const [selected, setSelected] = useState(0);
  const current = queries[Math.min(selected, queries.length - 1)];
  return (
    <Tile title="Queries" note="behind this screen, live" sponsor="rawtree" sponsorLabel="RawTree SQL">
      {queries.length === 0 ? (
        <p className="p-4 text-muted">Queries show up here once RawTree has data.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <ul className="scroll-quiet min-h-0 overflow-y-auto border-r border-line py-1">
            {queries.map((q, i) => (
              <li key={`${q.at}-${q.label}`}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm hover:bg-tile-raised ${i === selected ? "bg-tile-raised" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{q.label}</span>
                  {q.error ? (
                    <span className="text-[#ff9b9b]">error</span>
                  ) : (
                    <span className="semi shrink-0 font-bold" style={{ color: "var(--rawtree)" }}>
                      {q.elapsedMs} ms
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {current ? (
            <div className="flex min-h-0 flex-col">
              <p className="px-3 pt-1.5 text-xs text-muted">
                {current.error
                  ? current.error
                  : `${full(current.rowsRead)} rows read, ${current.rows} returned, ${current.elapsedMs} ms in RawTree, ${current.roundTripMs} ms round trip`}
              </p>
              <pre className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-1.5 font-mono text-[0.72rem] leading-snug whitespace-pre-wrap break-words text-muted">
                {current.sql}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </Tile>
  );
}
