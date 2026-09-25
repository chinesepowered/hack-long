"use client";

import type { DashboardState } from "@/lib/state";
import { compact, full } from "./format";
import { Tile, type Latency } from "./tile";

/** What RawTree is chewing on: the raw GH Archive firehose, hour by hour, no schema anywhere. */
export function Firehose({ hours, totalEvents, latency }: { hours: DashboardState["firehose"]; totalEvents: number; latency?: Latency }) {
  const max = Math.max(1, ...hours.map((h) => h.events));
  const width = 100 / Math.max(hours.length, 1);
  return (
    <Tile title="Firehose" note={`${full(totalEvents)} raw GitHub events, no schema`} sponsor="rawtree" sponsorLabel="RawTree URL ingest" latency={latency}>
      {hours.length === 0 ? (
        <p className="p-4 text-muted">The first hour of GH Archive lands a minute after the worker starts.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-1.5">
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="min-h-0 w-full flex-1" role="img" aria-label="Events per hour">
            {hours.map((h, i) => {
              const barHeight = (h.events / max) * 38;
              return (
                <rect key={h.hour} x={i * width + width * 0.12} y={40 - barHeight} width={width * 0.76} height={barHeight} fill="var(--rawtree)" opacity={0.85}>
                  <title>{`${new Date(h.hour * 1000).toISOString().slice(11, 13)}:00 UTC, ${full(h.events)} events, ${full(h.stars)} stars`}</title>
                </rect>
              );
            })}
          </svg>
          <div className="mt-1 flex justify-between text-xs text-faint">
            <span>{hours.length > 48 ? `${Math.round(hours.length / 24)} days ago` : `${hours.length} hours ago`}</span>
            <span>{compact(hours[hours.length - 1].events)} events in the latest hour</span>
            <span>latest hour</span>
          </div>
        </div>
      )}
    </Tile>
  );
}
