import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { MapView, KIND, type Entry, type Lit, type MapNode, type Rings } from "./engine";
import { RichText, fmtMs, time } from "./text";
import { Workshop } from "./Workshop";
import { CalendarTab } from "./CalendarTab";

/**
 * The single view (BUILD_SPEC §6): the full system map with the memory rings in the middle, a side panel with
 * Chat | Workshop | Calendar | Selected box, and an activity strip with replay under the map. Live from the server's
 * events; every light comes from a step the code recorded.
 */
interface StepRow { node: string; kind: string; label: string; ms: number; ok: boolean; model?: string | null; lit?: Lit; at?: string; running?: boolean }
interface ChatRow { id: string; kind: "his" | "its" | "system"; content: string; runId: string | null; at: string }
interface RunRow { id: string; trigger: string; job: string; purpose: string; status: string; createdAt: string }
type Tab = "chat" | "workshop" | "calendar" | "info";
type Selected = { type: "map"; entry: Entry } | { type: "memory"; kind: string; id: string; data?: Record<string, unknown> } | null;

const WHO: Record<string, string> = { c: "code", m: "model", w: "memory", y: "you", s: "workshop" };

export function SingleView({ name, onLogout }: { name: string; onLogout: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const [sys, setSys] = useState<MapNode | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [chat, setChat] = useState<ChatRow[]>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [now, setNow] = useState<{ who: string; label: string; ms?: number } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [follow, setFollow] = useState(true);
  const [focus, setFocus] = useState(false);
  const [pace, setPace] = useState<"steady" | "real">("steady");
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [selected, setSelected] = useState<Selected>(null);
  const [mapOnPhone, setMapOnPhone] = useState(false);
  const [workshopTick, setWorkshopTick] = useState(0);
  const [knobs, setKnobs] = useState<{ replaySteadyMs: number; replayRealCapMs: number }>({ replaySteadyMs: 1600, replayRealCapMs: 6000 });
  const timer = useRef<number | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  const nodeOf = useCallback((path: string): MapNode | undefined => {
    let n: MapNode | undefined = sys ?? undefined;
    for (const id of path.split("/")) n = n?.kids?.[id];
    return n;
  }, [sys]);
  const who = useCallback((path: string) => WHO[nodeOf(path)?.k ?? "c"] ?? "code", [nodeOf]);

  // ---------- load ----------
  const loadRings = useCallback(async () => {
    const rings = await api<Rings>("/api/rings");
    if (viewRef.current) { viewRef.current.rings = rings; viewRef.current.draw(); }
  }, []);
  useEffect(() => {
    void api<MapNode>("/api/map").then(setSys);
    void api<ChatRow[]>("/api/chat").then(setChat);
    void api<RunRow[]>("/api/runs?limit=40").then(setRuns);
    void api<{ replaySteadyMs: number; replayRealCapMs: number }>("/api/knobs").then(setKnobs);
  }, []);
  useEffect(() => {
    if (!sys || !svgRef.current) return;
    const view = new MapView(svgRef.current, sys);
    viewRef.current = view;
    view.onSelect = (entry) => { if (entry) { setSelected({ type: "map", entry }); setTab("info"); } };
    view.onRingSelect = (kind, id) => void openMemory(kind, id);
    view.draw();
    view.fit();
    void loadRings();
    const redraw = () => view.draw();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", redraw);
    return () => mq.removeEventListener("change", redraw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sys]);

  const openMemory = useCallback(async (kind: string, id: string) => {
    setSelected({ type: "memory", kind, id });
    setTab("info");
    try { const data = await api<Record<string, unknown>>(`/api/node/${id}`); setSelected({ type: "memory", kind, id, data }); } catch { /* shown as missing */ }
  }, []);

  // ---------- live ----------
  useEffect(() => {
    const es = new EventSource("/api/events", { withCredentials: true });
    es.addEventListener("live", (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as Record<string, unknown> & { type: string };
      const view = viewRef.current;
      if (e.type === "step-start") {
        setRunId(String(e.runId));
        setPlaying(false);
        view?.light(String(e.node), { follow: followRef.current });
        setNow({ who: WHO[String(e.kind)] ?? "", label: `${String(e.label)} …` });
        setSteps((s) => (s.length && s[s.length - 1].running ? s : s).concat([{ node: String(e.node), kind: String(e.kind), label: String(e.label), ms: 0, ok: true, running: true }]));
      } else if (e.type === "step") {
        setRunId(String(e.runId));
        const row: StepRow = { node: String(e.node), kind: String(e.kind), label: String(e.label), ms: Number(e.ms), ok: Boolean(e.ok), model: (e.model as string) ?? null, lit: e.lit as Lit | undefined, at: String(e.at) };
        setSteps((s) => {
          const i = s.findIndex((x) => x.running && x.node === row.node);
          if (i >= 0) { const copy = s.slice(); copy[i] = row; return copy; }
          return s.concat([row]);
        });
        view?.light(row.node, { follow: followRef.current });
        if (row.lit) view?.ringsLight(row.lit);
        setNow({ who: "", label: row.label, ms: row.ms });
      } else if (e.type === "delta") {
        setStreaming((s) => ({ ...s, [String(e.runId)]: (s[String(e.runId)] ?? "") + String(e.text) }));
      } else if (e.type === "chat") {
        const row = { id: String(e.id), kind: e.kind as ChatRow["kind"], content: String(e.content), runId: (e.runId as string) ?? null, at: String(e.at) };
        setChat((c) => (c.some((x) => x.id === row.id) ? c : c.concat([row])));
        if (row.kind === "its" && row.runId) setStreaming((s) => { const copy = { ...s }; delete copy[row.runId!]; return copy; });
      } else if (e.type === "run") {
        if (e.status === "queued" && e.trigger === "you") setSteps([]);
        if (e.status === "running") { setRunId(String(e.runId)); setSteps([]); }
        if (e.status === "done" || e.status === "failed" || e.status === "paused") {
          void loadRings();
          void api<RunRow[]>("/api/runs?limit=40").then(setRuns);
          setWorkshopTick((t) => t + 1);
          if (e.status === "failed") setNow({ who: "code", label: `The run failed: ${String(e.purpose)}. Its record shows why.` });
        }
      } else if (e.type === "bench") {
        setWorkshopTick((t) => t + 1);
      } else if (e.type === "refs") {
        walk((e.refs as string[]) ?? []);
      }
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRings]);

  // ---------- explain: the view walks through what a reply pointed at ----------
  const walk = useCallback((paths: string[]) => {
    const view = viewRef.current;
    if (!view || !paths.length) return;
    stopTimer();
    setFocus(true);
    view.setFocus(true);
    let i = 0;
    const next = () => {
      if (i >= paths.length) { view.setFocus(false); setFocus(false); return; }
      const p = paths[i++];
      view.light(p, { follow: true });
      const n = view.entry(p);
      setNow({ who: "pointing", label: n?.node.t ?? p });
      timer.current = window.setTimeout(next, knobs.replaySteadyMs);
    };
    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knobs.replaySteadyMs]);
  const pointAt = useCallback((path: string) => {
    const view = viewRef.current;
    if (!view) return;
    stopTimer();
    view.light(path, { follow: true, travel: false });
    setNow({ who: "pointing", label: view.entry(path)?.node.t ?? path });
    if (window.matchMedia("(max-width: 900px)").matches) setMapOnPhone(true);
  }, []);

  // ---------- replay ----------
  function stopTimer() { if (timer.current) { clearTimeout(timer.current); timer.current = null; } setPlaying(false); }
  const show = useCallback((i: number, list: StepRow[]) => {
    const st = list[i];
    if (!st) return;
    setCursor(i);
    viewRef.current?.light(st.node, { follow: followRef.current });
    let lit: Lit | null = null;
    for (let k = i; k >= 0; k -= 1) if (list[k].lit) { lit = list[k].lit!; break; }
    viewRef.current?.ringsLight(lit);
    setNow({ who: who(st.node), label: st.label, ms: st.ms });
  }, [who]);
  const dwell = (ms: number) => (pace === "steady" ? knobs.replaySteadyMs : Math.max(700, Math.min(ms, knobs.replayRealCapMs)));
  const play = useCallback((list: StepRow[], from = 0) => {
    stopTimer();
    setPlaying(true);
    let i = from;
    const tickOnce = () => {
      show(i, list);
      if (i >= list.length - 1) { setPlaying(false); return; }
      const ms = list[i].ms;
      i += 1;
      timer.current = window.setTimeout(tickOnce, dwell(ms));
    };
    tickOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, pace, knobs]);
  const loadRun = useCallback(async (id: string, autoplay = true) => {
    const record = await api<{ steps: { node: string; kind: string; label: string; ms: number; ok: boolean; model: string | null; detail: { lit?: Lit }; at: string }[] }>(`/api/runs/${id}`);
    const list = record.steps.map((s) => ({ node: s.node, kind: s.kind, label: s.label, ms: s.ms, ok: s.ok, model: s.model, lit: s.detail?.lit, at: s.at }));
    setRunId(id);
    setSteps(list);
    setCursor(-1);
    if (autoplay && list.length) play(list, 0);
  }, [play]);

  // ---------- chat ----------
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "end" }); }, [chat, streaming, tab]);
  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!draft.trim() && !files.length) return;
    setSending(true);
    setError("");
    const form = new FormData();
    form.set("text", draft);
    form.set("clientMsgId", crypto.randomUUID());
    for (const f of files) form.append("files", f);
    try {
      const res = await api<{ streamId: string }>("/api/send", { method: "POST", body: form });
      setDraft("");
      setFiles([]);
      setSteps([]);
      setTimeout(() => setChat((c) => { if (!c.some((x) => x.id === res.streamId)) void api<ChatRow[]>("/api/chat").then(setChat); return c; }), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not sent.");
    } finally {
      setSending(false);
    }
  }

  // ---------- attention: how long the workshop is open ----------
  const tabOpened = useRef<{ tab: Tab; at: number }>({ tab: "chat", at: Date.now() });
  useEffect(() => {
    const prev = tabOpened.current;
    if (prev.tab === "workshop" && prev.tab !== tab) void api("/api/attention", { method: "POST", body: JSON.stringify({ what: "workshop:tab", ms: Math.min(3_600_000, Date.now() - prev.at) }) }).catch(() => undefined);
    tabOpened.current = { tab, at: Date.now() };
  }, [tab]);

  const currentRun = useMemo(() => runs.find((r) => r.id === runId), [runs, runId]);
  const stepButtons = steps.map((s, k) => (
    <button key={k} type="button" className={`${k < cursor ? "done" : k === cursor ? "cur" : ""}${s.ok ? "" : " bad"}`} title={`${s.label} (${fmtMs(s.ms)})`} onClick={() => { stopTimer(); show(k, steps); }}>{k + 1}</button>
  ));

  return (
    <div className={`app${mapOnPhone ? " phone-map" : ""}`}>
      <header>
        <h1>Hub of Me <small>{name}</small></h1>
        <div className="tools">
          <input type="search" placeholder="Find a box…" aria-label="Find a box by name" onKeyDown={(e) => { if (e.key === "Enter") viewRef.current?.search((e.target as HTMLInputElement).value); }} />
          <button type="button" aria-label="Zoom in" onClick={() => viewRef.current?.zoom(1 / 1.4)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => viewRef.current?.zoom(1.4)}>−</button>
          <button type="button" onClick={() => viewRef.current?.fit()}>Fit all</button>
          <button type="button" aria-pressed={follow} onClick={() => setFollow(!follow)}>Follow activity</button>
          <button type="button" aria-pressed={focus} onClick={() => { setFocus(!focus); viewRef.current?.setFocus(!focus); }}>Focus</button>
          <button type="button" className="phone-only" onClick={() => setMapOnPhone(!mapOnPhone)}>{mapOnPhone ? "Back to chat" : "Show the map"}</button>
          <button type="button" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); onLogout(); }}>Sign out</button>
        </div>
      </header>
      <div className="stage" id="stage"><svg ref={svgRef} id="map" role="img" aria-label="The whole system, every part open, lighting up as it works" /></div>
      <div className="strip" aria-label="Activity and replay">
        <div className="now">
          {now ? <><span className="who">{now.who || (runId ? who(steps[steps.length - 1]?.node ?? "") : "")}</span>{now.label}{now.ms != null ? <span className="dur">{fmtMs(now.ms)}</span> : null}</> : <><span className="who">idle</span>Nothing running. Send a message, or replay a past run.</>}
        </div>
        <div className="steps">{stepButtons}</div>
        <div className="ctl">
          <select aria-label="Replay a past run" value={runId ?? ""} onChange={(e) => e.target.value && void loadRun(e.target.value)}>
            <option value="">Replay a run…</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{time(r.createdAt)} · {r.job} · {r.status} · {r.purpose.slice(0, 60)}</option>)}
          </select>
          <button type="button" onClick={() => { if (playing) stopTimer(); else if (steps.length) play(steps, cursor >= steps.length - 1 ? 0 : Math.max(0, cursor)); }}>{playing ? "Pause" : "Replay"}</button>
          <button type="button" onClick={() => { stopTimer(); if (cursor > 0) show(cursor - 1, steps); }}>◀ Step</button>
          <button type="button" onClick={() => { stopTimer(); if (cursor < steps.length - 1) show(cursor + 1, steps); }}>Step ▶</button>
          <span>Pace:</span>
          <button type="button" aria-pressed={pace === "steady"} onClick={() => setPace("steady")}>Steady ({fmtMs(knobs.replaySteadyMs)} each)</button>
          <button type="button" aria-pressed={pace === "real"} onClick={() => setPace("real")}>Real time (capped at {fmtMs(knobs.replayRealCapMs)})</button>
          {runId ? <a className="btn" href={`/api/runs/${runId}/export`} download>Export this run</a> : null}
          {currentRun ? <span className="note">{currentRun.trigger} · {currentRun.status}</span> : null}
        </div>
      </div>
      <aside className="side">
        <div className="tabs" role="tablist">
          {(["chat", "workshop", "calendar", "info"] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-pressed={tab === t} onClick={() => setTab(t)}>{t === "chat" ? "Chat" : t === "workshop" ? "Workshop" : t === "calendar" ? "Calendar" : "Selected box"}</button>
          ))}
        </div>
        <div className="panes">
          {tab === "chat" ? (
            <div className="pane on">
              {chat.map((m) => (
                <div key={m.id} className={`msg ${m.kind === "his" ? "me" : m.kind === "its" ? "it" : "sys"}`}>
                  <RichText text={m.content} onMap={pointAt} onMemory={openMemory} />
                  {m.kind === "its" && m.runId ? <button type="button" className="replay-link" onClick={() => void loadRun(m.runId!)}>how I got here</button> : null}
                </div>
              ))}
              {Object.entries(streaming).map(([rid, text]) => <div key={rid} className="msg it streaming"><RichText text={text} onMap={pointAt} onMemory={openMemory} /></div>)}
              {!chat.length ? <p className="note">Nothing yet. Say anything, or drop in files: everything is kept whole.</p> : null}
              <div ref={chatEnd} />
            </div>
          ) : null}
          {tab === "workshop" ? <div className="pane on"><Workshop tick={workshopTick} onMemory={openMemory} onMap={pointAt} /></div> : null}
          {tab === "calendar" ? <div className="pane on"><CalendarTab /></div> : null}
          {tab === "info" ? <div className="pane on"><SelectedBox selected={selected} view={viewRef.current} onAsk={(q) => { setDraft(q); setTab("chat"); }} onMap={(p) => { const e = viewRef.current?.entry(p); if (e) { viewRef.current?.select(e); viewRef.current?.cam(e); } }} onMemory={openMemory} /></div> : null}
        </div>
        {tab === "chat" ? (
          <form className="compose" onSubmit={submit}>
            {files.length ? <div className="files">{files.map((f, i) => <span key={i} className="chip">📎 {f.name} <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}>×</button></span>)}</div> : null}
            {error ? <p className="err">{error}</p> : null}
            <div className="row">
              <label className="attach" title="Attach files">📎<input type="file" multiple onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} /></label>
              <textarea value={draft} placeholder="Message Hub of Me…" aria-label="Message" rows={2} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(e as unknown as React.FormEvent); } }} />
              <button className="send" type="submit" disabled={sending}>{sending ? "…" : "Send"}</button>
            </div>
          </form>
        ) : null}
      </aside>
    </div>
  );
}

