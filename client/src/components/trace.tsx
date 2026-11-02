import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export interface TraceSpan {
  id: string;
  messageId?: string | null;
  start: number;
  end: number;
  phrase: string;
  destination: string;
  label: string;
  targetId: string | null;
  flash?: boolean;
  seen?: boolean;
}

const COLORS: Record<string, string> = {
  picture: "#e8c547",
  world: "#7eb6ff",
  followup: "#e07a5f",
  soul: "#c4b5fd",
  debate: "#f2a2c0",
  behavior: "#8fd19e",
  memory: "#9ad1d4",
};

/** Destinations are its own words, so any name gets a steady colour of its own. */
const SPARE = ["#e8c547", "#7eb6ff", "#e07a5f", "#c4b5fd", "#f2a2c0", "#8fd19e", "#9ad1d4", "#f4a261", "#b8c0ff", "#a3d9a5"];
export function traceColor(destination: string): string {
  const key = destination.toLowerCase();
  if (COLORS[key]) return COLORS[key];
  if (/picture/.test(key)) return COLORS.picture;
  if (/ledger|follow/.test(key)) return COLORS.followup;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE[hash % SPARE.length];
}

export function traceHref(span: TraceSpan): string | null {
  if (span.destination === "debate" && span.targetId) return `/debates/${span.targetId}`;
  const where = span.destination.toLowerCase();
  if (/picture/.test(where)) return "/picture";
  if (/ledger|follow/.test(where)) return "/todos";
  if (span.destination === "world") return "/discovery";
  if (span.destination === "soul" || span.destination === "behavior") return "/soul";
  return null;
}

export function TraceView({ text, spans, onOpen }: { text: string; spans: TraceSpan[]; onOpen: (span: TraceSpan) => void }) {
  const marks = spans.filter((span) => span.start >= 0 && span.end > span.start);
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ id: string; x1: number; y1: number; x2: number; y2: number; color: string }[]>([]);
  // Spans being hovered: their box and connector line show again together.
  const [hot, setHot] = useState<string[]>([]);
  const flashing = new Set(marks.filter((span) => span.flash).map((span) => span.id));
  // A line always shares its box's visibility: flash and fade with it, return with it on hover.
  const shown = (spanId: string) => (hot.includes(spanId) ? "opacity-100" : flashing.has(spanId) ? "trace-pop" : "opacity-0");

  useLayoutEffect(() => {
    const root = wrap.current;
    if (!root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      const next: typeof lines = [];
      for (const span of marks) {
        const from = root.querySelector<HTMLElement>(`[data-anchor~="${span.id}"]`);
        const to = root.querySelector<HTMLElement>(`[data-box="${span.id}"]`);
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        next.push({
          id: span.id,
          x1: a.left + a.width / 2 - box.left,
          y1: a.bottom - box.top - 1,
          x2: b.left + 16 - box.left,
          y2: b.top - box.top,
          color: traceColor(span.destination),
        });
      }
      setLines((prev) => {
        if (
          prev.length === next.length &&
          prev.every((line, index) => line.x1 === next[index].x1 && line.y1 === next[index].y1 && line.x2 === next[index].x2 && line.y2 === next[index].y2)
        ) return prev;
        return next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text, marks.map((span) => span.id).join("|")]);

  const cuts = new Set<number>([0, text.length]);
  for (const span of marks) {
    if (span.end <= text.length) {
      cuts.add(span.start);
      cuts.add(span.end);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);

  return (
    <div ref={wrap} className="relative">
      <svg className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible" aria-hidden="true">
        {lines.map((line) => (
          <line key={line.id} className={`transition-opacity ${shown(line.id)}`} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke={line.color} strokeWidth="1.5" />
        ))}
      </svg>
      <div className="relative whitespace-pre-wrap leading-relaxed">
        {points.slice(0, -1).map((start, index) => {
          const end = points[index + 1];
          const piece = text.slice(start, end);
          const covering = marks.filter((span) => span.start <= start && span.end >= end);
          if (!covering.length) return <span key={`${start}-${end}`}>{piece}</span>;
          const shadows = covering.map((span, layer) => `inset 0 -${2 + layer * 3}px 0 ${traceColor(span.destination)}`).join(", ");
          return (
            <span
              key={`${start}-${end}`}
              className="trace-anchor relative inline"
              data-anchor={covering.map((span) => span.id).join(" ")}
              onMouseEnter={() => setHot(covering.map((span) => span.id))}
              onMouseLeave={() => setHot([])}
              onFocus={() => setHot(covering.map((span) => span.id))}
              onBlur={() => setHot([])}
            >
              <button type="button" className="bg-transparent p-0 text-inherit" style={{ boxShadow: shadows }} onClick={() => onOpen(covering[0])}>
                {piece}
              </button>
              {covering.filter((span) => span.destination !== "topic").map((span, layer) => (
                <span
                  key={span.id}
                  className={`trace-pop absolute z-20 mt-1 w-max max-w-[220px] rounded-md border bg-card px-2 py-1 text-left text-xs ${span.flash ? "" : "pointer-events-none opacity-0"}`}
                  style={{ borderColor: traceColor(span.destination), left: layer * 8, top: "100%" }}
                >
                  <span className="mb-1 block h-2 w-px" style={{ background: traceColor(span.destination) }} />
                  <span className="uppercase tracking-wide text-muted-foreground">{span.destination}</span>
                  <span className="block">{span.label}</span>
                </span>
              ))}
            </span>
          );
        })}
      </div>
      {marks.length ? (
        <div className="relative mt-4 flex flex-wrap gap-2">
          {marks.map((span) => (
            <button
              key={span.id}
              type="button"
              data-box={span.id}
              className={`rounded-md border px-2 py-1 text-left text-xs transition-opacity ${shown(span.id)}`}
              onMouseEnter={() => setHot([span.id])}
              onMouseLeave={() => setHot([])}
              style={{ borderColor: traceColor(span.destination) }}
              onClick={() => onOpen(span)}
            >
              <span className="uppercase tracking-wide text-muted-foreground">{span.destination}</span>
              <div>{span.label}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TraceDetail({ span, onClose }: { span: TraceSpan; onClose: () => void }) {
  const href = traceHref(span);
  return (
    <div className="rounded-md border border-border p-3 text-sm">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{span.destination}</div>
      <p className="mt-1">{span.label}</p>
      {span.phrase && span.start >= 0 ? <blockquote className="mt-2 border-l-2 border-border pl-3 text-muted-foreground">“{span.phrase}”</blockquote> : null}
      {href ? <Link className="mt-2 inline-block text-primary" to={href}>Open it</Link> : null}
      <button className="mt-2 block text-xs text-muted-foreground" onClick={onClose}>Close</button>
    </div>
  );
}
