import type { ReactNode } from "react";

/**
 * Its replies point at things: [[map:path|label]] at parts of itself (the view walks through them),
 * [[b:id]] / [[p:id]] / [[s:id]] at its memory. Both become buttons; everything else stays plain text.
 */
export function RichText({ text, onMap, onMemory }: { text: string; onMap: (path: string) => void; onMemory: (kind: string, id: string) => void }) {
  const out: ReactNode[] = [];
  const re = /\[\[(map|b|p|s):([^|\]]+)(?:\|([^\]]+))?\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, kind, id, label] = m;
    if (kind === "map") out.push(<button type="button" key={i++} className="ref" onClick={() => onMap(id)}>{label ?? id}</button>);
    else out.push(<button type="button" key={i++} className="cite" title={`${kind === "b" ? "brick" : kind === "p" ? "page" : "source"} ${id}`} onClick={() => onMemory(kind === "b" ? "brick" : kind === "p" ? "page" : "source", id)}>{label ?? (kind === "b" ? "brick" : kind === "p" ? "page" : "source")}</button>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`);
export const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
