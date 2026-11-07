/*
 * The map engine: the whole system map with every part open, the memory rings in the middle row, pan/zoom/fit/search,
 * live lighting and replay. Ported from the single-view mock-up (Isaak's claude.ai artifact), now fed by the real
 * system map (GET /api/map), the real memory (GET /api/rings) and the real steps (server-sent events, run records).
 * No model calls are spent here: everything shown comes from what the code recorded.
 */
export type MapKind = "c" | "m" | "w" | "y" | "s";
export interface MapNode { t: string; k?: MapKind; s?: string; d?: string; kids?: Record<string, MapNode>; edges?: [string, string, string?][] }
export interface Entry { node: MapNode; path: string[]; x: number; y: number; w: number; h: number; group?: boolean; el?: SVGGElement }
export interface Rings {
  life: { id: string; title: string; chars: number } | null;
  themes: { id: string; title: string; size: number }[];
  pages: { id: string; title: string; kind: string; level: number; status: string; themes: string[] }[];
  bricks: { id: string; name: string; corner: string; themes: string[] }[];
  sources: { id: string; title: string; kind: string }[];
  links: { a: string; b: string }[];
}
export interface Lit { bricks?: string[]; pages?: string[]; sources?: string[]; life?: boolean }

const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(n: K, a: Record<string, string | number> = {}, p?: Element): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, n);
  for (const k in a) e.setAttribute(k, String(a[k]));
  if (p) p.appendChild(e);
  return e;
};
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
type Colors = Record<MapKind, [string, string]> & { ink: string; muted: string; line: string; ghost: string; panel: string; bg: string; energy: string };
const COL = (): Colors => ({
  c: [css("--code-soft"), css("--code")], m: [css("--mirror-soft"), css("--mirror")], w: [css("--link-soft"), css("--link")],
  y: [css("--energy-soft"), css("--energy")], s: [css("--soft"), css("--muted")], ink: css("--ink"), muted: css("--muted"),
  line: css("--line"), ghost: css("--ghost"), panel: css("--panel"), bg: css("--bg"), energy: css("--energy"),
});
export const KIND: Record<MapKind, string> = { c: "plain code", m: "a model call", w: "memory / stored", y: "you", s: "workshop" };
const W = 176, H = 56, PW = 140, PH = 30, PAD = 18, TITLE = 34;
interface Edge { a: string; b: string; l: string }
const norm = (c: MapNode): Edge[] => (c.edges ?? []).map(([a, b, l]) => ({ a, b: b.startsWith("@") ? `${b}.o` : b, l: l ?? "" }));
interface Layout { P: Record<string, { x: number; y: number; w: number; h: number }>; edges: Edge[]; tb: boolean; size: [number, number] }
const ROWS = [["sources", "intake", "web", "upkeep", "you"], ["queue", "run", "RINGS", "hands", "workshop"], ["review", "requests", "build"]];
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function wrap(t: string, max: number): string[] {
  const words = String(t).split(" ");
  const lines: string[] = [];
  let c = "";
  for (const x of words) { if ((`${c} ${x}`).trim().length > max) { if (c) lines.push(c); c = x; } else c = `${c} ${x}`.trim(); }
  if (c) lines.push(c);
  return lines.slice(0, 2);
}

export class MapView {
  sys: MapNode;
  rings: Rings | null = null;
  reg: Entry[] = [];
  selected: Entry | null = null;
  view = { x: 0, y: 0, w: 1000, h: 700 };
  world = { w: 0, h: 0 };
  onSelect: (e: Entry | null) => void = () => {};
  onRingSelect: (kind: string, id: string) => void = () => {};
  private cache = new Map<MapNode, Layout>();
  private ringEls: { bricks: Map<string, { el: SVGCircleElement; x: number; y: number }>; pages: Map<string, { el: SVGCircleElement; x: number; y: number }>; sources: Map<string, { el: SVGRectElement; x: number; y: number }>; life: SVGCircleElement | null; glow: SVGGElement | null } = { bricks: new Map(), pages: new Map(), sources: new Map(), life: null, glow: null };
  private camAnim = 0;
  private lastLit: string | null = null;
  private trail: string[] = [];

  constructor(public svg: SVGSVGElement, sys: MapNode) {
    this.sys = sys;
    this.bindPanZoom();
  }

