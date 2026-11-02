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
  if (/understanding/.test(key)) return COLORS.picture;
  if (/calendar/.test(key)) return COLORS.world;
  if (/^note/.test(key)) return COLORS.memory;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE[hash % SPARE.length];
}

export function traceHref(span: TraceSpan): string | null {
  if (span.destination === "debate" && span.targetId) return `/debates/${span.targetId}`;
  const where = span.destination.toLowerCase();
  if (/picture/.test(where)) return "/picture";
  if (/ledger|follow/.test(where)) return "/todos";
  if (/understanding/.test(where)) return "/picture";
  if (/calendar/.test(where)) return "/calendar";
  if (/^note/.test(where)) return "/library";
  if (span.destination === "world") return "/discovery";
  if (span.destination === "soul" || span.destination === "behavior") return "/soul";
  return null;
}

/**
 * His words with what it did with them: each phrase it kept is underlined in its destination's colour and flashes
 * when it lands. Hovering a phrase opens a small box over the text saying where it went; clicking opens the detail.
 */
export function TraceView({ text, spans, onOpen }: { text: string; spans: TraceSpan[]; onOpen: (span: TraceSpan) => void }) {
  const marks = spans.filter((span) => span.start >= 0 && span.end > span.start && span.end <= text.length);
  const cuts = new Set<number>([0, text.length]);
  for (const span of marks) {
    cuts.add(span.start);
    cuts.add(span.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  return (
    <div className="relative whitespace-pre-wrap leading-relaxed">
      {points.slice(0, -1).map((start, index) => {
        const end = points[index + 1];
        const piece = text.slice(start, end);
        const covering = marks.filter((span) => span.start <= start && span.end >= end);
        if (!covering.length) return <span key={`${start}-${end}`}>{piece}</span>;
        const shadows = covering.map((span, layer) => `inset 0 -${2 + layer * 3}px 0 ${traceColor(span.destination)}`).join(", ");
        const flashing = covering.some((span) => span.flash);
        const shown = covering.filter((span) => span.destination !== "topic");
        return (
          <span key={`${start}-${end}`} className="trace-anchor group relative inline">
            <button type="button" className={`bg-transparent p-0 text-inherit ${flashing ? "trace-flash" : ""}`} style={{ boxShadow: shadows }} onClick={() => onOpen(covering[0])}>
              {piece}
            </button>
            {shown.length ? (
              <span className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden w-max max-w-[260px] space-y-1 group-hover:block group-focus-within:block">
                {shown.map((span) => (
                  <span key={span.id} className="block rounded-md border bg-card px-2 py-1 text-left text-xs shadow" style={{ borderColor: traceColor(span.destination) }}>
                    <span className="uppercase tracking-wide text-muted-foreground">{span.destination}</span>
                    <span className="block">{span.label}</span>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        );
      })}
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
