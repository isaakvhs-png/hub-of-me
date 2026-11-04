import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * The Mind page: its web of bricks (MIND_DESIGN.md), with three layers he can switch on and off:
 * energy (what the last thought lit up), warmth (what is still on its mind, fading over hours) and age (when each
 * moment came in, red for long ago and blue for recent, relative to its whole life since the fresh start).
 */

interface Brick { id: string; name: string; kind: string; origin: string; summary: string; contact: string; warmth: number; litCount: number; createdAt: string; moments: string[] }
interface Link { id: string; a: string; b: string; type: string; strength: number; reason: string }
interface Agenda { id: string; kind: string; text: string; why: string; nextStep: string; status: string; closeNote: string; createdAt: string; closedAt: string | null }
interface Session { id: string; goal: string; wins: string; leftOff: string; endedWhy: string; costEurCents: number; startedAt: string; endedAt: string | null; log: { step: number; thought: string; tools: { tool: string; what: string; result: string }[] }[] }
interface Brain { bornAt: string | null; now: string; bricks: Brick[]; links: Link[]; agenda: Agenda[]; sessions: Session[]; activation: { cause: string; energies: Record<string, number>; used: string[]; at: string } | null; running: { phase: string; label: string } | null }
interface Detail { brick: Brick; moments: { quote: string; at: string | null; source: string }[]; entries: { id: string; kind: string; text: string; origin: string; status: string; statusNote: string }[]; links: (Link & { other: string; otherName: string })[] }

const W = 1000, H = 700;

/** A small force layout: bricks push each other apart, links pull them together. Seeded, so the map doesn't jump between loads. */
function layout(bricks: Brick[], links: Link[], prev: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  for (const b of bricks) {
    const p = prev.get(b.id);
    pos.set(b.id, { x: p?.x ?? W / 2 + (rand() - 0.5) * W * 0.8, y: p?.y ?? H / 2 + (rand() - 0.5) * H * 0.8, vx: 0, vy: 0 });
  }
  const list = [...pos.values()];
  const iterations = prev.size ? 120 : 320;
  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i], b = list[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = 2600 / d2;
        const d = Math.sqrt(d2); dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    for (const l of links) {
      const a = pos.get(l.a), b = pos.get(l.b);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const want = l.type === "source" ? 170 : 90;
      const k = (l.type === "source" ? 0.004 : 0.012) * Math.min(l.strength, 4);
      const f = (d - want) * k;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const p of list) {
      p.vx += (W / 2 - p.x) * 0.002; p.vy += (H / 2 - p.y) * 0.002;
      p.x += Math.max(-20, Math.min(20, p.vx)) * cool; p.y += Math.max(-20, Math.min(20, p.vy)) * cool;
      p.vx *= 0.6; p.vy *= 0.6;
    }
  }
  return new Map([...pos.entries()].map(([k, v]) => [k, { x: v.x, y: v.y }]));
}

/** Red for the oldest moment of its life, blue for the newest. */
function ageColor(at: string, born: number, now: number): string {
  const t = now > born ? Math.min(1, Math.max(0, (new Date(at).getTime() - born) / (now - born))) : 1;
  return `hsl(${Math.round(6 + t * 214)} 70% 56%)`;
}

const originFill: Record<string, string> = { his: "hsl(150 30% 22%)", own: "hsl(262 25% 26%)", web: "hsl(214 30% 24%)" };
const linkColor: Record<string, string> = { together: "hsl(40 6% 46%)", source: "hsl(40 6% 34%)", about: "hsl(214 55% 62%)", meaning: "hsl(150 45% 52%)", used: "hsl(42 85% 55%)", insight: "hsl(262 60% 72%)" };