function SelectedBox({ selected, view, onAsk, onMap, onMemory }: { selected: Selected; view: MapView | null; onAsk: (q: string) => void; onMap: (p: string) => void; onMemory: (k: string, id: string) => void }) {
  const [revision, setRevision] = useState("");
  const [sent, setSent] = useState("");
  if (!selected) return <p className="note">Click any box in the map to see what it does, what feeds it and what it feeds. Click a dot in the rings to open that brick, page or source.</p>;
  if (selected.type === "map") {
    const n = selected.entry.node;
    const { ins, outs } = view?.neighbours(selected.entry) ?? { ins: [], outs: [] };
    const chip = ([t, l, p]: [string, string, string]) => <button type="button" key={`${p}${t}`} className="chipb" onClick={() => onMap(p)}>{t}{l ? <span className="muted"> · {l}</span> : null}</button>;
    return (
      <div className="detail">
        <span className={`kind k-${n.k ?? "c"}`}>{KIND[n.k ?? "c"]}</span>
        <div className="path">{selected.entry.path.join(" › ")}</div>
        <h3>{n.t}</h3>
        {n.s ? <p className="muted">{n.s}</p> : null}
        <p>{n.d}</p>
        {n.kids ? <><p className="note">Inside</p><div className="chiprow">{Object.entries(n.kids).map(([k, v]) => <button type="button" key={k} className="chipb" onClick={() => onMap([...selected.entry.path, k].join("/"))}>{v.t}</button>)}</div></> : null}
        {ins.length ? <><p className="note">Comes from</p><div className="chiprow">{ins.map(chip)}</div></> : null}
        {outs.length ? <><p className="note">Goes to</p><div className="chiprow">{outs.map(chip)}</div></> : null}
        <button type="button" className="primary" onClick={() => onAsk(`How does "${n.t}" work?`)}>Ask it how this works</button>
      </div>
    );
  }
  const d = selected.data as Record<string, any> | undefined;
  if (!d) return <p className="note">Opening…</p>;
  const target = d.kind === "page" ? d.page : d.kind === "brick" ? d.brick : d.source;
  async function revise() {
    if (!revision.trim() || selected?.type !== "memory") return;
    await api("/api/revise", { method: "POST", body: JSON.stringify({ targetKind: d!.kind === "source" ? "brick" : d!.kind, targetId: selected.id, text: revision }) });
    setSent("Sent: it will apply it, or push back once with evidence; then your word stands.");
    setRevision("");
  }
  return (
    <div className="detail">
      <span className="kind k-w">{d.kind}{d.kind === "page" ? ` · ${target.kind} · v${target.version} · ${target.status}` : d.kind === "brick" ? ` · ${target.corner === "own" ? "its own corner" : "your life"}` : ` · ${target.kind}`}</span>
      <h3>{target.title ?? target.name}</h3>
      {d.kind === "page" ? <><p className="muted">Purpose: {target.purpose}</p><div className="body"><RichText text={target.body} onMap={onMap} onMemory={onMemory} /></div>
        <details><summary>Versions ({d.versions.length})</summary>{d.versions.map((v: any) => <p key={v.version} className="note">v{v.version} · {time(v.at)} · {v.claimChanged ? "a claim changed" : "no claim changed"}: {v.changeNote}</p>)}</details></> : null}
      {d.kind === "brick" ? <><p className="muted">{target.kind}{target.summary ? ` · ${target.summary}` : ""}</p>
        <ul className="entries">{d.entries.map((e: any) => <li key={e.id} className={e.status === "superseded" ? "superseded" : ""}><b>{e.kind}</b>{e.origin !== "his" ? <i> ({e.origin === "own" ? "its own" : "web"})</i> : null}: {e.text}{e.quote ? <q>{e.quote}</q> : null}{e.sourceId ? <button type="button" className="cite" onClick={() => onMemory("source", e.sourceId)}>source</button> : null}</li>)}</ul>
        {d.links.length ? <><p className="note">Links</p><ul className="entries">{d.links.map((l: any) => <li key={l.id}><b>{l.relation}</b> <button type="button" className="cite" onClick={() => onMemory("brick", l.a === target.id ? l.b : l.a)}>open</button> {l.reason}</li>)}</ul></> : null}</> : null}
      {d.kind === "source" ? <><p className="muted">{target.storedSize} of {target.origSize} characters kept{target.origSize > target.storedSize ? " (cut off)" : ""}</p><pre className="body">{target.body.slice(0, 20000)}</pre></> : null}
      {d.kind !== "source" ? <div className="revise"><textarea rows={3} placeholder="What would you change, and why?" value={revision} onChange={(e) => setRevision(e.target.value)} /><button type="button" className="primary" onClick={() => void revise()}>Revise</button>{sent ? <p className="note">{sent}</p> : null}</div> : null}
    </div>
  );
}
