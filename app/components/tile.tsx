import type { ReactNode } from "react";
import { compact, sponsorOf } from "./format";

export interface Latency {
  elapsedMs: number;
  rowsRead: number;
}

export function SponsorTag({ sponsor, label }: { sponsor: string; label?: string }) {
  const meta = sponsorOf(sponsor);
  return (
    <span className="source">
      <span className="tally-square" style={{ background: meta.color }} aria-hidden />
      {label ?? meta.name}
    </span>
  );
}

/** A multiviewer tile: the strip on top names the source that feeds it. */
export function Tile({
  title,
  note,
  sponsor,
  sponsorLabel,
  latency,
  className = "",
  children,
}: {
  title: string;
  note?: ReactNode;
  sponsor?: string;
  sponsorLabel?: string;
  latency?: Latency;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`tile ${className}`} aria-label={title}>
      <header className="umd">
        <span>{title}</span>
        {note ? <span className="note">{note}</span> : null}
        {sponsor ? <SponsorTag sponsor={sponsor} label={sponsorLabel} /> : null}
        {latency ? (
          <span className="cond text-base font-bold" style={{ color: "var(--rawtree)" }} title={`RawTree execution time; ${latency.rowsRead.toLocaleString("en-US")} rows read`}>
            {latency.elapsedMs} ms{latency.rowsRead >= 1000 ? ` / ${compact(latency.rowsRead)} rows` : ""}
          </span>
        ) : null}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
