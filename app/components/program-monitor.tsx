"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import type { Bulletin } from "@/lib/state";
import { ago, full, sponsorOf } from "./format";
import type { Production } from "./production";
import { Tile } from "./tile";

const ANCHOR_URL = "/api/media/anchor/studio.jpg";

function ProductionStrip({ production }: { production: Production }) {
  const active = production.stages.find((s) => s.state === "active");
  return (
    <div className="absolute inset-x-0 top-0 z-10 bg-[#07101fe6] px-4 py-3 backdrop-blur-sm">
      <div className="flex items-baseline gap-3">
        <span className="semi shrink-0 text-lg font-bold">Producing {production.repo}</span>
        {active?.detail ? <span className="truncate text-sm text-muted">{active.detail}</span> : null}
      </div>
      <ol className="mt-2 grid grid-cols-6 gap-1.5" aria-label="Production stages">
        {production.stages.map((stage) => {
          const color = sponsorOf(stage.sponsor).color;
          return (
            <li key={stage.key} className="semi text-sm" aria-current={stage.state === "active" ? "step" : undefined}>
              <div
                className="mb-1 h-1.5 rounded-sm"
                style={{
                  background: stage.state === "pending" ? "var(--line)" : color,
                  opacity: stage.state === "skipped" ? 0.35 : 1,
                  animation: stage.state === "active" ? "tally 1.2s ease-in-out infinite" : undefined,
                }}
              />
              <span className={stage.state === "pending" ? "text-faint" : "text-text"}>
                {stage.label}
                {stage.state === "skipped" ? " (skipped)" : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The lower third. Keyed by story, so a new bulletin remounts it and replays the slide-in. */
function Chyron({ bulletin }: { bulletin: Bulletin }) {
  const [index, setIndex] = useState(0);
  const captions = bulletin.captions.filter((c) => c.text);
  useEffect(() => {
    if (captions.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % captions.length), 5000);
    return () => clearInterval(id);
  }, [captions.length]);
  const caption = captions[index % Math.max(captions.length, 1)];

  return (
    <div className="chyron chyron-in">
      <div className="chyron-tab">BREAKOUT</div>
      <div className="chyron-headline">{bulletin.headline}</div>
      <div className="chyron-source">
        {caption ? (
          <span key={index} className="caption-swap flex min-w-0 items-center gap-3">
            <span className="truncate">{caption.text}</span>
            {caption.domain ? <span className="shrink-0 opacity-70">Source: {caption.domain}</span> : null}
            {caption.confidence ? (
              <span
                className="semi shrink-0 rounded-sm px-1.5 text-sm font-bold"
                style={{
                  background:
                    caption.confidence === "high" ? "var(--green-3)" : caption.confidence === "medium" ? "var(--flux)" : "var(--line)",
                  color: "var(--chyron-ink)",
                }}
              >
                {caption.confidence} confidence
              </span>
            ) : null}
          </span>
        ) : (
          <span className="truncate">github.com/{bulletin.repo}</span>
        )}
      </div>
      <div className="chyron-momentum">
        <strong>+{full(bulletin.stars1h)}</strong>
        <span className="text-sm">stars last hour</span>
      </div>
    </div>
  );
}

export function ProgramMonitor({
  bulletin,
  isLive,
  anchorAvailable,
  production,
  soundOn,
  onSoundToggle,
  onRequestFinal,
  finalRequested,
}: {
  bulletin: Bulletin | null;
  isLive: boolean;
  anchorAvailable: boolean;
  production: Production | null;
  soundOn: boolean;
  onSoundToggle: () => void;
  onRequestFinal: (storyId: string) => void;
  finalRequested: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (video.current) video.current.muted = !soundOn;
  }, [soundOn]);

  const replay = () => {
    if (!video.current) return;
    video.current.currentTime = 0;
    void video.current.play();
  };

  const note = bulletin
    ? `${isLive ? "Latest" : "Replay"}: ${bulletin.repo}, ${ago(bulletin.ts)}`
    : "Standing by for the first breakout";

  return (
    <Tile
      title="Program"
      note={note}
      sponsor="flux"
      sponsorLabel={bulletin?.isFinal ? "FLUX 3 final render" : "FLUX 3 video with audio"}
      className={`program ${bulletin ? "" : "standby"}`}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        {bulletin?.videoUrl ? (
          <video
            ref={video}
            key={bulletin.videoUrl}
            src={bulletin.videoUrl}
            poster={anchorAvailable ? ANCHOR_URL : undefined}
            className="h-full w-full object-cover"
            autoPlay
            playsInline
            muted={!soundOn}
          />
        ) : anchorAvailable ? (
          <img src={ANCHOR_URL} alt="The Breakout anchor at the studio desk" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(ellipse_at_center,#16294a,#07101f)]">
            <p className="cond text-6xl font-extrabold text-muted/70">Breakout</p>
          </div>
        )}

        {production ? <ProductionStrip production={production} /> : null}
        {bulletin ? <Chyron key={bulletin.storyId} bulletin={bulletin} /> : null}
        {!bulletin && !production ? (
          <div className="absolute inset-x-0 bottom-0 bg-[#07101fcc] px-6 py-5">
            <p className="semi text-2xl font-bold">Standing by</p>
            <p className="text-muted">The desk goes on air when a repo breaks out. Assign one yourself with the box on the right.</p>
          </div>
        ) : null}
      </div>

      {bulletin ? (
        <div className="flex items-start gap-4 border-t border-line px-4 py-2.5">
          <p className="min-w-0 flex-1 text-[0.95rem] leading-snug text-muted">{bulletin.dialogue}</p>
          <div className="flex shrink-0 gap-2">
            {bulletin.videoUrl ? (
              <>
                <button type="button" onClick={onSoundToggle} className="semi rounded-sm bg-tile-raised px-3 py-1.5 font-semibold hover:bg-line">
                  {soundOn ? "Mute" : "Sound on"}
                </button>
                <button type="button" onClick={replay} className="semi rounded-sm bg-tile-raised px-3 py-1.5 font-semibold hover:bg-line">
                  Replay
                </button>
              </>
            ) : null}
            {bulletin.videoUrl && !bulletin.isFinal ? (
              <button
                type="button"
                disabled={finalRequested}
                onClick={() => onRequestFinal(bulletin.storyId)}
                className="semi rounded-sm px-3 py-1.5 font-semibold text-[#1b1203] disabled:opacity-60"
                style={{ background: "var(--flux)" }}
              >
                {finalRequested ? "Rendering final cut" : "Render final cut"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Tile>
  );
}
