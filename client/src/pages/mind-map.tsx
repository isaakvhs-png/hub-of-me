import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The web, drawn. Three things are always shown, without switches (MIND_DESIGN.md):
 * - age: the colour of a brick, red for the first bricks of its life, blue for the newest (by order of arrival);
 * - warmth: how recently it was used, as a brighter fill and a soft halo that fades over hours;
 * - energy: only for the current thought (his last message, or the step a work session is on): a wave that starts at
 *   what was named and runs out along the links, fainter at every step, replaying until the next thought. Only the
 *   brightest bricks animate, so a big web stays calm and fast.
 * Shape is origin: round his, diamond its own thought, triangle the web, square a file.
 */

export interface MapBrick { id: string; name: string; kind: string; origin: string; warmth: number; createdAt: string; moments: string[] }
export interface MapLink { id: string; a: string; b: string; type: string; strength: number; reason: string }
export interface MapActivation { cause: string; energies: Record<string, number>; used: string[]; at: string }

type P = { x: number; y: number };
const FONT = 12;
const MAXCH = 26;
const radius = (b: MapBrick) => (b.kind === "self" ? 10 : b.kind === "source" ? 7 : 5.5 + Math.min(5, Math.sqrt(Math.max(1, b.moments.length)) * 1.8));
const labelWidth = (name: string) => Math.min(name.length, MAXCH) * FONT * 0.56 + 8;
const shortName = (name: string) => (name.length > MAXCH ? `${name.slice(0, MAXCH - 1)}…` : name);
const ENERGY_SHOWN = 0.12; // fainter than this is not drawn as energy
const ANIMATED_MAX = 25; // at most this many bricks carry the wave

const STORE = "hub.mind.positions.v2";
function loadStored(): Map<string, P> {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, P>)); } catch { return new Map(); }
}
function saveStored(pos: Map<string, P>) {
  try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(pos))); } catch { /* storage can be off; the layout is recomputed then */ }
}

/**
 * A seeded force layout, then label boxes pushed apart until nothing overlaps. Positions are kept (in this browser), so
 * the map only settles new bricks in instead of jumping. "Same source" links pull very weakly: they would tie every
 * brick of a file into one knot.
 */