  private layoutC(node: MapNode): Layout {
    const hit = this.cache.get(node);
    if (hit) return hit;
    const ids = Object.keys(node.kids ?? {});
    const edges = norm(node);
    const ports: Record<string, 1> = {};
    edges.forEach((e) => [e.a, e.b].forEach((x) => { if (x.startsWith("@")) ports[x] = 1; }));
    const nodes = [...ids, ...Object.keys(ports)];
    const sz: Record<string, [number, number]> = {};
    nodes.forEach((n) => { if (n.startsWith("@")) sz[n] = [PW, PH]; else { const k = node.kids![n]; sz[n] = k.kids ? this.layoutC(k).size : [W, H]; } });
    const out: Record<string, string[]> = {}, inn: Record<string, string[]> = {};
    nodes.forEach((n) => { out[n] = []; inn[n] = []; });
    edges.forEach((e) => { if (out[e.a] && inn[e.b]) { out[e.a].push(e.b); inn[e.b].push(e.a); } });
    const state: Record<string, number> = {}; const back = new Set<string>();
    const dfs = (n: string) => { state[n] = 1; out[n].forEach((m) => { if (state[m] === 1) back.add(`${n}→${m}`); else if (!state[m]) dfs(m); }); state[n] = 2; };
    nodes.filter((n) => !inn[n].length).forEach((n) => { if (!state[n]) dfs(n); });
    nodes.forEach((n) => { if (!state[n]) dfs(n); });
    const fwd = edges.filter((e) => !back.has(`${e.a}→${e.b}`) && out[e.a] && inn[e.b]);
    const rank: Record<string, number> = {};
    nodes.forEach((n) => { rank[n] = 0; });
    for (let i = 0; i < nodes.length; i += 1) { let ch = false; fwd.forEach((e) => { if (rank[e.b] < rank[e.a] + 1) { rank[e.b] = rank[e.a] + 1; ch = true; } }); if (!ch) break; }
    for (let it = 0; it < 3; it += 1) nodes.forEach((n) => { if (n.startsWith("@")) return; const i = fwd.filter((e) => e.b === n), o = fwd.filter((e) => e.a === n); if (!i.length && o.length) rank[n] = Math.max(rank[n], Math.min(...o.map((e) => rank[e.b])) - 1); });
    Object.keys(ports).forEach((p) => {
      const isIn = edges.some((e) => e.a === p), isOut = edges.some((e) => e.b === p);
      if (isIn && !isOut) rank[p] = Math.min(...edges.filter((e) => e.a === p).map((e) => rank[e.b])) - 1;
      else if (isOut && !isIn) rank[p] = Math.max(...edges.filter((e) => e.b === p).map((e) => rank[e.a])) + 1;
    });
    const minR = Math.min(...nodes.map((n) => rank[n]));
    nodes.forEach((n) => { rank[n] -= minR; });
    const R = Math.max(...nodes.map((n) => rank[n]));
    const cols: string[][] = [];
    for (let r = 0; r <= R; r += 1) cols.push(nodes.filter((n) => rank[n] === r));
    const P: Layout["P"] = {};
    let tb = false, cw = 0, ch = 0;
    if (edges.length === 0) {
      const per = Math.max(2, Math.ceil(Math.sqrt(ids.length * 1.4)));
      let y = 0;
      for (let i = 0; i < ids.length; i += per) {
        const row = ids.slice(i, i + per);
        const h = Math.max(...row.map((n) => sz[n][1]));
        let x = 0;
        row.forEach((n) => { P[n] = { x, y, w: sz[n][0], h: sz[n][1] }; x += sz[n][0] + 22; });
        cw = Math.max(cw, x - 22); y += h + 22;
      }
      ch = y - 22;
    } else {
      const pos: Record<string, number> = {};
      cols.forEach((c) => c.forEach((n, i) => { pos[n] = i; }));
      const bary = (n: string, adj: Record<string, string[]>) => (adj[n].length ? adj[n].reduce((s, m) => s + pos[m], 0) / adj[n].length : pos[n]);
      for (let s = 0; s < 6; s += 1) {
        cols.forEach((c, ci) => { if (!ci) return; c.sort((x, y) => bary(x, inn) - bary(y, inn)); c.forEach((n, i) => { pos[n] = i; }); });
        for (let ci = cols.length - 2; ci >= 0; ci -= 1) { cols[ci].sort((x, y) => bary(x, out) - bary(y, out)); cols[ci].forEach((n, i) => { pos[n] = i; }); }
      }
      const widestRow = Math.max(...cols.map((c) => c.reduce((s, n) => s + sz[n][0] + 26, -26)));
      const tallestCol = Math.max(...cols.map((c) => c.reduce((s, n) => s + sz[n][1] + 24, -24)));
      const lrW = cols.reduce((s, c) => s + Math.max(...c.map((n) => sz[n][0])) + 64, -64), lrH = tallestCol;
      const tbW = widestRow, tbH = cols.reduce((s, c) => s + Math.max(...c.map((n) => sz[n][1])) + 50, -50);
      const score = (w: number, h: number) => Math.max(w, h * 1.33) * Math.max(w / 1.33, h);
      tb = score(tbW, tbH) < score(lrW, lrH);
      if (tb) {
        let y = 0;
        cols.forEach((c) => { const rh = Math.max(...c.map((n) => sz[n][1])); const rw = c.reduce((s, n) => s + sz[n][0] + 26, -26); let x = (tbW - rw) / 2; c.forEach((n) => { P[n] = { x, y: y + (rh - sz[n][1]) / 2, w: sz[n][0], h: sz[n][1] }; x += sz[n][0] + 26; }); y += rh + 50; });
        cw = tbW; ch = tbH;
      } else {
        let x = 0;
        cols.forEach((c) => { const cwid = Math.max(...c.map((n) => sz[n][0])); const colh = c.reduce((s, n) => s + sz[n][1] + 24, -24); let y = (lrH - colh) / 2; c.forEach((n) => { P[n] = { x: x + (cwid - sz[n][0]) / 2, y, w: sz[n][0], h: sz[n][1] }; y += sz[n][1] + 24; }); x += cwid + 64; });
        cw = lrW; ch = lrH;
      }
    }
    const res: Layout = { P, edges, tb, size: [cw + PAD * 2 + (tb ? 50 : 0), ch + PAD + TITLE + (tb ? 0 : 30)] };
    this.cache.set(node, res);
    return res;
  }

