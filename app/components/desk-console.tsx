"use client";

import { useState, type FormEvent } from "react";
import { sponsorOf } from "./format";

interface AskStep {
  tool: string;
  sponsor: string;
  summary: string;
  ms: number;
}

interface AskAnswer {
  answer: string;
  model: string;
  steps: AskStep[];
}

/** Turn bare URLs in the answer into links, keep everything else as text. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)\]]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all underline decoration-faint hover:text-text">
            {part.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * The desk console: ask the research agent (Nimble web tools + RawTree data tools),
 * or assign a repo for a full broadcast. Both requests are recorded in RawTree.
 */
export function DeskConsole({ onAssign }: { onAssign: (repo: string) => Promise<string> }) {
  const [mode, setMode] = useState<"ask" | "assign">("ask");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      if (mode === "assign") {
        const repo = await onAssign(text);
        setStatus({ ok: true, text: `Assigned ${repo}. The desk picks it up within seconds.` });
        setValue("");
      } else {
        setAnswer(null);
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: text }),
        });
        const body = (await response.json()) as AskAnswer & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "The desk could not answer that");
        setAnswer(body);
      }
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  };

  const tabClass = (active: boolean) =>
    `semi rounded-sm px-2.5 py-1 text-base font-bold ${active ? "bg-tile-raised text-text" : "text-muted hover:text-text"}`;

  return (
    <section className={`tile shrink-0 ${answer ? "max-h-[46%]" : ""}`} aria-label="Desk console">
      <header className="umd gap-1">
        <button type="button" className={tabClass(mode === "ask")} onClick={() => setMode("ask")} aria-pressed={mode === "ask"}>
          Ask the desk
        </button>
        <button type="button" className={tabClass(mode === "assign")} onClick={() => setMode("assign")} aria-pressed={mode === "assign"}>
          Assign a story
        </button>
        <span className="source">
          <span className="tally-square" style={{ background: sponsorOf("nimble").color }} aria-hidden />
          Nimble
          <span className="tally-square ml-1" style={{ background: sponsorOf("rawtree").color }} aria-hidden />
          RawTree
        </span>
      </header>
      <form onSubmit={submit} className="flex gap-2 p-3">
        <label htmlFor="desk-input" className="sr-only">
          {mode === "ask" ? "Question for the desk" : "Repo to cover"}
        </label>
        <input
          id="desk-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={mode === "ask" ? "Why is paperclipai/paperclip taking off?" : "owner/name or a GitHub link"}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-sm border border-line bg-wall px-3 py-2 text-base placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={busy}
          className="semi rounded-sm bg-tally px-4 py-2 text-base font-bold text-white hover:brightness-110 disabled:opacity-60"
        >
          {busy ? (mode === "ask" ? "Asking" : "Assigning") : mode === "ask" ? "Ask" : "Assign"}
        </button>
      </form>
      {busy && mode === "ask" ? (
        <p className="px-3 pb-3 text-sm text-muted">The agent is working. Its tool calls show up in the newsroom log as they happen.</p>
      ) : null}
      {status ? (
        <p className={`px-3 pb-3 text-sm ${status.ok ? "text-muted" : "text-[#ff9b9b]"}`} role="status">
          {status.text}
        </p>
      ) : null}
      {answer ? (
        <div className="scroll-quiet min-h-0 overflow-y-auto border-t border-line px-3 py-2.5" aria-live="polite">
          <p className="text-[0.98rem] leading-relaxed whitespace-pre-wrap">
            <Linked text={answer.answer.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "")} />
          </p>
          <p className="mt-2 text-xs text-faint">
            {answer.steps.length} tool calls by {answer.model}:{" "}
            {answer.steps.map((step, i) => (
              <span key={i} style={{ color: sponsorOf(step.sponsor).color }}>
                {i ? ", " : ""}
                {step.tool} ({step.ms} ms)
              </span>
            ))}
          </p>
        </div>
      ) : null}
    </section>
  );
}