function layout(bricks: MapBrick[], links: MapLink[], prev: Map<string, P>): Map<string, P> {
  const n = bricks.length;
  const S = Math.max(600, Math.sqrt(n) * 130);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const index = new Map(bricks.map((b, i) => [b.id, i]));
  const xs = new Float64Array(n), ys = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  bricks.forEach((b, i) => {
    const p = prev.get(b.id);
    const near = p ? null : links.find((l) => l.type !== "source" && ((l.a === b.id && prev.has(l.b)) || (l.b === b.id && prev.has(l.a))));
    const anchor = near ? prev.get(near.a === b.id ? near.b : near.a)! : null;
    xs[i] = p?.x ?? (anchor ? anchor.x + (rand() - 0.5) * 80 : (rand() - 0.5) * S * 1.4);
    ys[i] = p?.y ?? (anchor ? anchor.y + (rand() - 0.5) * 80 : (rand() - 0.5) * S);
  });
  const springs = links.flatMap((l) => {
    const a = index.get(l.a), b = index.get(l.b);
    if (a == null || b == null || a === b) return [];
    const source = l.type === "source";
    return [{ a, b, len: source ? 260 : 110, k: source ? 0.0006 : 0.008 * Math.min(Math.max(l.strength, 0.5), 4) }];
  });
  const boxW = bricks.map((b) => radius(b) * 2 + 8 + labelWidth(b.name) + 14);
  const boxH = bricks.map((b) => Math.max(radius(b) * 2, FONT + 4) + 16);
  const left = bricks.map((b) => radius(b) + 7);
  const collide = (strength: number) => {
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const ax = xs[i] - left[i] + boxW[i] / 2, bx = xs[j] - left[j] + boxW[j] / 2;
        const ox = (boxW[i] + boxW[j]) / 2 - Math.abs(ax - bx);
        if (ox <= 0) continue;
        const oy = (boxH[i] + boxH[j]) / 2 - Math.abs(ys[i] - ys[j]);
        if (oy <= 0) continue;
        moved = true;
        if (oy < ox * 0.45) { const s = (ys[i] < ys[j] ? -1 : 1) * (oy / 2 + 0.5) * strength; ys[i] += s; ys[j] -= s; }
        else { const s = (ax < bx ? -1 : 1) * (ox / 2 + 0.5) * strength; xs[i] += s; xs[j] -= s; }
      }
    }
    return moved;
  };
  const settled = prev.size > 0 && bricks.every((b) => prev.has(b.id));
  const iterations = settled ? 0 : prev.size ? 140 : 300;
  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = xs[i] - xs[j], dy = ys[i] - ys[j];
        const d2 = Math.max(dx * dx + dy * dy, 30);
        if (d2 > 160_000) continue;
        const d = Math.sqrt(d2);
        const f = 2400 / d2;
        dx /= d; dy /= d;
        vx[i] += dx * f; vy[i] += dy * f; vx[j] -= dx * f; vy[j] -= dy * f;
      }
    }
    for (const s of springs) {
      const dx = xs[s.b] - xs[s.a], dy = ys[s.b] - ys[s.a];
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - s.len) * s.k;
      vx[s.a] += (dx / d) * f; vy[s.a] += (dy / d) * f; vx[s.b] -= (dx / d) * f; vy[s.b] -= (dy / d) * f;
    }
    for (let i = 0; i < n; i += 1) {
      // Pulled in more from top and bottom than from the sides: the map is wider than it is tall.
      vx[i] -= xs[i] * 0.0012; vy[i] -= ys[i] * 0.014;
      xs[i] += Math.max(-25, Math.min(25, vx[i])) * cool; ys[i] += Math.max(-25, Math.min(25, vy[i])) * cool;
      vx[i] *= 0.55; vy[i] *= 0.55;
    }
    if (it > iterations * 0.6) collide(0.5);
  }
  for (let pass = 0; pass < 300; pass += 1) if (!collide(1)) break;
  return new Map(bricks.map((b, i) => [b.id, { x: xs[i], y: ys[i] }]));
}

