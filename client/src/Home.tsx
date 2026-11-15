import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Mic, Spinner, useLiveData, useShell, when } from "./shared";
import { Body, Legend, type Ref } from "./Body";

// ---------------- the chat ----------------

interface ChatRow { id: string; role: string; text: string; meta: string; created_at: string }

export function Chat({ folded, onFold }: { folded: boolean; onFold: () => void }) {
  const { live, openSource, openProject } = useShell();
  const [rows] = useLiveData<ChatRow[]>(() => api("/chat"));
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [rows?.length, live?.chat.busy]);

  const submit = async () => {
    if (!text.trim() && !files.length) return;
    setSending(true); setError("");
    try {
      const form = new FormData();
      form.set("text", text);
      for (const f of files) form.append("files", f);
      await api("/chat", { form });
      setText(""); setFiles([]);
    } catch (e: any) { setError(e.message); } finally { setSending(false); }
  };

  if (folded) return <div className="chatpane folded"><button title="Open the chat" onClick={onFold} style={{ height: "100%" }}>»</button></div>;
  const busy = live?.chat.busy;
  return (
    <div className={`chatpane dropzone ${over ? "over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]); }}>
      <div className="win" style={{ border: "none", flex: 1 }}>
        <div className="bar"><span className="title">chat</span><button onClick={onFold} title="Fold the chat">«</button></div>
        <div className="chatlog" ref={logRef}>
          {!rows?.length && <div className="dim">Say anything, or drop a file here. Everything you say goes into its memory.</div>}
          {rows?.map((r) => {
            const meta = safe(r.meta);
            return (
              <div key={r.id} className={`msg ${r.role} ${meta.unprompted ? "unprompted" : ""}`}>
                <div className="who">{r.role === "isaak" ? "you" : meta.unprompted ? "it, on its own" : "it"} · {when(r.created_at)}</div>
                <div className="text">{r.text}</div>
                {meta.attachments?.map((a: any) => <div key={a.sourceId} className="att" style={{ cursor: "pointer" }} onClick={() => openSource(a.sourceId)}>📎 {a.name}{a.readable ? "" : " (can't read this yet)"}</div>)}
                {meta.projectId && <div className="att" style={{ cursor: "pointer" }} onClick={() => openProject(meta.projectId)}>▣ open the project</div>}
                {meta.rounds?.length > 1 && <div className="rounds">{meta.rounds.length} rounds{meta.stopped ? ` · stopped (${meta.stopped})` : ""}</div>}
              </div>
            );
          })}
          {busy && (
            <div className="msg it">
              <div className="who">it</div>
              <div className="row">
                {live!.chat.round <= 1
                  ? <button className="roundbtn" title="Answer now with what you have" onClick={() => api("/chat/stop", { method: "POST" })}><Spinner /></button>
                  : <button className="roundbtn" title="Click: answer now with what you have" onClick={() => api("/chat/stop", { method: "POST" })}>{live!.chat.round}</button>}
                <span className="dim">{live!.chat.stopAsked ? "answering with what it has…" : live!.chat.why}</span>
              </div>
            </div>
          )}
        </div>
        <div className="composer">
          {files.length > 0 && <div className="files">{files.map((f, i) => <span key={i}>📎 {f.name} <a href="#" onClick={(e) => { e.preventDefault(); setFiles(files.filter((_, j) => j !== i)); }}>×</a> </span>)}</div>}
          <textarea value={text} placeholder="Type, dictate, or drop files…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
          <div className="row">
            <Mic onText={(t) => setText((x) => (x ? `${x} ${t}` : t))} />
            <button onClick={() => fileRef.current?.click()}>attach</button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
            <span className="grow dim">{error && <span style={{ color: "var(--red)" }}>{error}</span>}</span>
            <button className="primary" disabled={sending} onClick={submit}>send ⏎</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const safe = (raw: string) => { try { return JSON.parse(raw || "{}"); } catch { return {}; } };

// ---------------- the tree ----------------

interface SummaryNode { id: string; title: string; kind: string; is_life: boolean; is_instructions: boolean; project_id: string | null; tags: string[]; stale: boolean; updated_at: string; inputs: { type: string; id: string }[] }
interface SourceNode { id: string; kind: string; origin: string; title: string; readable: boolean; placed: boolean; created_at: string }
interface WebView { lifeId: string; summaries: SummaryNode[]; sources: SourceNode[] }

const FIXED = ["sources", "projects", "outdated", "unreadable files"];

export function Tree() {
  const { live, openSummary, openSource } = useShell();
  const [web] = useLiveData<WebView>(() => api("/web"));
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<Set<string>>(() => new Set());
  const byId = useMemo(() => new Map((web?.summaries ?? []).map((s) => [s.id, s])), [web]);
  const srcById = useMemo(() => new Map((web?.sources ?? []).map((s) => [s.id, s])), [web]);
  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of web?.summaries ?? []) for (const t of s.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
  }, [web]);
  const showSources = filters.has("sources") || filters.has("unreadable files");
  const active = [...filters].filter((f) => f !== "sources");
  const matches = (s: SummaryNode) => active.every((f) =>
    f === "projects" ? s.kind === "project" : f === "outdated" ? s.stale : f === "unreadable files" ? true : s.tags.includes(f));
  const anyFilter = active.filter((f) => f !== "unreadable files").length > 0;

  // Paths to matches and to lit summaries open by themselves.
  const autoOpen = useMemo(() => {
    const want = new Set<string>();
    if (!web) return want;
    const parents = new Map<string, string[]>();
    for (const s of web.summaries) for (const i of s.inputs) if (i.type === "summary") (parents.get(i.id) ?? parents.set(i.id, []).get(i.id)!).push(s.id);
    const up = (id: string, seen = new Set<string>()) => { for (const p of parents.get(id) ?? []) if (!seen.has(p)) { seen.add(p); want.add(p); up(p, seen); } };
    for (const s of web.summaries) if ((anyFilter && matches(s)) || live?.lit[s.id]) up(s.id);
    return want;
  }, [web, filters, live?.lit]);

  if (!web) return <div className="tree dim">Loading…</div>;
  const toggle = (id: string) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); setOpen(n); };

  const renderNode = (id: string, path: string[]): React.ReactNode => {
    const s = byId.get(id);
    if (!s) return null;
    const kids = s.inputs.filter((i) => i.type === "summary" && byId.has(i.id) && !path.includes(i.id));
    const srcKids = showSources ? s.inputs.filter((i) => i.type === "source" && srcById.has(i.id) && (!filters.has("unreadable files") || !srcById.get(i.id)!.readable)) : [];
    const isOpen = open.has(id) || autoOpen.has(id);
    const dim = anyFilter && !matches(s);
    return (
      <div key={`${path.join(">")}>${id}`} className={`node ${dim ? "dimmed" : ""} ${live?.lit[id] ? "lit" : ""} ${s.stale ? "stale" : ""} ${s.kind === "project" ? "project" : ""}`}>
        <div className="line">
          <span className="tw" onClick={() => toggle(id)}>{kids.length + srcKids.length ? (isOpen ? "▾" : "▸") : "·"}</span>
          <span className="name" onClick={() => openSummary(id)}>{s.is_life ? "My life" : s.title}</span>
          <span className="meta">{s.kind === "project" ? "project" : ""}{s.is_instructions ? "your instructions" : ""}{kids.length ? ` ${kids.length}` : ""}</span>
        </div>
        {isOpen && (kids.length > 0 || srcKids.length > 0) && (
          <div className="kids">
            {kids.map((k) => renderNode(k.id, [...path, id]))}
            {srcKids.map((k) => { const src = srcById.get(k.id)!; return (
              <div key={`${id}>s:${k.id}`} className="node source">
                <div className="line" onClick={() => openSource(k.id)}>
                  <span className="tw">•</span>
                  <span className="name" style={{ color: `var(--${src.origin === "isaak" ? "white" : src.origin === "web" ? "cyan" : src.origin === "session" ? "green" : "amber"})` }}>{src.title || src.kind}</span>
                  <span className="meta">{src.kind}{src.readable ? "" : " · can't read yet"}</span>
                </div>
              </div>
            ); })}
          </div>
        )}
      </div>
    );
  };

  const unplaced = web.sources.filter((s) => !s.placed).length;
  return (
    <>
      <div className="filters">
        {[...FIXED, ...tags].map((f) => (
          <button key={f} className={`chip ${filters.has(f) ? "on" : ""}`} onClick={() => { const n = new Set(filters); if (n.has(f)) n.delete(f); else n.add(f); setFilters(n); }}>{f}</button>
        ))}
        <span className="grow" />
        <button className="chip" onClick={() => setOpen(new Set())}>fold all</button>
      </div>
      <div className="tree">
        {renderNode(web.lifeId, [])}
        {unplaced > 0 && <div className="dim" style={{ marginTop: 10 }}>{unplaced} new thing{unplaced === 1 ? "" : "s"} still being placed…</div>}
      </div>
    </>
  );
}

// ---------------- popups on top of the tree ----------------

export interface Float { key: string; type: "summary" | "source"; id: string; x: number; y: number }

export function Floats({ floats, close, front }: { floats: Float[]; close: (key: string) => void; front: (key: string) => void }) {
  return <>{floats.map((f, i) => f.type === "summary"
    ? <SummaryWin key={f.key} f={f} z={20 + i} close={() => close(f.key)} front={() => front(f.key)} />
    : <SourceWin key={f.key} f={f} z={20 + i} close={() => close(f.key)} front={() => front(f.key)} />)}</>;
}

function useDrag(initial: { x: number; y: number }) {
  const [pos, setPos] = useState(initial);
  const start = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    const sx = e.clientX - pos.x; const sy = e.clientY - pos.y;
    const move = (ev: MouseEvent) => setPos({ x: Math.max(0, ev.clientX - sx), y: Math.max(0, ev.clientY - sy) });
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  return { pos, start };
}

interface SummaryFull { id: string; title: string; body: string; kind: string; is_life: boolean; project_id: string | null; stale: boolean; tags: string[]; updated_at: string; refs: Record<string, Ref>; versions: { id: string; title: string; body: string; why: string; created_at: string }[]; inputs: { type: string; id: string }[]; feedsInto: { id: string; title: string }[] }

function SummaryWin({ f, z, close, front }: { f: Float; z: number; close: () => void; front: () => void }) {
  const { openSummary, openProject, openSource } = useShell();
  const { pos, start } = useDrag({ x: f.x, y: f.y });
  const [first, setFirst] = useState(true);
  const [s, reload, error] = useLiveData<SummaryFull>(() => api(`/summaries/${f.id}${first ? "" : "?touch=0"}`).finally(() => setFirst(false)), [f.id]);
  const [mode, setMode] = useState<"read" | "revise" | "edit" | "history">("read");
  const [words, setWords] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [oldVersion, setOldVersion] = useState<string | null>(null);
  const plainBody = (b: string) => b.replace(/\[\[(?:s|m|img):[^\]]+\]\]/g, "").replace(/\{\{\/?isaak\}\}/g, "").replace(/ +\n/g, "\n").trim();

  const doRevise = async () => {
    setBusy("revising…"); setNote("");
    try { const out = await api(`/summaries/${f.id}/revise`, { body: { words } }); setNote(out.say || `Done (${out.action}).`); setWords(""); setMode("read"); if (out.action === "absorb") close(); else reload(); }
    catch (e: any) { setNote(e.message); } finally { setBusy(""); }
  };
  const doEdit = async () => {
    setBusy("saving…");
    try { await api(`/summaries/${f.id}/edit`, { body: { body: draft } }); setMode("read"); reload(); } catch (e: any) { setNote(e.message); } finally { setBusy(""); }
  };
  const doAbsorb = async () => {
    if (!confirm("Absorb this summary into the rest of the web? Its inputs go to what it fed, and it disappears.")) return;
    try { await api(`/summaries/${f.id}/absorb`, { method: "POST" }); close(); } catch (e: any) { setNote(e.message); }
  };
  const pickUp = async () => { const out = await api(`/summaries/${f.id}/pickup`, { method: "POST" }); openProject(out.projectId); };

  return (
    <div className="win float" style={{ left: pos.x, top: pos.y, zIndex: z }} onMouseDown={front}>
      <div className="bar" onMouseDown={start}>
        <span className="title">{s ? (s.is_life ? "My life" : s.title) : "…"}{s?.stale ? " (outdated)" : ""}</span>
        <button onClick={close}>×</button>
      </div>
      <div className="body">
        {error && <div style={{ color: "var(--red)" }}>{error}</div>}
        {!s && !error && <div className="dim"><Spinner /> bringing it up to date…</div>}
        {s && (
          <>
            <div className="tabsmall">
              {(["read", "revise", "edit", "history"] as const).map((m) => <button key={m} className={mode === m ? "primary" : ""} onClick={() => { setMode(m); if (m === "edit") setDraft(plainBody(s.body)); }}>{m}</button>)}
              <span className="grow" />
              {s.kind === "project" && <button className="primary" onClick={pickUp}>pick this back up</button>}
              {!s.is_life && <button className="danger" onClick={doAbsorb}>absorb</button>}
            </div>
            {busy && <div className="dim"><Spinner /> {busy}</div>}
            {note && <div style={{ color: "var(--amber)", marginBottom: 6 }}>{note}</div>}
            {mode === "read" && (oldVersion
              ? <><div className="dim">An older version · <a href="#" onClick={(e) => { e.preventDefault(); setOldVersion(null); }}>back to now</a></div><Body body={oldVersion} refs={s.refs} /></>
              : s.body ? <Body body={s.body} refs={s.refs} /> : <div className="dim">Empty so far: it fills as you tell it things.</div>)}
            {mode === "revise" && (
              <div className="col">
                <div className="dim">Say what you want: a change, "absorb this into the rest of the web", a different structure…</div>
                <textarea rows={4} value={words} onChange={(e) => setWords(e.target.value)} />
                <div className="row"><Mic onText={(t) => setWords((x) => (x ? `${x} ${t}` : t))} /><span className="grow" /><button className="primary" disabled={!words.trim() || Boolean(busy)} onClick={doRevise}>revise</button></div>
              </div>
            )}
            {mode === "edit" && (
              <div className="col">
                <div className="dim">Type in it yourself. What you change is marked as yours; it decides what to do with it next time.</div>
                <textarea rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="row"><Mic onText={(t) => setDraft((x) => `${x} ${t}`)} /><span className="grow" /><button className="primary" disabled={Boolean(busy)} onClick={doEdit}>save</button></div>
              </div>
            )}
            {mode === "history" && (
              <div>
                {!s.versions.length && <div className="dim">No earlier versions yet.</div>}
                {s.versions.map((v) => <div key={v.id} className="hist"><a href="#" onClick={(e) => { e.preventDefault(); setOldVersion(v.body); setMode("read"); }}>{when(v.created_at)}</a> <span className="dim">{v.why}</span></div>)}
              </div>
            )}
            <div className="hist dim">
              {s.feedsInto.length > 0 && <div>feeds into: {s.feedsInto.map((p) => <a key={p.id} href="#" onClick={(e) => { e.preventDefault(); openSummary(p.id); }} style={{ marginRight: 8 }}>{p.title}</a>)}</div>}
              <div>made from: {s.inputs.filter((i) => i.type === "summary").length} summaries, {s.inputs.filter((i) => i.type === "source").length} sources {s.inputs.filter((i) => i.type === "source").slice(0, 12).map((i) => <a key={i.id} href="#" onClick={(e) => { e.preventDefault(); openSource(i.id); }} style={{ marginRight: 6 }}>•</a>)}</div>
              {s.tags.length > 0 && <div>labels: {s.tags.join(", ")}</div>}
              <div>updated {when(s.updated_at)}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SourceWin({ f, z, close, front }: { f: Float; z: number; close: () => void; front: () => void }) {
  const { openSummary } = useShell();
  const { pos, start } = useDrag({ x: f.x, y: f.y });
  const [s, , error] = useLiveData<any>(() => api(`/sources/${f.id}`), [f.id]);
  const colour = s ? `var(--${s.origin === "isaak" ? "white" : s.origin === "web" ? "cyan" : s.origin === "session" ? "green" : "amber"})` : undefined;
  return (
    <div className="win float" style={{ left: pos.x, top: pos.y, zIndex: z, height: 380 }} onMouseDown={front}>
      <div className="bar" onMouseDown={start}><span className="title">source · {s?.title || s?.kind || "…"}</span><button onClick={close}>×</button></div>
      <div className="body">
        {error && <div style={{ color: "var(--red)" }}>{error}</div>}
        {s && (
          <>
            <div className="dim">{s.kind} · {s.origin === "isaak" ? "from you" : s.origin === "web" ? "from outside" : s.origin === "session" ? "from a work session" : "its own"} · {when(s.created_at)}{s.readable ? "" : " · it can't read this yet"}</div>
            {s.mime?.startsWith("image/") && <img src={`/api/sources/${s.id}/file`} style={{ maxWidth: "100%", margin: "8px 0" }} />}
            {s.file_name && <div><a href={`/api/sources/${s.id}/file`} target="_blank" rel="noreferrer">open {s.file_name}</a></div>}
            <div className="prose" style={{ color: colour, marginTop: 8 }}>{s.text}</div>
            {s.feedsInto.length > 0 && <div className="hist dim">feeds into: {s.feedsInto.map((p: { id: string; title: string }) => <a key={p.id} href="#" onClick={(e) => { e.preventDefault(); openSummary(p.id); }} style={{ marginRight: 8 }}>{p.title}</a>)}</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function Home({ floats, closeFloat, frontFloat }: { floats: Float[]; closeFloat: (k: string) => void; frontFloat: (k: string) => void }) {
  const [folded, setFolded] = useState(false);
  return (
    <div className="home">
      <Chat folded={folded} onFold={() => setFolded(!folded)} />
      <div className="treepane">
        <Tree />
        <Floats floats={floats} close={closeFloat} front={frontFloat} />
        <Legend />
      </div>
    </div>
  );
}