  private drawBox(g: Element, node: MapNode, x: number, y: number, w: number, h: number, C: Colors, entry: Entry): void {
    const [f, s] = C[node.k ?? "c"];
    const grp = el("g", { class: "nd", tabindex: 0, role: "button", "aria-label": node.t, "data-path": entry.path.join("/") }, g);
    el("rect", { x, y, width: w, height: h, rx: 9, fill: f, stroke: s, "stroke-width": 1.5 }, grp);
    const tl = wrap(node.t, 22), sl = node.s ? wrap(node.s, 27).slice(0, 1) : [];
    const tot = tl.length * 15 + (sl.length ? 13 : 0);
    let ty = y + h / 2 - tot / 2 + 12;
    tl.forEach((l) => { el("text", { x: x + w / 2, y: ty, "text-anchor": "middle", "font-size": 13.5, "font-weight": 600, fill: C.ink }, grp).textContent = l; ty += 15; });
    sl.forEach((l) => { el("text", { x: x + w / 2, y: ty + 1, "text-anchor": "middle", "font-size": 11, fill: C.muted }, grp).textContent = l; });
    entry.el = grp;
    grp.addEventListener("click", (ev) => { ev.stopPropagation(); this.select(entry); });
    grp.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") { ev.preventDefault(); this.select(entry); } });
  }