/** Red for the oldest bricks, blue for the newest, by order of arrival (on the first day everything comes in within minutes). */
function ageHues(bricks: MapBrick[]): Map<string, number> {
  const sorted = [...bricks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = Math.max(1, sorted.length - 1);
  return new Map(sorted.map((b, i) => [b.id, Math.round(4 + (i / last) * 216)]));
}

export const LINK_TYPES: { type: string; label: string; color: string; dash?: string }[] = [
  { type: "together", label: "came up together", color: "hsl(40 10% 62%)" },
  { type: "about", label: "part of / about", color: "hsl(210 75% 64%)" },
  { type: "meaning", label: "similar in meaning", color: "hsl(150 55% 55%)", dash: "5 4" },
  { type: "used", label: "used together", color: "hsl(42 90% 58%)" },
  { type: "insight", label: "insight (its reason)", color: "hsl(275 70% 72%)", dash: "9 4" },
  { type: "source", label: "same file (on hover)", color: "hsl(40 8% 45%)", dash: "2 4" },
];
const linkStyle = new Map(LINK_TYPES.map((t) => [t.type, t]));
const WAVE = 1.8; // seconds for the energy to run from what was named to the faintest brick it reached
const CYCLE = 4.2; // the wave replays every CYCLE seconds until the next thought

export function MindMap(props: { bricks: MapBrick[]; links: MapLink[]; activation: MapActivation | null; running: { phase: string; label: string } | null; selected: string | null; onSelect: (id: string | null) => void }) {
  const { bricks, links, activation, selected, onSelect } = props;
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 900, h: 640 });
  const [view, setView] = useState({ x: 450, y: 320, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<{ text: string; x: number; y: number } | null>(null);
  const positions = useRef<Map<string, P>>(loadStored());
  const fitted = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; node: string | null; down: { x: number; y: number }; start: { x: number; y: number }; pinch?: { d: number; k: number; cx: number; cy: number; vx: number; vy: number } } | null>(null);

  const key = `${bricks.map((b) => b.id).join(",")}|${links.length}`;
  const pos = useMemo(() => {
    const next = layout(bricks, links, positions.current);
    positions.current = next;
    saveStored(next);
    return next;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const hues = useMemo(() => ageHues(bricks), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = useMemo(() => new Map(bricks.map((b) => [b.id, b.name])), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  function fit() {
    if (!pos.size) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bricks) {
      const p = pos.get(b.id); if (!p) continue;
      x0 = Math.min(x0, p.x - 14); x1 = Math.max(x1, p.x + labelWidth(b.name) + 20); y0 = Math.min(y0, p.y - 16); y1 = Math.max(y1, p.y + 16);
    }
    const k = Math.min(2, Math.max(0.12, Math.min(size.w / (x1 - x0), size.h / (y1 - y0)) * 0.95));
    setView({ k, x: size.w / 2 - ((x0 + x1) / 2) * k, y: size.h / 2 - ((y0 + y1) / 2) * k });
  }
  useEffect(() => { if (!fitted.current && pos.size && size.w > 100) { fit(); fitted.current = true; } }, [pos, size.w]); // eslint-disable-line react-hooks/exhaustive-deps

  function zoomAt(mx: number, my: number, factor: number) {
    setView((v) => {
      const k = Math.min(6, Math.max(0.1, v.k * factor));
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  }
  // The wheel zooms the map, not the page (a passive React listener can't stop the page from scrolling too).
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function local(e: React.PointerEvent) { const r = svg.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onDown(e: React.PointerEvent) {
    svg.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    const node = (e.target as Element).closest("[data-id]")?.getAttribute("data-id") ?? null;
    if (pointers.current.size === 1) gesture.current = { moved: false, node, down: local(e), start: { x: view.x - local(e).x, y: view.y - local(e).y } };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { moved: true, node: null, down: a, start: { x: 0, y: 0 }, pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: view.x, vy: view.y } };
    }
  }
  function onMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g.pinch && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const k = Math.min(6, Math.max(0.1, g.pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.d)));
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      setView({ k, x: cx - ((g.pinch.cx - g.pinch.vx) * k) / g.pinch.k, y: cy - ((g.pinch.cy - g.pinch.vy) * k) / g.pinch.k });
      return;
    }
    if (Math.hypot(p.x - g.down.x, p.y - g.down.y) > 4) g.moved = true;
    if (g.moved) { setHoverLink(null); setView((v) => ({ ...v, x: p.x + g.start.x, y: p.y + g.start.y })); }
  }
  function onUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0) {
      if (g && !g.moved) onSelect(g.node && g.node !== selected ? g.node : null);
      gesture.current = null;
    }
  }

  // Energy: only what is bright enough, and only the brightest few animate.
  const energies = useMemo(() => {
    const all = Object.entries(activation?.energies ?? {}).filter(([id, e]) => e >= ENERGY_SHOWN && pos.has(id)).sort((a, b) => b[1] - a[1]).slice(0, ANIMATED_MAX);
    return new Map(all);
  }, [activation?.at, pos]); // eslint-disable-line react-hooks/exhaustive-deps
  const used = new Set(activation?.used ?? []);
  const warmCount = bricks.filter((b) => b.warmth > 0.04 && b.kind !== "self").length;
  const focus = hover ?? selected;
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!focus) return set;
    set.add(focus);
    for (const l of links) { if (l.a === focus) set.add(l.b); if (l.b === focus) set.add(l.a); }
    return set;
  }, [focus, links]);
  // Zoomed out, dots keep a visible size on screen; zoomed in, they grow with the map.
  const rWorld = (b: MapBrick) => (view.k < 1 ? (radius(b) * 0.85) / Math.max(view.k, 0.25) : radius(b));
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of links) if (l.type !== "source") { d.set(l.a, (d.get(l.a) ?? 0) + 1); d.set(l.b, (d.get(l.b) ?? 0) + 1); }
    return d;
  }, [links]);
  // Names are drawn at a fixed size on screen, like place names on a map: zoomed out, only the ones that matter most and
  // have room are shown (the brick you point at and its neighbours, what the thought lit, what is warm, the best-linked);
  // zoom in and more appear. They never overlap.
  const labelScale = 1 / view.k;
  const labelled = useMemo(() => {
    const score = (b: MapBrick) => (b.id === focus ? 1e6 : 0) + (neighbours.has(b.id) ? 1e5 : 0) + (energies.get(b.id) ?? 0) * 1e4 + b.warmth * 1e3 + (degree.get(b.id) ?? 0);
    const order = [...bricks].sort((a, b) => score(b) - score(a));
    // Every dot is an obstacle too, so a name never covers another brick.
    const dots = bricks.flatMap((b) => { const p = pos.get(b.id); if (!p) return []; const r = rWorld(b) * view.k + 1; const x = p.x * view.k + view.x, y = p.y * view.k + view.y; return [{ id: b.id, x0: x - r, y0: y - r, x1: x + r, y1: y + r }]; });
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const out = new Set<string>();
    for (const [rank, b] of order.entries()) {
      const p = pos.get(b.id); if (!p) continue;
      const sx = p.x * view.k + view.x + rWorld(b) * view.k + 5, sy = p.y * view.k + view.y;
      if (sx > size.w + 50 || sx < -250 || sy < -20 || sy > size.h + 20) continue;
      const box = { x0: sx - 2, y0: sy - FONT * 0.75, x1: sx + labelWidth(b.name), y1: sy + FONT * 0.65 };
      const hit = (q: { x0: number; y0: number; x1: number; y1: number }) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0;
      // What matters now (pointed at, lit, warm, or among the best-linked) only has to avoid other names; the rest also avoids dots.
      const important = score(b) >= 1000 || rank < 12;
      if (placed.some(hit) || (!important && dots.some((d) => d.id !== b.id && hit(d)))) continue;
      placed.push(box); out.add(b.id);
    }
    return out;
  }, [bricks, pos, view, size, focus, neighbours, energies, degree]); // eslint-disable-line react-hooks/exhaustive-deps
  const delay = (e: number) => `${((1 - Math.min(1, e)) * WAVE).toFixed(2)}s`;
  const stroke = (w: number) => w / Math.sqrt(view.k);

  const status = [
    `${bricks.length} bricks · ${links.filter((l) => l.type !== "source").length} links`,
    props.running ? `thinking now: ${props.running.phase}${props.running.label ? `, ${props.running.label}` : ""}` : null,
    activation ? (energies.size ? `last thought (${activation.cause}, ${new Date(activation.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}): ${energies.size} bricks lit` : `last thought (${activation.cause}) lit nothing it could name`) : "no thought yet",
    warmCount ? `${warmCount} warm` : "nothing warm yet (warmth comes from what it used)",
  ].filter(Boolean).join(" · ");

  return (
    <div>
      <p className="pb-2 text-xs text-muted-foreground">{status}</p>
      <div ref={box} className="relative h-[calc(100vh-230px)] min-h-[460px] w-full overflow-hidden rounded-lg bg-background">
        <svg ref={svg} width={size.w} height={size.h} className="block touch-none select-none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setHoverLink(null)}>
          <style>{`
            @keyframes breathe { 0%,100% { opacity: var(--w); } 50% { opacity: calc(var(--w) * 0.55); } }
            .warmhalo { animation: breathe 4s ease-in-out infinite; }
            @keyframes ring { 0% { transform: scale(0.6); opacity: 0; } 8% { opacity: var(--e); } 55% { transform: scale(var(--s)); opacity: 0; } 100% { transform: scale(var(--s)); opacity: 0; } }
            .ring { transform-box: fill-box; transform-origin: center; animation: ring ${CYCLE}s ease-out infinite; opacity: 0; }
            @keyframes flash { 0% { opacity: 0; } 8% { opacity: var(--e); } 45%,100% { opacity: 0; } }
            .flash { animation: flash ${CYCLE}s ease-out infinite; opacity: 0; }
            @keyframes flow { 0% { stroke-dashoffset: 40; opacity: 0; } 8% { opacity: var(--e); } 50% { stroke-dashoffset: 0; opacity: 0; } 100% { opacity: 0; } }
            .flow { animation: flow ${CYCLE}s linear infinite; opacity: 0; }
            @media (prefers-reduced-motion: reduce) { .warmhalo, .ring, .flash, .flow { animation: none; } .ring, .flow { opacity: 0; } .flash { opacity: calc(var(--e) * 0.6); } }
          `}</style>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {links.map((l) => {
              const a = pos.get(l.a), b = pos.get(l.b);
              if (!a || !b) return null;
              const touches = focus ? l.a === focus || l.b === focus : false;
              if (l.type === "source" && !touches) return null;
              const st = linkStyle.get(l.type) ?? LINK_TYPES[0];
              const dim = focus && !touches;
              const text = `${nameOf.get(l.a)} — ${nameOf.get(l.b)}\n${st.label}${l.reason ? `: ${l.reason}` : ""} · strength ${l.strength.toFixed(1)}`;
              return (
                <g key={l.id}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={st.color} strokeOpacity={dim ? 0.07 : touches ? 0.95 : 0.5} strokeWidth={stroke(touches ? 2.2 : 0.9 + Math.min(l.strength, 6) * 0.35)} strokeDasharray={st.dash} />
                  {/* A wide, invisible line makes a thin link easy to point at. */}
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={stroke(10)} onPointerEnter={(e) => { const r = svg.current!.getBoundingClientRect(); setHoverLink({ text, x: e.clientX - r.left, y: e.clientY - r.top }); }} onPointerLeave={() => setHoverLink(null)} />
                </g>
              );
            })}
            <g key={`flow-${activation?.at ?? ""}`} pointerEvents="none">
              {links.map((l) => {
                const ea = energies.get(l.a) ?? 0, eb = energies.get(l.b) ?? 0;
                if (!ea || !eb || l.type === "source") return null;
                const [from, to] = ea >= eb ? [pos.get(l.a), pos.get(l.b)] : [pos.get(l.b), pos.get(l.a)];
                if (!from || !to) return null;
                const e = Math.min(ea, eb);
                return <line key={l.id} className="flow" x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="hsl(45 100% 62%)" strokeWidth={stroke(1.5 + e * 3)} strokeLinecap="round" strokeDasharray="14 26" style={{ ["--e" as string]: String(0.35 + e * 0.65), animationDelay: delay(Math.max(ea, eb)) }} />;
              })}
            </g>
            {bricks.map((b) => {
              const p = pos.get(b.id);
              if (!p) return null;
              const r = rWorld(b);
              const w = Math.min(1, Math.max(0, b.warmth));
              const hue = hues.get(b.id) ?? 220;
              const fill = `hsl(${hue} ${68 + w * 20}% ${44 + w * 20}%)`;
              const e = energies.get(b.id) ?? 0;
              const dim = focus && !neighbours.has(b.id);
              const showLabel = labelled.has(b.id);
              const ring = b.id === selected ? "hsl(46 95% 65%)" : used.has(b.id) ? "hsl(45 100% 62%)" : w > 0.04 ? "hsl(42 100% 75%)" : "hsl(40 15% 80%)";
              const sw = b.id === selected || used.has(b.id) ? 2.2 : w > 0.04 ? 1.2 + w * 1.5 : 0.8;
              return (
                <g key={b.id} data-id={b.id} opacity={dim ? 0.22 : 1} className="cursor-pointer" onPointerEnter={() => setHover(b.id)} onPointerLeave={() => setHover((h) => (h === b.id ? null : h))}>
                  <title>{b.name}</title>
                  {w > 0.04 && b.kind !== "self" ? <circle className={w > 0.3 ? "warmhalo" : undefined} cx={p.x} cy={p.y} r={r + 4 + w * 7} fill="hsl(40 100% 62%)" style={{ ["--w" as string]: String(0.12 + w * 0.3), opacity: 0.12 + w * 0.3 }} /> : null}
                  {b.kind === "source"
                    ? <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={1.5} fill={fill} stroke={ring} strokeWidth={sw} />
                    : b.kind !== "self" && b.origin === "own"
                      ? <polygon points={`${p.x},${p.y - r * 1.3} ${p.x + r * 1.3},${p.y} ${p.x},${p.y + r * 1.3} ${p.x - r * 1.3},${p.y}`} fill={fill} stroke={ring} strokeWidth={sw} />
                      : b.kind !== "self" && b.origin === "web"
                        ? <polygon points={`${p.x},${p.y - r * 1.3} ${p.x + r * 1.2},${p.y + r * 0.85} ${p.x - r * 1.2},${p.y + r * 0.85}`} fill={fill} stroke={ring} strokeWidth={sw} />
                        : <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke={ring} strokeWidth={b.kind === "self" ? 1.8 : sw} />}
                  {b.kind === "self" ? <circle cx={p.x} cy={p.y} r={r + 3.5} fill="none" stroke="hsl(46 70% 70%)" strokeWidth={0.9} /> : null}
                  {showLabel ? (
                    <text x={p.x + r + 5 * labelScale} y={p.y + FONT * 0.36 * labelScale} fontSize={FONT * labelScale} fill="hsl(40 30% 94%)" fillOpacity={b.id === focus ? 1 : 0.72 + w * 0.28} style={{ paintOrder: "stroke", stroke: "hsl(var(--background))", strokeWidth: 3 * labelScale }}>
                      {shortName(b.name)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            <g key={`wave-${activation?.at ?? ""}`} pointerEvents="none">
              {[...energies.entries()].map(([id, e]) => {
                const b = bricks.find((x) => x.id === id);
                const p = pos.get(id);
                if (!b || !p) return null;
                const r = rWorld(b);
                const style = { ["--e" as string]: String(0.3 + Math.min(1, e) * 0.7), ["--s" as string]: String(1.6 + Math.min(1, e) * 2.4), animationDelay: delay(e) };
                return (
                  <g key={id}>
                    <circle className="flash" cx={p.x} cy={p.y} r={r} fill="hsl(48 100% 70%)" style={style} />
                    <circle className="ring" cx={p.x} cy={p.y} r={r + 2} fill="none" stroke="hsl(45 100% 62%)" strokeWidth={2} style={style} />
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
        {hoverLink ? (
          <div className="pointer-events-none absolute z-20 max-w-[320px] whitespace-pre-line rounded-md border border-border bg-card/95 px-2 py-1 text-xs shadow" style={{ left: Math.min(hoverLink.x + 12, size.w - 330), top: hoverLink.y + 12 }}>{hoverLink.text}</div>
        ) : null}
        <div className="absolute left-2 top-2 flex flex-col overflow-hidden rounded-md border border-border bg-card/90 text-sm">
          <button className="px-2.5 py-1 hover:bg-muted" aria-label="Zoom in" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.4)}>+</button>
          <button className="border-t border-border px-2.5 py-1 hover:bg-muted" aria-label="Zoom out" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.4)}>−</button>
          <button className="border-t border-border px-2 py-1 text-xs hover:bg-muted" onClick={fit}>Fit</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">age <span className="inline-block h-2 w-20 rounded-full" style={{ background: "linear-gradient(90deg, hsl(4 70% 50%), hsl(60 70% 50%), hsl(150 70% 45%), hsl(220 70% 55%))" }} /> first in → latest</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full" style={{ background: "hsl(40 100% 62%)", opacity: 0.5 }} /> warm: used recently</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5" style={{ background: "hsl(45 100% 62%)" }} /> gold wave: the current thought</span>
        <span>● you · ◆ its own · ▲ web · ■ file</span>
        {LINK_TYPES.map((t) => (
          <span key={t.type} className="flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={t.color} strokeWidth="2.5" strokeDasharray={t.dash} /></svg>{t.label}</span>
        ))}
      </div>
    </div>
  );
}