export function MindPage() {
  const [brain, setBrain] = useState<Brain | null>(null);
  const [error, setError] = useState("");
  const [layers, setLayers] = useState({ energy: true, warmth: true, age: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  async function load() {
    try { setBrain(await api<Brain>("/api/brain")); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Could not load the web."); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const t = setInterval(() => void load(), brain?.running ? 3000 : 15000);
    return () => clearInterval(t);
  }, [brain?.running]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    api<Detail>(`/api/brain/bricks/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected, brain?.bricks.length, brain?.links.length]);

  const pos = useMemo(() => {
    if (!brain) return new Map<string, { x: number; y: number }>();
    const next = layout(brain.bricks, brain.links, positions.current);
    positions.current = next;
    return next;
  }, [brain?.bricks.length, brain?.links.length]);

  async function explore() {
    try { await api("/api/brain/explore", { method: "POST", body: "{}" }); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Could not start."); }
  }

  if (!brain) return <p className="text-sm text-muted-foreground">{error || "Opening its mind…"}</p>;
  const born = brain.bornAt ? new Date(brain.bornAt).getTime() : Date.now() - 3_600_000;
  const now = new Date(brain.now).getTime();
  const energies = layers.energy ? brain.activation?.energies ?? {} : {};
  const used = new Set(layers.energy ? brain.activation?.used ?? [] : []);
  const width = (t: string) => Math.min(220, Math.min(t.length, 28) * 7.4 + 20);
  const open = brain.agenda.filter((a) => a.status === "open");
  const closed = brain.agenda.filter((a) => a.status !== "open").slice(-6).reverse();

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <h1 className="mr-auto font-serif text-2xl italic">Mind</h1>
          {(["energy", "warmth", "age"] as const).map((k) => (
            <button key={k} className={`rounded-full border px-3 py-1 text-xs ${layers[k] ? "border-primary text-primary" : "border-border text-muted-foreground"}`} onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}>
              {k === "energy" ? "Energy" : k === "warmth" ? "Warmth" : "Age"}
            </button>
          ))}
          <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50" disabled={Boolean(brain.running)} onClick={() => void explore()}>
            {brain.running ? "Exploring…" : "Explore now"}
          </button>
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          {brain.bricks.length} bricks · {brain.links.length} links
          {brain.activation ? ` · last lit up by ${brain.activation.cause}, ${new Date(brain.activation.at).toLocaleTimeString()}` : ""}
          {brain.running ? ` · ${brain.running.phase}${brain.running.label ? `: ${brain.running.label}` : ""}` : ""}
        </p>
        {error ? <p className="pb-2 text-sm text-destructive">{error}</p> : null}
        <div className="overflow-hidden rounded-lg bg-background">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full touch-none select-none"
            onWheel={(e) => { const k = Math.min(4, Math.max(0.4, view.k * (e.deltaY < 0 ? 1.12 : 0.89))); setView((v) => ({ ...v, k })); }}
            onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }}
            onPointerMove={(e) => { if (drag.current) setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x) / v.k, y: drag.current!.vy + (e.clientY - drag.current!.y) / v.k })); }}
            onPointerUp={() => { drag.current = null; }}
            onPointerLeave={() => { drag.current = null; }}
          >
            <style>{`@keyframes warm { 0%,100% { opacity: var(--w); } 50% { opacity: calc(var(--w) * 0.45); } } .warm { animation: warm 3.2s ease-in-out infinite; } @media (prefers-reduced-motion: reduce) { .warm { animation: none; } }`}</style>
            <g transform={`translate(${W / 2} ${H / 2}) scale(${view.k}) translate(${-W / 2 + view.x} ${-H / 2 + view.y})`}>
              {brain.links.map((l) => {
                const a = pos.get(l.a), b = pos.get(l.b);
                if (!a || !b) return null;
                const lit = energies[l.a] && energies[l.b];
                return <line key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lit ? "hsl(42 90% 58%)" : linkColor[l.type] ?? "gray"} strokeOpacity={lit ? 0.95 : l.type === "source" ? 0.18 : 0.45} strokeWidth={0.8 + l.strength * 1.1} strokeDasharray={l.type === "meaning" ? "5 4" : l.type === "insight" ? "10 4" : undefined}><title>{`${l.type}${l.reason ? `: ${l.reason}` : ""} (strength ${l.strength.toFixed(1)})`}</title></line>;
              })}
              {brain.bricks.map((b) => {
                const p = pos.get(b.id);
                if (!p) return null;
                const w = width(b.name), h = 24;
                const e = energies[b.id] ?? 0;
                const fill = b.kind === "self" ? "hsl(46 50% 26%)" : b.kind === "source" ? "hsl(40 6% 20%)" : originFill[b.origin] ?? originFill.his;
                return (
                  <g key={b.id} transform={`translate(${p.x - w / 2} ${p.y - h / 2})`} className="cursor-pointer" onClick={(ev) => { ev.stopPropagation(); setSelected(b.id); }}>
                    {layers.warmth && b.warmth > 0.04 ? <rect className="warm" x={-5} y={-5} width={w + 10} height={h + 10} rx={8} fill="hsl(36 95% 55%)" style={{ ["--w" as string]: String(Math.min(0.55, b.warmth * 0.55)) }} /> : null}
                    <rect width={w} height={h} rx={4} fill={fill} stroke={selected === b.id ? "hsl(46 92% 60%)" : used.has(b.id) ? "hsl(42 90% 58%)" : b.origin === "own" ? "hsl(262 50% 70%)" : "hsl(40 10% 30%)"} strokeWidth={selected === b.id || used.has(b.id) ? 2.4 : 1} strokeDasharray={b.origin === "own" ? "3 2" : undefined} />
                    {e > 0 ? <rect width={w} height={h} rx={4} fill="hsl(42 95% 58%)" fillOpacity={Math.min(0.75, e * 0.75)} /> : null}
                    <text x={w / 2} y={16} textAnchor="middle" fontSize={13} fill="hsl(40 33% 94%)">{b.name.length > 28 ? `${b.name.slice(0, 27)}…` : b.name}</text>
                    {layers.age ? b.moments.slice(-10).map((m, i) => <circle key={i} cx={6 + i * 6} cy={-4} r={2.4} fill={ageColor(m, born, now)} />) : null}
                    {e > 0 ? <text x={w} y={-4} textAnchor="end" fontSize={10} fill="hsl(42 95% 62%)">{e.toFixed(2)}</text> : null}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
        <p className="pt-2 text-xs text-muted-foreground">Scroll to zoom, drag to move. Thicker line = used more often. Amber fill = energy of the last thought; amber glow = warmth, fading over hours; dots = each time it came up, red long ago, blue recent.</p>
      </section>

      <aside className="grid min-w-0 content-start gap-4">
        {detail ? (
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-2">
              <h2 className="mr-auto text-lg font-semibold">{detail.brick.name}</h2>
              <button className="text-xs text-muted-foreground" onClick={() => setSelected(null)}>Close</button>
            </div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{detail.brick.kind} · {detail.brick.origin === "own" ? "its own thought" : detail.brick.origin === "web" ? "from the web" : "from you"}</p>
            {detail.brick.summary ? <p className="mt-2 text-sm">{detail.brick.summary}</p> : null}
            {detail.brick.contact ? <p className="mt-2 text-sm"><span className="text-muted-foreground">Contact: </span>{detail.brick.contact}</p> : null}
            <h3 className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Moments</h3>
            <ul className="mt-1 grid gap-1 text-sm">
              {detail.moments.map((m, i) => <li key={i} className="border-l-2 pl-2" style={{ borderColor: m.at ? ageColor(m.at, born, now) : undefined }}>“{m.quote}” <span className="text-xs text-muted-foreground">{m.source} · {m.at ? new Date(m.at).toLocaleString() : ""}</span></li>)}
            </ul>
            {detail.entries.length ? <h3 className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Entries</h3> : null}
            <ul className="mt-1 grid gap-1 text-sm">
              {detail.entries.map((e) => <li key={e.id}><span className="text-xs text-muted-foreground">{e.kind} · {e.origin === "own" ? "its" : e.origin === "web" ? "web" : "yours"} · {e.status}</span><br />{e.text}{e.statusNote ? <span className="text-muted-foreground"> ({e.statusNote})</span> : null}</li>)}
            </ul>
            {detail.links.length ? <h3 className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Links</h3> : null}
            <ul className="mt-1 grid gap-1 text-sm">
              {detail.links.map((l) => <li key={l.id}><button className="text-left text-primary" onClick={() => setSelected(l.other)}>{l.otherName}</button> <span className="text-xs text-muted-foreground">{l.type} · {l.strength.toFixed(1)}{l.reason ? ` · ${l.reason}` : ""}</span></li>)}
            </ul>
          </section>
        ) : null}

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">Agenda</h2>
          <ul className="mt-2 grid gap-2 text-sm">
            {open.length === 0 ? <li className="text-muted-foreground">Nothing open.</li> : null}
            {open.map((a) => <li key={a.id}><span className="text-xs text-muted-foreground">{a.kind === "job" ? "your job" : a.kind === "pursuit" ? "its own" : a.kind}</span><br />{a.text}{a.nextStep ? <span className="block text-xs text-muted-foreground">next: {a.nextStep}</span> : null}</li>)}
          </ul>
          {closed.length ? <h3 className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Closed</h3> : null}
          <ul className="mt-1 grid gap-1 text-sm text-muted-foreground">
            {closed.map((a) => <li key={a.id}>{a.status === "done" ? "✓" : "✗"} {a.text}{a.closeNote ? ` (${a.closeNote})` : ""}</li>)}
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">Its own time</h2>
          <ul className="mt-2 grid gap-3 text-sm">
            {brain.sessions.length === 0 ? <li className="text-muted-foreground">No work sessions yet. Press Explore now.</li> : null}
            {brain.sessions.map((s) => (
              <li key={s.id}>
                <button className="text-left" onClick={() => setOpenSession(openSession === s.id ? null : s.id)}>
                  <span className="text-xs text-muted-foreground">{new Date(s.startedAt).toLocaleString()} · €{(s.costEurCents / 100).toFixed(2)} · {s.endedAt ? s.endedWhy : "running"}</span><br />
                  <span className="font-semibold">{s.goal || "(choosing a goal)"}</span>
                </button>
                {s.wins ? <p className="text-xs"><span className="text-muted-foreground">Wins: </span>{s.wins}</p> : null}
                {s.leftOff ? <p className="text-xs"><span className="text-muted-foreground">Left off: </span>{s.leftOff}</p> : null}
                {openSession === s.id ? (
                  <ol className="mt-2 grid gap-2 border-l border-border pl-3 text-xs">
                    {s.log.map((l) => <li key={l.step}><b>Step {l.step}.</b> {l.thought}{l.tools.map((t, i) => <span key={i} className="block text-muted-foreground">↳ {t.tool}{t.what ? ` (${t.what})` : ""}: {t.result.slice(0, 280)}{t.result.length > 280 ? "…" : ""}</span>)}</li>)}
                  </ol>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
