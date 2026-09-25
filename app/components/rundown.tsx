"use client";

/* eslint-disable @next/next/no-img-element */
import type { Bulletin } from "@/lib/state";
import { utcTime } from "./format";

/** Every bulletin the desk has aired, newest first. Pick one to put it back on the program monitor. */
export function Rundown({
  bulletins,
  selectedId,
  onSelect,
  anchorAvailable,
}: {
  anchorAvailable: boolean;
  bulletins: Bulletin[];
  selectedId?: string;
  onSelect: (storyId: string) => void;
}) {
  if (bulletins.length === 0) return null;
  return (
    <nav aria-label="Rundown" className="scroll-quiet flex gap-1.5 overflow-x-auto">
      {bulletins.map((b, i) => {
        const selected = b.storyId === selectedId;
        return (
          <button
            key={b.storyId}
            type="button"
            onClick={() => onSelect(b.storyId)}
            aria-pressed={selected}
            className={`flex w-64 shrink-0 gap-2.5 rounded-[3px] border-b-2 p-1.5 text-left ${
              selected ? "border-text bg-tile-raised" : "border-transparent bg-tile hover:bg-tile-raised"
            }`}
          >
            {anchorAvailable && b.posterUrl ? (
              <img src={b.posterUrl} alt="" className="aspect-video h-12 shrink-0 rounded-sm object-cover" />
            ) : (
              <span className="aspect-video h-12 shrink-0 rounded-sm bg-tile-raised" />
            )}
            <span className="min-w-0">
              <span className="semi block truncate font-bold">{b.headline}</span>
              <span className="block truncate text-xs text-muted">
                {i === 0 ? "Latest, " : ""}
                {utcTime(b.ts).slice(0, 5)} UTC, {b.repo}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
