import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The web, drawn. Three things are always shown, without switches (MIND_DESIGN.md):
 * - age: the colour of a brick, red for the first bricks of its life, blue for the newest;
 * - warmth: how recently it was used, as brightness and a soft glow that fades over hours;
 * - energy: only for the current thought (his last message, or the step a work session is on): a wave that starts at
 *   what his words named and runs out along the links, weaker with every step, replaying until the next thought.
 */

export interface MapBrick { id: string; name: string; kind: string; origin: string; warmth: number; createdAt: string; moments: string[] }
export interface MapLink { id: string; a: string; b: string; type: string; strength: number; reason: string }
export interface MapActivation { cause: string; energies: Record<string, number>; used: string[]; at: string }

type P = { x: number; y: number };
const FONT = 11;
const radius = (b: MapBrick) => (b.kind === "self" ? 9 : b.kind === "source" ? 6 : 4.5 + Math.min(5, Math.sqrt(Math.max(1, b.moments.length)) * 1.8));
const MAXCH = 24;
const labelWidth = (name: string) => Math.min(name.length, MAXCH) * FONT * 0.56 + 6;
const shortName = (name: string) => (name.length > MAXCH ? `${name.slice(0, MAXCH - 1)}…` : name);

/**
 * A seeded force layout, then label boxes pushed apart until nothing overlaps. Positions are kept between loads, so the
 * map only settles new bricks in instead of jumping.
 */
function layout(bricks: MapBrick[], links: MapLink[], prev: Map<string, P>): Map<string, P> {
  const n = bricks.length;
  const S = Math.max(500, Math.sqrt(n) * 90);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const index = new Map(bricks.map((b, i) => [b.id, i]));
  const xs = new Float64Array(n), ys = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  bricks.forEach((b, i) => {
    const p = prev.get(b.id);
    // A new brick starts next to something it is linked to, so it settles in near its neighbours.
    const near = p ? null : links.find((l) => (l.a === b.id && prev.has(l.b)) || (l.b === b.id && prev.has(l.a)));
    const anchor = near ? prev.get(near.a === b.id ? near.b : near.a)! : null;
    xs[i] = p?.x ?? (anchor ? anchor.x + (rand() - 0.5) * 60 : (rand() - 0.5) * S);
    ys[i] = p?.y ?? (anchor ? anchor.y + (rand() - 0.5) * 60 : (rand() - 0.5) * S);
  });
  const springs = links.flatMap((l) => {
    const a = index.get(l.a), b = index.get(l.b);
    if (a == null || b == null || a === b) return [];
    const source = l.type === "source";
    return [{ a, b, len: source ? 220 : 80, k: source ? 0.0015 : 0.01 * Math.min(Math.max(l.strength, 0.5), 4) }];
  });
  // Each brick is a box (dot plus its name to the right). Boxes push each other apart in the last part of the layout,
  // while the pull to the middle keeps the map compact; a final pass removes whatever overlap is left.
  const boxW = bricks.map((b) => radius(b) * 2 + 4 + labelWidth(b.name));
  const boxH = bricks.map((b) => Math.max(radius(b) * 2, FONT + 4) + 6);
  const left = bricks.map((b) => radius(b) + 2);
  const collide = (strength: number) => {
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const ax = xs[i] - left[i] + boxW[i] / 2, bx = xs[j] - left[j] + boxW[j] / 2;
        const ox = (boxW[i] + boxW[j]) / 2 - Math.abs(ax - bx);
        const oy = (boxH[i] + boxH[j]) / 2 - Math.abs(ys[i] - ys[j]);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (oy < ox * 0.45) { const s = (ys[i] < ys[j] ? -1 : 1) * (oy / 2 + 0.5) * strength; ys[i] += s; ys[j] -= s; }
        else { const s = (ax < bx ? -1 : 1) * (ox / 2 + 0.5) * strength; xs[i] += s; xs[j] -= s; }
      }
    }
    return moved;
  };
  const settled = prev.size > 0 && bricks.every((b) => prev.has(b.id));
  const iterations = settled ? 0 : prev.size ? 160 : 320;
  for (let it = 0; it < iterations; it += 1) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = xs[i] - xs[j], dy = ys[i] - ys[j];
        const d2 = Math.max(dx * dx + dy * dy, 30);
        if (d2 > 90_000) continue;
        const d = Math.sqrt(d2);
        const f = 1100 / d2;
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
      vx[i] -= xs[i] * 0.006; vy[i] -= ys[i] * 0.014;
      xs[i] += Math.max(-25, Math.min(25, vx[i])) * cool; ys[i] += Math.max(-25, Math.min(25, vy[i])) * cool;
      vx[i] *= 0.55; vy[i] *= 0.55;
    }
    if (it > iterations * 0.55) collide(0.5);
  }
  for (let pass = 0; pass < 300; pass += 1) if (!collide(1)) break;
  return new Map(bricks.map((b, i) => [b.id, { x: xs[i], y: ys[i] }]));
}

