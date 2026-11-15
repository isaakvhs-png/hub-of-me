import React from "react";
import { COLOURS } from "./api";
import { useShell } from "./shared";

export interface Ref { type: string; title: string; origin: string; mime?: string | null }

/**
 * A summary's text in colour. Each statement ends with markers to where it came from; the statement takes the colour of
 * its first marker (white from him, cyan from the web, green from work sessions). Text with no marker is its own
 * thought: amber. {{isaak}}…{{/isaak}} is what he typed himself: white with a mark. [[img:ID]] is a picture.
 */
export function Body({ body, refs }: { body: string; refs: Record<string, Ref> }) {
  const { openSummary, openSource } = useShell();
  const out: React.ReactNode[] = [];
  const re = /(\[\[(?:s|m|img):[^\]]+\]\]|\{\{isaak\}\}[\s\S]*?\{\{\/isaak\}\})/g;
  const parts = body.split(re).filter((p) => p !== "");
  let pending: string[] = [];
  let k = 0;
  const flush = (colour: string) => {
    if (!pending.length) return;
    out.push(<span key={k++} style={{ color: colour }}>{pending.join("")}</span>);
    pending = [];
  };
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const m = /^\[\[(s|m|img):([^\]]+)\]\]$/.exec(part);
    if (m) {
      const [, t, refId] = m;
      const ref = refs[refId];
      if (t === "img") {
        flush("var(--amber)");
        out.push(<img key={k++} src={`/api/sources/${refId}/file`} alt={ref?.title ?? "picture"} onClick={() => openSource(refId)} />);
        continue;
      }
      flush(COLOURS[ref?.origin ?? "self"] ?? "var(--amber)");
      out.push(<span key={k++} className="ref" title={ref ? ref.title : "gone"} onClick={() => (t === "m" ? openSummary(refId) : openSource(refId))}>[{t === "m" ? "◆" : "•"}]</span>);
      continue;
    }
    const mine = /^\{\{isaak\}\}([\s\S]*?)\{\{\/isaak\}\}$/.exec(part);
    if (mine) {
      flush("var(--amber)");
      out.push(<span key={k++} className="mine" style={{ color: "var(--white)" }}>{mine[1]}</span>);
      continue;
    }
    // Text up to a line break that is not followed by a marker on the same line is its own thought.
    const lines = part.split(/(\n)/);
    for (const piece of lines) {
      if (piece === "\n") {
        const nextIsMarker = i + 1 < parts.length && /^\[\[(s|m)/.test(parts[i + 1]);
        if (!nextIsMarker) flush("var(--amber)");
        out.push("\n");
        continue;
      }
      pending.push(piece);
    }
  }
  flush("var(--amber)");
  return <div className="prose">{out}</div>;
}

export function Legend() {
  const items: [string, string][] = [["var(--white)", "from you"], ["var(--cyan)", "from the web"], ["var(--amber)", "its own thoughts"], ["var(--green)", "work sessions"]];
  return (
    <div className="legend">
      {items.map(([c, t]) => <span key={t}><span className="sw" style={{ background: c }} />{t}</span>)}
      <span><span style={{ color: "var(--white)" }}>✎</span> typed by you</span>
      <span><span style={{ color: "var(--amber)" }}>·</span> outdated</span>
    </div>
  );
}
