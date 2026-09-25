"use client";

/* eslint-disable @next/next/no-img-element */
import type { CSSProperties } from "react";
import type { DashboardState } from "@/lib/state";
import { ago } from "./format";

/** The news crawl: real people starring tracked repos, straight from the raw event log. */
export function Ticker({ items }: { items: DashboardState["ticker"] }) {
  const loop = items.length ? [...items, ...items] : [];
  const speed = { "--crawl-duration": `${Math.max(30, items.length * 5)}s` } as CSSProperties;
  return (
    <footer className="flex h-11 items-stretch overflow-hidden border-t border-line bg-[#0a1628]" aria-label="Live stars">
      <div className="semi flex shrink-0 items-center gap-2 px-4 font-bold" style={{ background: "var(--green-1)" }}>
        <span className="tally-square" style={{ background: "var(--green-4)" }} aria-hidden />
        Live stars
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {loop.length ? (
          <div className="crawl h-full items-center" style={speed}>
            {loop.map((item, i) => (
              <span key={`${item.repo}-${item.login}-${i}`} className="flex shrink-0 items-center gap-2 px-6 whitespace-nowrap">
                {item.avatar ? <img src={item.avatar} alt="" className="h-6 w-6 rounded-full" /> : null}
                <span className="font-semibold">{item.login}</span>
                <span className="text-muted">starred</span>
                <span className="font-semibold text-star">{item.repo}</span>
                <span className="text-faint">{ago(item.ts)}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="flex h-full items-center px-6 text-muted">Stars appear here as the worker logs them.</p>
        )}
      </div>
    </footer>
  );
}
