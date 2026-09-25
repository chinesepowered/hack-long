"use client";

import type { FeedItem } from "@/lib/state";
import { sponsorOf, utcTime } from "./format";
import { Tile, type Latency } from "./tile";

/** The flight recorder, live: every step the desk takes, tagged with the tech that did it. */
export function NewsroomFeed({ items, currentStory, latency }: { items: FeedItem[]; currentStory?: string; latency?: Latency }) {
  return (
    <Tile title="Newsroom log" note="every step, recorded in RawTree" sponsor="rawtree" sponsorLabel="agent_events" latency={latency}>
      {items.length === 0 ? (
        <p className="p-4 text-muted">No activity yet. Start the worker with pnpm worker.</p>
      ) : (
        <ol className="scroll-quiet min-h-0 flex-1 overflow-y-auto py-1" aria-live="polite">
          {items.map((item, i) => {
            const meta = sponsorOf(item.sponsor);
            const inStory = currentStory && item.storyId === currentStory;
            return (
              <li
                key={`${item.ts}-${item.step}-${i}`}
                className={`feed-enter grid grid-cols-[4.6rem_5.2rem_minmax(0,1fr)] gap-x-2 px-3 py-1 text-[0.92rem] leading-snug ${
                  inStory ? "bg-tile-raised/70" : ""
                }`}
              >
                <time className="text-faint tabular-nums">{utcTime(item.ts)}</time>
                <span className="semi flex items-start gap-1.5 font-semibold" style={{ color: meta.color }}>
                  <span className="tally-square mt-[0.35rem]" style={{ background: meta.color }} aria-hidden />
                  {meta.name}
                </span>
                <span
                  className={
                    item.status === "error" ? "text-[#ff9b9b]" : item.status === "progress" ? "text-muted" : "text-text"
                  }
                >
                  {item.repo && !item.message.includes(item.repo) ? <span className="text-muted">{item.repo}: </span> : null}
                  {item.message}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Tile>
  );
}