  private drawGroup(g: Element, node: MapNode, x: number, y: number, path: string[], C: Colors, depth: number): Entry {
    const L = this.layoutC(node);
    const [gw, gh] = L.size;
    const [f, s] = C[node.k ?? "c"];
    const entry: Entry = { node, path, x, y, w: gw, h: gh, group: true };
    this.reg.push(entry);
    const frame = el("g", { class: "nd", tabindex: 0, role: "button", "aria-label": `${node.t}, open`, "data-path": path.join("/") }, g);
    el("rect", { x, y, width: gw, height: gh, rx: 14, fill: f, "fill-opacity": depth === 1 ? 0.35 : 0.55, stroke: s, "stroke-width": depth === 1 ? 2.5 : 1.6 }, frame);
    const tt = el("text", { x: x + PAD, y: y + 23, "font-size": depth === 1 ? 20 : 15, "font-weight": 700, "font-family": css("--f-display"), fill: C.ink }, frame);
    tt.textContent = node.t;
    let tw = node.t.length * (depth === 1 ? 11.5 : 8.5);
    try { tw = tt.getComputedTextLength() || tw; } catch { /* not laid out yet */ }
    if (node.s) el("text", { x: x + PAD + tw + 12, y: y + 23, "font-size": 12, fill: C.muted }, frame).textContent = node.s;
    entry.el = frame;
    frame.addEventListener("click", (ev) => { ev.stopPropagation(); this.select(entry); });
    const ox = x + PAD, oy = y + TITLE;
    const inner = el("g", {}, g);
    const eg = el("g", {}, inner);
    const labels: [number, number, string][] = [];
    L.edges.forEach((e) => {
      const A = L.P[e.a], B = L.P[e.b];
      if (!A || !B) return;
      let d: string, lx: number, ly: number;
      const ax = ox + A.x, ay = oy + A.y, bx = ox + B.x, by = oy + B.y;
      if (L.tb) {
        if (A.y < B.y) { const x1 = ax + A.w / 2, y1 = ay + A.h, x2 = bx + B.w / 2, y2 = by, my = (y1 + y2) / 2; d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`; lx = (x1 + x2) / 2; ly = my + 4; }
        else { const x1 = ax + A.w, y1 = ay + A.h / 2, x2 = bx + B.w, y2 = by + B.h / 2, o = Math.max(x1, x2) + 36; d = `M${x1},${y1} C${o},${y1} ${o},${y2} ${x2 + 2},${y2}`; lx = o - 4; ly = (y1 + y2) / 2; }
      } else if (A.x < B.x) { const x1 = ax + A.w, y1 = ay + A.h / 2, x2 = bx, y2 = by + B.h / 2, mx = (x1 + x2) / 2; d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`; lx = mx; ly = (y1 + y2) / 2 - 6; }
      else { const x1 = ax + A.w / 2, y1 = ay + A.h, x2 = bx + B.w / 2, y2 = by + B.h, dp = Math.max(y1, y2) + 30; d = `M${x1},${y1} C${x1},${dp} ${x2},${dp} ${x2},${y2 + 2}`; lx = (x1 + x2) / 2; ly = dp - 6; }
      const port = e.a.startsWith("@") || e.b.startsWith("@");
      const p = el("path", { d, fill: "none", stroke: C.muted, "stroke-width": 1.3, "stroke-opacity": 0.9, "marker-end": "url(#ah)", "stroke-dasharray": port ? "5 4" : "" }, eg);
      p.dataset.a = `${path.join("/")}/${e.a}`;
      p.dataset.b = `${path.join("/")}/${e.b.replace(/\.o$/, "")}`;
      if (e.l) labels.push([lx, ly, e.l]);
    });
    for (const n of Object.keys(L.P)) {
      const p = L.P[n];
      const X = ox + p.x, Y = oy + p.y;
      if (n.startsWith("@")) {
        const top = this.sys.kids?.[n.slice(1).split(".")[0]];
        if (!top) continue;
        const pg = el("g", { class: "nd port", tabindex: 0, role: "button", "aria-label": `Go to ${top.t}` }, inner);
        el("rect", { x: X, y: Y, width: p.w, height: p.h, rx: p.h / 2, fill: C.panel, stroke: C.ghost, "stroke-width": 1.4, "stroke-dasharray": "5 4" }, pg);
        el("text", { x: X + p.w / 2, y: Y + p.h / 2 + 4.5, "text-anchor": "middle", "font-size": 12.5, "font-weight": 600, fill: C.muted }, pg).textContent = `${n.endsWith(".o") ? "→ " : "← "}${top.t}`;
        const id = n.slice(1).split(".")[0];
        pg.addEventListener("click", (ev) => { ev.stopPropagation(); const target = this.reg.find((r) => r.path.length === 1 && r.path[0] === id); if (target) { this.select(target); this.zoomTo(target); } });
        continue;
      }
      const k = node.kids![n];
      if (k.kids) this.drawGroup(inner, k, X, Y, [...path, n], C, depth + 1);
      else { const entry2: Entry = { node: k, path: [...path, n], x: X, y: Y, w: p.w, h: p.h }; this.reg.push(entry2); this.drawBox(inner, k, X, Y, p.w, p.h, C, entry2); }
    }
    const lg = el("g", { "pointer-events": "none" }, inner);
    labels.forEach(([lx, ly, t]) => { const w = t.length * 6 + 8; el("rect", { x: lx - w / 2, y: ly - 11, width: w, height: 15, rx: 4, fill: C.panel, "fill-opacity": 0.9 }, lg); el("text", { x: lx, y: ly, "text-anchor": "middle", "font-size": 11, fill: C.muted }, lg).textContent = t; });
    return entry;
  }

  draw(): void {
    const svg = this.svg;
    svg.innerHTML = "";
    this.reg = [];
    this.cache.clear();
    const C = COL();
    const defs = el("defs", {}, svg);
    const m = el("marker", { id: "ah", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", fill: C.muted }, m);
    const m2 = el("marker", { id: "ahb", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", fill: C.ink }, m2);
    const f = el("filter", { id: "glow", x: "-30%", y: "-30%", width: "160%", height: "160%" }, defs);
    el("feGaussianBlur", { stdDeviation: 6, result: "b" }, f);
    const mg = el("feMerge", {}, f);
    el("feMergeNode", { in: "b" }, mg);
    el("feMergeNode", { in: "SourceGraphic" }, mg);
    const world = el("g", { id: "world" }, svg);
    const big = el("g", {}, world);
    const groups = el("g", {}, world);
    const GAPX = 170, GAPY = 170;
    let y = 40;
    const F: Record<string, { x: number; y: number; w: number; h: number }> = {};
    let maxW = 0;
    const top = this.sys.kids ?? {};
    ROWS.forEach((row) => {
      const sizes = row.map((id) => (id === "RINGS" ? [860, 880] : this.layoutC(top[id]).size));
      const rh = Math.max(...sizes.map((s) => s[1]));
      let x = 40;
      row.forEach((id, i) => { const [w, h] = sizes[i]; F[id] = { x, y: y + (rh - h) / 2, w, h }; x += w + GAPX; });
      maxW = Math.max(maxW, x - GAPX + 40);
      y += rh + GAPY;
    });
    this.world = { w: maxW, h: y - GAPY + 40 };
    ROWS.flat().forEach((id) => { const fr = F[id]; if (id === "RINGS") this.drawRings(groups, fr, C); else this.drawGroup(groups, top[id], fr.x, fr.y, [id], C, 1); });
    const labels: [number, number, string][] = [];
    (this.sys.edges ?? []).forEach(([a, b, l], i) => {
      const A = F[a], B = F[b];
      if (!A || !B) return;
      const acx = A.x + A.w / 2, acy = A.y + A.h / 2, bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
      let d: string, lx: number, ly: number;
      const sameRow = Math.abs(acy - bcy) < Math.max(A.h, B.h) / 2;
      const off = ((i % 3) - 1) * 18;
      if (sameRow) {
        if (acx < bcx) {
          const x1 = A.x + A.w, y1 = acy + off, x2 = B.x, y2 = bcy + off;
          if (B.x - (A.x + A.w) < GAPX + 10) { d = `M${x1},${y1} L${x2 - 2},${y2}`; lx = (x1 + x2) / 2; ly = y1 - 8; }
          else { const tp = Math.min(A.y, B.y) - 50 - Math.abs(off); d = `M${acx},${A.y} C${acx},${tp} ${bcx},${tp} ${bcx},${B.y - 2}`; lx = (acx + bcx) / 2; ly = tp + 20; }
        } else { const tp = Math.min(A.y, B.y) - 60 - Math.abs(off) * 2; d = `M${acx + off},${A.y} C${acx + off},${tp} ${bcx + off},${tp} ${bcx + off},${B.y - 2}`; lx = (acx + bcx) / 2; ly = tp + 20; }
      } else if (acy < bcy) { const x1 = acx + off, y1 = A.y + A.h, x2 = bcx + off, y2 = B.y, my = (y1 + y2) / 2; d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`; lx = (x1 + x2) / 2; ly = my; }
      else { const x1 = acx + off, y1 = A.y, x2 = bcx + off, y2 = B.y + B.h, my = (y1 + y2) / 2; d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 + 2}`; lx = (x1 + x2) / 2; ly = my; }
      const p = el("path", { d, fill: "none", stroke: C.ink, "stroke-opacity": 0.55, "stroke-width": 5, "marker-end": "url(#ahb)" }, big);
      p.dataset.a = a; p.dataset.b = b;
      if (l) labels.push([lx, ly, l]);
    });
    const lg = el("g", { "pointer-events": "none" }, world);
    labels.forEach(([x, yy, t]) => { const w = t.length * 9 + 14; el("rect", { x: x - w / 2, y: yy - 15, width: w, height: 22, rx: 6, fill: C.panel, stroke: C.line }, lg); el("text", { x, y: yy + 1, "text-anchor": "middle", "font-size": 15, "font-weight": 600, fill: C.ink }, lg).textContent = t; });
    el("g", { id: "travel", "pointer-events": "none" }, world);
    if (this.selected) { const again = this.reg.find((r) => r.path.join("/") === this.selected!.path.join("/")); this.selected = again ?? null; this.highlight(); }
  }

  // ---------- the memory rings, from the real web ----------
  private drawRings(g: Element, f: { x: number; y: number; w: number; h: number }, C: Colors): void {
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2 + 20;
    const R = { life: 72, s3: [88, 165], s2: [165, 245], br: [255, 335], fi: [345, 395] } as const;
    const rad = (d: number) => ((d - 90) * Math.PI) / 180;
    const pt = (r: number, d: number): [number, number] => [cx + r * Math.cos(rad(d)), cy + r * Math.sin(rad(d))];
    const arc = (r0: number, r1: number) => `M${cx},${cy - r1} A${r1},${r1} 0 1 1 ${cx - 0.01},${cy - r1} L${cx - 0.01},${cy - r0} A${r0},${r0} 0 1 0 ${cx},${cy - r0} Z`;
    const fr = el("g", { class: "rings" }, g);
    el("rect", { x: f.x, y: f.y, width: f.w, height: f.h, rx: 14, fill: C.w[0], "fill-opacity": 0.25, stroke: C.w[1], "stroke-width": 2.5, "stroke-dasharray": "8 5" }, fr);
    el("text", { x: f.x + 18, y: f.y + 28, "font-size": 20, "font-weight": 700, "font-family": css("--f-display"), fill: C.ink }, fr).textContent = "Your memory, as rings";
    const data = this.rings;
    el("text", { x: f.x + 18, y: f.y + 48, "font-size": 12, fill: C.muted }, fr).textContent = data
      ? `${data.sources.length} sources · ${data.bricks.length} bricks · ${data.pages.length} pages${data.life ? " · the life document" : " · no life document yet"}`
      : "loading the web…";
    ([[R.fi, C.s[0]], [R.br, C.panel], [R.s2, C.w[0]], [R.s3, C.w[0]]] as const).forEach(([[a, b], fill]) => el("path", { d: arc(a, b), fill, stroke: C.line, "fill-rule": "evenodd" }, fr));
    const life = el("circle", { cx, cy, r: R.life, fill: C.y[0], stroke: C.y[1], "stroke-width": 2, class: "ring-item" }, fr);
    el("text", { x: cx, y: cy - 2, "text-anchor": "middle", "font-size": 16, "font-weight": 700, fill: C.ink, "pointer-events": "none" }, fr).textContent = "Your life";
    el("text", { x: cx, y: cy + 16, "text-anchor": "middle", "font-size": 11, fill: C.muted, "pointer-events": "none" }, fr).textContent = data?.life ? `${Math.round(data.life.chars / 100) / 10}k characters` : "not written yet";
    if (data?.life) { const id = data.life.id; life.addEventListener("click", (ev) => { ev.stopPropagation(); this.onRingSelect("page", id); }); }
    this.ringEls = { bricks: new Map(), pages: new Map(), sources: new Map(), life, glow: null };
    if (!data) return;
    // slices: themes by size, then "its own work", then "not in a page yet"
    const slices: { id: string; title: string; size: number }[] = [...data.themes];
    const ownCount = data.bricks.filter((b) => b.corner === "own").length + data.pages.filter((p) => p.themes.includes("own")).length;
    const loose = data.bricks.filter((b) => b.corner !== "own" && !b.themes.length).length;
    if (ownCount) slices.push({ id: "own", title: "Its own work", size: Math.max(2, ownCount) });
    if (loose) slices.push({ id: "", title: "Not in a page yet", size: Math.max(2, loose) });
    const total = slices.reduce((s, x) => s + Math.max(1, x.size), 0) || 1;
    const range = new Map<string, [number, number]>();
    let a0 = 0;
    for (const sl of slices) {
      const span = (360 * Math.max(1, sl.size)) / total;
      range.set(sl.id, [a0, a0 + span]);
      const [x0, y0] = pt(R.life + 2, a0), [x1, y1] = pt(R.br[1], a0);
      if (slices.length > 1) el("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: C.ghost, "stroke-dasharray": "3 4" }, fr);
      const [tx, ty] = pt(R.s3[0] + 18, a0 + span / 2);
      el("text", { x: tx, y: ty, "text-anchor": "middle", "font-size": 12.5, "font-weight": 600, fill: C.w[1], "pointer-events": "none" }, fr).textContent = sl.title.length > 22 ? `${sl.title.slice(0, 21)}…` : sl.title;
      a0 += span;
    }
    const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 10000) / 10000; };
    const angleFor = (themes: string[], id: string, own: boolean) => {
      const key = own ? "own" : themes[0] ?? "";
      const [s0, s1] = range.get(key) ?? range.get("") ?? [0, 360];
      if (themes.length > 1 && range.has(themes[1])) { const [t0] = range.get(themes[1])!; return t0 + (hash(id) - 0.5) * 6; } // on the border between two themes
      return s0 + 4 + hash(id) * Math.max(1, s1 - s0 - 8);
    };
    const linkG = el("g", {}, fr);
    for (const b of data.bricks) {
      const ang = angleFor(b.themes, b.id, b.corner === "own");
      const r = R.br[0] + 8 + hash(`${b.id}r`) * (R.br[1] - R.br[0] - 16);
      const [x, y] = pt(r, ang);
      const c = el("circle", { cx: x, cy: y, r: 4, fill: C.ink, "fill-opacity": 0.6, class: "ring-item" }, fr);
      const title = el("title", {}, c); title.textContent = b.name;
      c.addEventListener("click", (ev) => { ev.stopPropagation(); this.onRingSelect("brick", b.id); });
      this.ringEls.bricks.set(b.id, { el: c, x, y });
    }
    for (const l of data.links.slice(0, 600)) {
      const p = this.ringEls.bricks.get(l.a), q = this.ringEls.bricks.get(l.b);
      if (p && q) el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: C.w[1], "stroke-opacity": 0.22 }, linkG);
    }
    for (const p of data.pages) {
      const ang = angleFor(p.themes, p.id, p.themes.includes("own"));
      const r = p.level >= 2 ? R.s3[1] - 14 : (R.s2[0] + R.s2[1]) / 2 + (hash(p.id) - 0.5) * 40;
      const [x, y] = pt(r, ang);
      const c = el("circle", { cx: x, cy: y, r: p.level >= 2 ? 8 : 6, fill: C.panel, stroke: p.status === "stale" ? C.energy : C.w[1], "stroke-width": 2, class: "ring-item" }, fr);
      const title = el("title", {}, c); title.textContent = `${p.title}${p.status === "stale" ? " (stale)" : ""}`;
      if (data.pages.length <= 24) el("text", { x, y: y - 12, "text-anchor": "middle", "font-size": 11, fill: C.ink, "pointer-events": "none" }, fr).textContent = p.title.length > 26 ? `${p.title.slice(0, 25)}…` : p.title;
      c.addEventListener("click", (ev) => { ev.stopPropagation(); this.onRingSelect("page", p.id); });
      this.ringEls.pages.set(p.id, { el: c, x, y });
    }
    const n = data.sources.length;
    data.sources.forEach((s, i) => {
      const ang = (360 * (i + 0.5)) / Math.max(1, n);
      const [x, y] = pt((R.fi[0] + R.fi[1]) / 2, ang);
      const r = el("rect", { x: x - 6, y: y - 9, width: 12, height: 18, rx: 2, fill: C.panel, stroke: s.kind === "own" ? C.m[1] : s.kind === "web" ? C.w[1] : C.muted, "stroke-width": 1.3, class: "ring-item" }, fr);
      const title = el("title", {}, r); title.textContent = `${s.title} (${s.kind})`;
      r.addEventListener("click", (ev) => { ev.stopPropagation(); this.onRingSelect("source", s.id); });
      if (n <= 16) { const [lx, ly] = pt(R.fi[1] + 10, ang); el("text", { x: lx, y: ly + 4, "font-size": 11, fill: C.muted, "text-anchor": ang > 180 ? "end" : "start", "pointer-events": "none" }, fr).textContent = s.title.length > 24 ? `${s.title.slice(0, 23)}…` : s.title; }
      this.ringEls.sources.set(s.id, { el: r, x, y });
    });
    this.ringEls.glow = el("g", { "pointer-events": "none" }, fr);
  }

  /** Light what a step touched in the memory: a pack's contents, what filing touched, what upkeep rewrote. */
  ringsLight(lit: Lit | null): void {
    const C = COL();
    const { bricks, pages, sources, life, glow } = this.ringEls;
    if (glow) glow.innerHTML = "";
    bricks.forEach((b) => { b.el.setAttribute("fill", C.ink); b.el.setAttribute("fill-opacity", "0.6"); b.el.setAttribute("r", "4"); });
    pages.forEach((p) => p.el.setAttribute("fill", C.panel));
    sources.forEach((s) => s.el.setAttribute("fill", C.panel));
    life?.setAttribute("stroke-width", "2");
    if (!lit) return;
    const amber = C.y[1];
    const litB = (lit.bricks ?? []).map((id) => bricks.get(id)).filter(Boolean) as { el: SVGCircleElement; x: number; y: number }[];
    for (const id of lit.sources ?? []) {
      const s = sources.get(id);
      if (!s) continue;
      s.el.setAttribute("fill", amber);
      if (glow) for (const b of litB.slice(0, 30)) el("line", { x1: s.x, y1: s.y, x2: b.x, y2: b.y, stroke: amber, "stroke-width": 1.4, "stroke-opacity": 0.8 }, glow);
    }
    for (const id of lit.pages ?? []) { const p = pages.get(id); if (!p) continue; p.el.setAttribute("fill", amber); if (glow) el("circle", { cx: p.x, cy: p.y, r: 15, fill: "none", stroke: amber, "stroke-width": 3 }, glow); }
    for (const b of litB) { b.el.setAttribute("fill", amber); b.el.setAttribute("fill-opacity", "1"); b.el.setAttribute("r", "6"); }
    if (lit.life) life?.setAttribute("stroke-width", "6");
  }

  // ---------- lighting the system map ----------
  entry(path: string): Entry | undefined { return this.reg.find((r) => r.path.join("/") === path); }

  clearLights(): void { this.svg.querySelectorAll(".lit,.trail,.litframe").forEach((x) => x.classList.remove("lit", "trail", "litframe")); }

  /** Make one box glow, keep a trail of where it has just been, outline its parent frames, and send a light along the arrow. */
  light(path: string, opts: { follow?: boolean; travel?: boolean } = {}): void {
    const e = this.entry(path);
    if (this.lastLit && this.lastLit !== path) { this.trail = [this.lastLit, ...this.trail.filter((t) => t !== this.lastLit)].slice(0, 6); }
    this.clearLights();
    for (const t of this.trail) this.entry(t)?.el?.classList.add("trail");
    if (e?.el) {
      e.el.classList.add("lit");
      const parts = path.split("/");
      for (let k = 1; k < parts.length; k += 1) { const pe = this.entry(parts.slice(0, k).join("/")); if (pe?.el && pe !== e) pe.el.classList.add("litframe"); }
      if (opts.travel !== false && this.lastLit && this.lastLit !== path) this.travel(this.lastLit, path);
      if (opts.follow) this.cam(e);
    }
    this.lastLit = path;
  }

  /** A small light travels along the arrow between two consecutive steps (off under reduced motion). */
  private travel(from: string, to: string): void {
    if (reduced()) return;
    const layer = this.svg.querySelector("#travel");
    if (!layer) return;
    const C = COL();
    const edge = [...this.svg.querySelectorAll<SVGPathElement>("path[data-a]")].find((p) => p.dataset.a === from && p.dataset.b === to)
      ?? [...this.svg.querySelectorAll<SVGPathElement>("path[data-a]")].find((p) => p.dataset.a === from.split("/")[0] && p.dataset.b === to.split("/")[0] && from.split("/")[0] !== to.split("/")[0]);
    const A = this.entry(from), B = this.entry(to);
    if (!A || !B) return;
    const dot = el("circle", { r: 7, fill: C.energy, filter: "url(#glow)" }, layer);
    const t0 = performance.now();
    const D = 650;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / D);
      let x: number, y: number;
      if (edge) { const len = edge.getTotalLength(); const p = edge.getPointAtLength(len * k); x = p.x; y = p.y; }
      else { x = A.x + A.w / 2 + (B.x + B.w / 2 - (A.x + A.w / 2)) * k; y = A.y + A.h / 2 + (B.y + B.h / 2 - (A.y + A.h / 2)) * k; }
      dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(y));
      if (k < 1) requestAnimationFrame(step); else dot.remove();
    };
    requestAnimationFrame(step);
  }

  setFocus(on: boolean): void { this.svg.classList.toggle("focus", on); }

  // ---------- pan, zoom, camera ----------
  apply(): void { this.svg.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`); }
  fit(): void {
    const r = this.svg.getBoundingClientRect();
    const ar = r.width / Math.max(1, r.height);
    let w = this.world.w, h = this.world.h;
    if (w / h > ar) h = w / ar; else w = h * ar;
    this.view = { x: (this.world.w - w) / 2, y: (this.world.h - h) / 2, w, h };
    this.apply();
  }
  zoom(f: number, cx?: number, cy?: number): void {
    const r = this.svg.getBoundingClientRect();
    if (cx === undefined || cy === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    const px = this.view.x + ((cx - r.left) / r.width) * this.view.w, py = this.view.y + ((cy - r.top) / r.height) * this.view.h;
    const nw = Math.min(this.world.w * 3, Math.max(250, this.view.w * f));
    const k = nw / this.view.w;
    this.view = { x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k, w: this.view.w * k, h: this.view.h * k };
    this.apply();
  }
  zoomTo(e: Entry): void {
    const r = this.svg.getBoundingClientRect();
    const ar = r.width / Math.max(1, r.height);
    let w = Math.max(e.w * 1.6, 1300), h = w / ar;
    if (h < e.h * 1.4) { h = e.h * 1.4; w = h * ar; }
    this.view = { x: e.x + e.w / 2 - w / 2, y: e.y + e.h / 2 - h / 2, w, h };
    this.apply();
  }
  /** Glide to the part around a box. */
  cam(e: Entry): void {
    let target = e;
    const top = this.entry(e.path[0]);
    if (top && top.w < 2600 && top.h < 2000) target = top;
    const r = this.svg.getBoundingClientRect();
    const ar = r.width / Math.max(1, r.height);
    let w = Math.max(target.w * 1.25, 900), h = w / ar;
    if (h < target.h * 1.2) { h = target.h * 1.2; w = h * ar; }
    const to = { x: target.x + target.w / 2 - w / 2, y: target.y + target.h / 2 - h / 2, w, h };
    const from = { ...this.view };
    const t0 = performance.now();
    const D = reduced() ? 0 : 520;
    cancelAnimationFrame(this.camAnim);
    const stepf = (now: number) => {
      const k = D ? Math.min(1, (now - t0) / D) : 1;
      const s = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.view = { x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s, w: from.w + (to.w - from.w) * s, h: from.h + (to.h - from.h) * s };
      this.apply();
      if (k < 1) this.camAnim = requestAnimationFrame(stepf);
    };
    this.camAnim = requestAnimationFrame(stepf);
  }
  private bindPanZoom(): void {
    const stage = this.svg.parentElement!;
    stage.addEventListener("wheel", (ev) => { ev.preventDefault(); this.zoom(ev.deltaY > 0 ? 1.15 : 1 / 1.15, ev.clientX, ev.clientY); }, { passive: false });
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    stage.addEventListener("pointerdown", (ev) => { if (ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false }; });
    stage.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const r = this.svg.getBoundingClientRect();
      const dx = ((ev.clientX - drag.x) / r.width) * this.view.w, dy = ((ev.clientY - drag.y) / r.height) * this.view.h;
      if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 4) { drag.moved = true; stage.classList.add("drag"); }
      if (drag.moved) { this.view.x = drag.vx - dx; this.view.y = drag.vy - dy; this.apply(); }
    });
    stage.addEventListener("pointerup", () => {
      if (drag?.moved) stage.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true });
      drag = null;
      stage.classList.remove("drag");
    });
    this.svg.addEventListener("click", () => { this.selected = null; this.highlight(); this.onSelect(null); });
  }

  search(q: string): Entry | null {
    const query = q.trim().toLowerCase();
    if (!query) return null;
    const hits = this.reg.filter((r) => `${r.node.t} ${r.node.s ?? ""} ${r.node.d ?? ""}`.toLowerCase().includes(query));
    const best = hits.find((r) => r.node.t.toLowerCase().includes(query)) ?? hits[0];
    if (best) { this.select(best); this.zoomTo(best); }
    return best ?? null;
  }

  highlight(): void {
    this.svg.querySelectorAll(".sel").forEach((x) => { x.classList.remove("sel"); const r = x.querySelector("rect"); if (r) r.setAttribute("stroke-width", r.dataset.sw ?? "1.5"); });
    if (!this.selected?.el) return;
    const r = this.selected.el.querySelector("rect")!;
    r.dataset.sw = r.getAttribute("stroke-width") ?? "1.5";
    r.setAttribute("stroke-width", "4.5");
    this.selected.el.classList.add("sel");
  }
  select(entry: Entry | null): void { this.selected = entry; this.highlight(); this.onSelect(entry); }

  /** What feeds a box and what it feeds, for the Selected box tab. */
  neighbours(entry: Entry): { ins: [string, string, string][]; outs: [string, string, string][] } {
    const top = this.sys.kids ?? {};
    if (entry.path.length === 1) {
      const id = entry.path[0];
      return {
        ins: (this.sys.edges ?? []).filter((e) => e[1] === id).map((e) => [top[e[0]].t, e[2] ?? "", e[0]]),
        outs: (this.sys.edges ?? []).filter((e) => e[0] === id).map((e) => [top[e[1]].t, e[2] ?? "", e[1]]),
      };
    }
    const cont = entry.path.slice(0, -1).reduce<MapNode>((n, x) => n.kids![x], this.sys);
    const id = entry.path[entry.path.length - 1];
    const es = norm(cont);
    const nm = (x: string) => (x.startsWith("@") ? `↗ ${top[x.slice(1).split(".")[0]]?.t ?? x}` : cont.kids![x]?.t ?? x);
    const pth = (x: string) => (x.startsWith("@") ? x.slice(1).split(".")[0] : [...entry.path.slice(0, -1), x].join("/"));
    return { ins: es.filter((e) => e.b === id).map((e) => [nm(e.a), e.l, pth(e.a)]), outs: es.filter((e) => e.a === id).map((e) => [nm(e.b), e.l, pth(e.b)]) };
  }
}