/**
 * Red for the oldest bricks, blue for the newest. By order of arrival, not by clock time: on the first day everything
 * comes in within minutes, and the order is still worth seeing.
 */
function ageHues(bricks: MapBrick[]): Map<string, number> {
  const sorted = [...bricks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = Math.max(1, sorted.length - 1);
  return new Map(sorted.map((b, i) => [b.id, Math.round(6 + (i / last) * 214)]));
}

const linkStroke: Record<string, string> = { together: "hsl(40 8% 55%)", source: "hsl(40 8% 45%)", about: "hsl(214 50% 65%)", meaning: "hsl(150 40% 55%)", used: "hsl(42 80% 58%)", insight: "hsl(270 60% 72%)" };
const WAVE = 1.8; // seconds for the energy to run from what he named to the faintest brick it reached
const CYCLE = 4.2; // the wave replays every CYCLE seconds until the next thought

export function MindMap(props: { bricks: MapBrick[]; links: MapLink[]; activation: MapActivation | null; bornAt: string | null; now: string; selected: string | null; onSelect: (id: string | null) => void }) {
  const { bricks, links, activation, selected, onSelect } = props;
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [view, setView] = useState({ x: 400, y: 280, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const positions = useRef(new Map<string, P>());
  const fitted = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; node: string | null; down: { x: number; y: number }; start: { x: number; y: number }; pinch?: { d: number; k: number; cx: number; cy: number; vx: number; vy: number } } | null>(null);

  const key = `${bricks.map((b) => b.id).join(",")}|${links.length}`;
  const pos = useMemo(() => {
    const next = layout(bricks, links, positions.current);
    positions.current = next;
    return next;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

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
      x0 = Math.min(x0, p.x - 12); x1 = Math.max(x1, p.x + labelWidth(b.name) + 16); y0 = Math.min(y0, p.y - 14); y1 = Math.max(y1, p.y + 14);
    }
    const k = Math.min(2, Math.max(0.15, Math.min(size.w / (x1 - x0), size.h / (y1 - y0)) * 0.94));
    setView({ k, x: size.w / 2 - ((x0 + x1) / 2) * k, y: size.h / 2 - ((y0 + y1) / 2) * k });
  }
  useEffect(() => { if (!fitted.current && pos.size && size.w > 100) { fit(); fitted.current = true; } }, [pos, size.w]); // eslint-disable-line react-hooks/exhaustive-deps

  function zoomAt(mx: number, my: number, factor: number) {
    setView((v) => {
      const k = Math.min(6, Math.max(0.12, v.k * factor));
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
      const k = Math.min(6, Math.max(0.12, g.pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.d)));
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      setView({ k, x: cx - ((g.pinch.cx - g.pinch.vx) * k) / g.pinch.k, y: cy - ((g.pinch.cy - g.pinch.vy) * k) / g.pinch.k });
      return;
    }
    if (Math.hypot(p.x - g.down.x, p.y - g.down.y) > 4) g.moved = true;
    if (g.moved) setView((v) => ({ ...v, x: p.x + g.start.x, y: p.y + g.start.y }));
  }
  function onUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0) {
      if (g && !g.moved) onSelect(g.node && g.node !== selected ? g.node : null);
      gesture.current = null;
    }
  }

  const hues = useMemo(() => ageHues(bricks), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const energies = activation?.energies ?? {};
  const used = new Set(activation?.used ?? []);
  const focus = hover ?? selected;
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!focus) return set;
    set.add(focus);
    for (const l of links) { if (l.a === focus) set.add(l.b); if (l.b === focus) set.add(l.a); }
    return set;
  }, [focus, links]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of links) if (l.type !== "source") { d.set(l.a, (d.get(l.a) ?? 0) + 1); d.set(l.b, (d.get(l.b) ?? 0) + 1); }
    return d;
  }, [links]);
  // Names are drawn at map scale, so they never overlap; when zoomed far out only the ones that matter now stay readable.
  const readable = FONT * view.k >= 7;
  const keyBricks = useMemo(() => new Set([...bricks].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, 10).map((b) => b.id)), [bricks, degree]);
  const delay = (e: number) => `${((1 - Math.min(1, e)) * WAVE).toFixed(2)}s`;

  return (
    <div ref={box} className="relative h-[64vh] min-h-[380px] w-full overflow-hidden rounded-lg bg-background">
      <svg ref={svg} width={size.w} height={size.h} className="block touch-none select-none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <defs>
          <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
        </defs>
        <style>{`
          @keyframes breathe { 0%,100% { opacity: var(--w); } 50% { opacity: calc(var(--w) * 0.6); } }
          .warmglow { animation: breathe 4s ease-in-out infinite; }
          @keyframes ring { 0% { transform: scale(0.6); opacity: 0; } 8% { opacity: var(--e); } 55% { transform: scale(var(--s)); opacity: 0; } 100% { transform: scale(var(--s)); opacity: 0; } }
          .ring { transform-box: fill-box; transform-origin: center; animation: ring ${CYCLE}s ease-out infinite; opacity: 0; }
          @keyframes flash { 0% { opacity: 0; } 8% { opacity: var(--e); } 45%,100% { opacity: 0; } }
          .flash { animation: flash ${CYCLE}s ease-out infinite; opacity: 0; }
          @keyframes flow { 0% { stroke-dashoffset: 40; opacity: 0; } 8% { opacity: var(--e); } 50% { stroke-dashoffset: 0; opacity: 0; } 100% { opacity: 0; } }
          .flow { animation: flow ${CYCLE}s linear infinite; opacity: 0; }
          @media (prefers-reduced-motion: reduce) { .warmglow, .ring, .flash, .flow { animation: none; } .ring, .flow { opacity: 0; } .flash { opacity: calc(var(--e) * 0.6); } }
        `}</style>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {links.map((l) => {
            const a = pos.get(l.a), b = pos.get(l.b);
            if (!a || !b) return null;
            const touches = focus ? l.a === focus || l.b === focus : false;
            // "Same source" links tie everything to its file; drawn only when you look at one end.
            if (l.type === "source" && !touches) return null;
            const dim = focus && !touches;
            return (
              <line key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={linkStroke[l.type] ?? "gray"} strokeOpacity={dim ? 0.08 : touches ? 0.9 : 0.32}
                strokeWidth={(0.6 + Math.min(l.strength, 6) * 0.45) / Math.sqrt(view.k)} strokeDasharray={l.type === "meaning" ? "4 3" : l.type === "insight" ? "8 3" : undefined} />
            );
          })}
          {/* Energy along the links: from the brighter end to the fainter one, fading as it goes. */}
          <g key={`flow-${activation?.at ?? ""}`}>
            {links.map((l) => {
              const ea = energies[l.a] ?? 0, eb = energies[l.b] ?? 0;
              if (!ea || !eb || l.type === "source") return null;
              const [from, to] = ea >= eb ? [pos.get(l.a), pos.get(l.b)] : [pos.get(l.b), pos.get(l.a)];
              if (!from || !to) return null;
              const e = Math.min(ea, eb);
              return <line key={l.id} className="flow" x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="hsl(45 100% 62%)" strokeWidth={1.5 + e * 3} strokeLinecap="round" strokeDasharray="14 26" style={{ ["--e" as string]: String(0.35 + e * 0.65), animationDelay: delay(Math.max(ea, eb)) }} />;
            })}
          </g>
          {bricks.map((b) => {
            const p = pos.get(b.id);
            if (!p) return null;
            const r = radius(b);
            const w = Math.min(1, Math.max(0, b.warmth));
            const hue = hues.get(b.id) ?? 220;
            const fill = `hsl(${hue} ${62 + w * 20}% ${40 + w * 22}%)`;
            const e = energies[b.id] ?? 0;
            const dim = focus && !neighbours.has(b.id);
            const showLabel = readable || b.id === focus || neighbours.has(b.id) || e > 0.15 || w > 0.3 || keyBricks.has(b.id);
            const stroke = b.id === selected ? "hsl(46 95% 65%)" : used.has(b.id) ? "hsl(45 100% 62%)" : b.kind === "self" ? "hsl(46 70% 70%)" : "hsl(40 15% 75%)";
            return (
              <g key={b.id} data-id={b.id} opacity={dim ? 0.25 : 1} className="cursor-pointer" onPointerEnter={() => setHover(b.id)} onPointerLeave={() => setHover((h) => (h === b.id ? null : h))}>
                <title>{b.name}</title>
                {w > 0.04 ? <circle className="warmglow" cx={p.x} cy={p.y} r={r + 3 + w * 6} fill="hsl(40 100% 62%)" filter="url(#glow)" style={{ ["--w" as string]: String(0.25 + w * 0.6) }} /> : null}
                {/* Shape is where it came from: his own material is round, the AI's own thoughts are diamonds, what it found on the web are triangles, files are squares. */}
                {b.kind === "source"
                  ? <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} rx={1.5} fill={fill} stroke={stroke} strokeWidth={b.id === selected ? 2 : 0.8} />
                  : b.kind !== "self" && b.origin === "own"
                    ? <polygon points={`${p.x},${p.y - r * 1.3} ${p.x + r * 1.3},${p.y} ${p.x},${p.y + r * 1.3} ${p.x - r * 1.3},${p.y}`} fill={fill} stroke={stroke} strokeWidth={b.id === selected || used.has(b.id) ? 2 : 0.8} />
                    : b.kind !== "self" && b.origin === "web"
                      ? <polygon points={`${p.x},${p.y - r * 1.3} ${p.x + r * 1.2},${p.y + r * 0.85} ${p.x - r * 1.2},${p.y + r * 0.85}`} fill={fill} stroke={stroke} strokeWidth={b.id === selected || used.has(b.id) ? 2 : 0.8} />
                      : <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke={stroke} strokeWidth={b.id === selected || used.has(b.id) ? 2 : b.kind === "self" ? 1.6 : 0.8} />}
                {b.kind === "self" ? <circle cx={p.x} cy={p.y} r={r + 3} fill="none" stroke="hsl(46 70% 70%)" strokeWidth={0.8} /> : null}
                {showLabel ? (
                  <text x={p.x + r + 4} y={p.y + FONT * 0.36} fontSize={FONT} fill="hsl(40 30% 92%)" fillOpacity={0.55 + w * 0.45} style={{ paintOrder: "stroke", stroke: "hsl(var(--background))", strokeWidth: 3 }}>
                    {shortName(b.name)}
                  </text>
                ) : null}
              </g>
            );
          })}
          {/* Energy on the bricks: a flash and a ring that grows with how much reached it, later the further it travelled. */}
          <g key={`wave-${activation?.at ?? ""}`} pointerEvents="none">
            {bricks.map((b) => {
              const e = energies[b.id] ?? 0;
              const p = pos.get(b.id);
              if (!e || !p) return null;
              const r = radius(b);
              const style = { ["--e" as string]: String(0.3 + Math.min(1, e) * 0.7), ["--s" as string]: String(1.6 + Math.min(1, e) * 2.4), animationDelay: delay(e) };
              return (
                <g key={b.id}>
                  <circle className="flash" cx={p.x} cy={p.y} r={r} fill="hsl(48 100% 70%)" style={style} />
                  <circle className="ring" cx={p.x} cy={p.y} r={r + 2} fill="none" stroke="hsl(45 100% 62%)" strokeWidth={2} style={style} />
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-border bg-card/90 text-sm">
        <button className="px-2.5 py-1 hover:bg-muted" aria-label="Zoom in" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.4)}>+</button>
        <button className="border-t border-border px-2.5 py-1 hover:bg-muted" aria-label="Zoom out" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.4)}>−</button>
        <button className="border-t border-border px-2 py-1 text-xs hover:bg-muted" onClick={fit}>Fit</button>
      </div>
    </div>
  );
}
