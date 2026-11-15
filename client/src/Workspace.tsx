import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Mic, Spinner, Win, useLiveData, useShell, when } from "./shared";

interface Project { id: string; title: string; owner: string; status: string; goal: string; summary_id: string | null; closed_at: string | null; last_active_at: string; created_at: string }
interface Proposal { id: string; kind: string; title: string; body: string; status: string; why: string; project_id: string | null; created_at: string }

// ---------------- the lists: its projects, proposals, my projects ----------------

export function WorkspaceLists() {
  const { live, openProject } = useShell();
  const [tab, setTab] = useState<"its" | "proposals" | "mine">("mine");
  const [projects] = useLiveData<Project[]>(() => api("/projects"));
  const [proposals] = useLiveData<Proposal[]>(() => api("/proposals"));
  const [openProposal, setOpenProposal] = useState<string | null>(null);
  const create = async () => { const title = prompt("What is the project called?", "") ?? ""; const out = await api("/projects", { body: { title } }); openProject(out.id); };
  const its = (projects ?? []).filter((p) => p.owner === "it");
  const mine = (projects ?? []).filter((p) => p.owner === "isaak");
  const openCount = (proposals ?? []).filter((p) => p.status === "open").length;
  return (
    <div className="wsl">
      <div className="lists">
        <div className="row">
          <button className={tab === "mine" ? "primary" : ""} onClick={() => setTab("mine")}>my projects</button>
          <button className={tab === "its" ? "primary" : ""} onClick={() => setTab("its")}>its projects</button>
          <button className={tab === "proposals" ? "primary" : ""} onClick={() => setTab("proposals")}>proposals{openCount ? ` (${openCount})` : ""}</button>
          <span className="grow" />
          <button className="primary" onClick={create}>+ open a workspace</button>
        </div>
        <div className="scroll col" style={{ flex: 1 }}>
          {tab !== "proposals" && (tab === "mine" ? mine : its).map((p) => (
            <div key={p.id} className={`item ${live?.litProjects[p.id] ? "lit" : ""}`} onClick={() => openProject(p.id)}>
              <span className="t">{p.title}</span><span className={`badge ${p.status}`}>{p.status}</span>
              <div className="dim">{when(p.last_active_at)}{p.goal ? ` · ${p.goal.slice(0, 140)}` : ""}</div>
            </div>
          ))}
          {tab === "mine" && !mine.length && <div className="dim">No projects yet. Open a workspace to start one.</div>}
          {tab === "its" && !its.length && <div className="dim">It has no projects of its own yet. They start from proposals you accept.</div>}
          {tab === "proposals" && (proposals ?? []).map((p) => (
            <div key={p.id} className="item" onClick={() => setOpenProposal(p.id)}>
              <span className="t">{p.title}</span><span className={`badge ${p.status === "open" ? "open" : ""}`}>{p.status}</span>
              <div className="dim">{when(p.created_at)} · {p.body.slice(0, 160)}</div>
            </div>
          ))}
          {tab === "proposals" && !(proposals ?? []).length && <div className="dim">No proposals yet.</div>}
        </div>
      </div>
      {openProposal && <ProposalModal id={openProposal} onClose={() => setOpenProposal(null)} />}
    </div>
  );
}

/** A proposal, the same wherever it opens (a popup in any window, or from the proposals tab). */
export function ProposalModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { openProject } = useShell();
  const [list] = useLiveData<Proposal[]>(() => api("/proposals"));
  const p = list?.find((x) => x.id === id);
  const [body, setBody] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (p && body === null) setBody(p.body); }, [p]);
  if (!p) return null;
  const decided = p.status !== "open";
  const act = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); onClose(); } catch (e: any) { setError(e.message); } };
  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Win className="modal" title={`proposal · ${p.title}`} right={<button onClick={onClose}>×</button>}>
          <div className="col">
            {decided ? <div className="prose">{p.body}</div> : <textarea rows={10} value={body ?? ""} onChange={(e) => setBody(e.target.value)} />}
            {decided && <div className="dim">{p.status}{p.why ? `: ${p.why}` : ""}{p.project_id ? <> · <a href="#" onClick={(e) => { e.preventDefault(); openProject(p.project_id!); onClose(); }}>open the project</a></> : null}</div>}
            {!decided && (
              <>
                <div className="row"><Mic onText={(t) => setBody((b) => `${b ?? ""} ${t}`)} /><span className="dim">You can type into it before you accept.</span></div>
                <input placeholder="why (needed to drop it completely)" value={why} onChange={(e) => setWhy(e.target.value)} />
                {error && <div style={{ color: "var(--red)" }}>{error}</div>}
                <div className="row">
                  <button className="danger" onClick={() => act(() => api(`/proposals/${p.id}/decline`, { body: { why, drop: true } }))}>drop completely</button>
                  <button onClick={() => act(() => api(`/proposals/${p.id}/decline`, { body: { why, drop: false } }))}>decline</button>
                  <button onClick={() => act(() => api(`/proposals/${p.id}/revise`, { body: { body: body ?? p.body } }))}>save my changes</button>
                  <span className="grow" />
                  <button className="primary" onClick={() => act(async () => { const out = await api(`/proposals/${p.id}/accept`, { body: { body: body !== p.body ? body : undefined } }); openProject(out.projectId); })}>accept</button>
                </div>
              </>
            )}
          </div>
        </Win>
      </div>
    </div>
  );
}

// ---------------- one workspace ----------------

type PieceType = "pack" | "model" | "module" | "me" | "result";
interface Piece { id: string; type: PieceType; ref: string; label: string; x: number; y: number; instructions?: string }
interface Arrow { id: string; from: string; to: string; step?: number }
interface Board { pieces: Piece[]; arrows: Arrow[]; runInstructions: string }
interface Msg { id: string; role: string; text: string; proposed_board: string | null; created_at: string }
interface Run { id: string; board_version: number; status: string; log: any[]; result: string; waiting_piece: string | null; started_at: string; finished_at: string | null }
interface View { project: Project; canon: { version: number; board: Board }; versions: { version: number; board: Board; created_at: string }[]; messages: Msg[]; runs: Run[] }
interface Lego { packs: { id: string; title: string; prompt: string }[]; models: { claude: string[]; gemini: string[] }; modules: { name: string; title: string; description: string }[] }

const W = 150, H = 54;

export function WorkspaceView({ id, onClosed }: { id: string; onClosed: () => void }) {
  const [view, reload] = useLiveData<View>(() => api(`/projects/${id}`), [id]);
  const [lego] = useLiveData<Lego>(() => api("/lego"));
  const [showVersion, setShowVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState<Board | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [runOpen, setRunOpen] = useState<string | null>(null);
  const [packOpen, setPackOpen] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [view?.messages.length]);
  useEffect(() => { setDraft(null); }, [view?.canon.version]);

  if (!view) return <div className="dim" style={{ padding: 20 }}><Spinner /> opening the workspace…</div>;
  const latest = view.canon.version;
  const viewing = showVersion ?? latest;
  const historic = view.versions.find((v) => v.version === viewing)?.board ?? view.canon.board;
  const board: Board = draft ?? historic;
  const editable = viewing === latest;
  const suggestion = [...view.messages].reverse().find((m) => m.proposed_board);
  const proposed: Board | null = suggestion ? JSON.parse(suggestion.proposed_board!) : null;
  const running = view.runs.find((r) => r.status === "running" || r.status === "waiting");
  const busyPieces = new Set<string>();
  if (running) { const last = running.log[running.log.length - 1]; if (last?.piece) busyPieces.add(last.piece); if (running.waiting_piece) busyPieces.add("me"); }

  const commit = async (b: Board) => { setDraft(b); try { await api(`/projects/${id}/board`, { body: { board: b } }); } catch (e: any) { setError(e.message); } };
  const say = async () => {
    if (!text.trim()) return;
    setBusy("thinking…"); setError("");
    try { const out = await api(`/projects/${id}/talk`, { body: { text } }); setText(""); if (out.go) await go(); } catch (e: any) { setError(e.message); } finally { setBusy(""); reload(); }
  };
  const accept = async () => { if (!suggestion) return; try { await api(`/projects/${id}/accept`, { body: { messageId: suggestion.id } }); setShowVersion(null); } catch (e: any) { setError(e.message); } };
  const go = async () => { setError(""); try { await api(`/projects/${id}/go`, { method: "POST" }); } catch (e: any) { setError(e.message); } };
  const stopRun = async () => { if (running) await api(`/projects/${id}/runs/${running.id}/stop`, { method: "POST" }); };
  const close = async () => {
    setBusy("closing: writing its summary…");
    try {
      const form = new FormData();
      const png = await svgToPng(svgRef.current);
      if (png) form.set("screenshot", png, "board.png");
      await api(`/projects/${id}/close`, { form });
      onClosed();
    } catch (e: any) { setError(e.message); setBusy(""); }
  };

  const addPiece = (type: PieceType, ref: string, label: string, x = 120, y = 120) => {
    if (!editable) return;
    const pid = `${type}-${Math.random().toString(36).slice(2, 7)}`;
    void commit({ ...board, pieces: [...board.pieces, { id: pid, type, ref, label, x, y }] });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-piece");
    if (!raw) return;
    const { type, ref, label } = JSON.parse(raw);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addPiece(type, ref, label, e.clientX - rect.left + (e.currentTarget as HTMLElement).scrollLeft - W / 2, e.clientY - rect.top + (e.currentTarget as HTMLElement).scrollTop - H / 2);
  };
  const dragPiece = (e: React.MouseEvent, p: Piece) => {
    if (!editable || e.shiftKey) return;
    e.stopPropagation();
    const sx = e.clientX - p.x; const sy = e.clientY - p.y;
    let current = board;
    const move = (ev: MouseEvent) => { current = { ...current, pieces: current.pieces.map((q) => (q.id === p.id ? { ...q, x: Math.max(0, ev.clientX - sx), y: Math.max(0, ev.clientY - sy) } : q)) }; setDraft(current); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); if (current !== board) void commit(current); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const clickPiece = (e: React.MouseEvent, p: Piece) => {
    e.stopPropagation();
    if (p.type === "result") { setRunOpen(p.ref); return; }
    if (p.type === "pack" && e.detail === 2) { setPackOpen(p.ref); return; }
    if (connectFrom && connectFrom !== p.id && editable) {
      const from = board.pieces.find((q) => q.id === connectFrom)!;
      const step = from.type === "model" ? Math.max(0, ...board.arrows.filter((a) => a.from === from.id).map((a) => a.step ?? 0)) + 1 : undefined;
      void commit({ ...board, arrows: [...board.arrows, { id: `a-${Math.random().toString(36).slice(2, 7)}`, from: from.id, to: p.id, ...(step ? { step } : {}) }] });
      setConnectFrom(null);
      return;
    }
    if (e.shiftKey) { setConnectFrom(p.id); return; }
    setSelected(p.id);
  };
  const sel = board.pieces.find((p) => p.id === selected);
  const removeSelected = () => { if (!sel || sel.type === "me") return; void commit({ ...board, pieces: board.pieces.filter((p) => p.id !== sel.id), arrows: board.arrows.filter((a) => a.from !== sel.id && a.to !== sel.id) }); setSelected(null); };
  const width = Math.max(1200, ...board.pieces.map((p) => p.x + W + 60), ...(proposed?.pieces ?? []).map((p) => p.x + W + 60));
  const height = Math.max(640, ...board.pieces.map((p) => p.y + H + 60), ...(proposed?.pieces ?? []).map((p) => p.y + H + 60));
  const isIts = view.project.owner === "it";

  return (
    <div className="ws">
      <div className="lego">
        <div className="dim" style={{ marginBottom: 6 }}>drag pieces onto the board</div>
        <details open><summary>context packs</summary>
          {lego?.packs.map((p) => <div key={p.id} className="piece" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-piece", JSON.stringify({ type: "pack", ref: p.id, label: p.title }))} onDoubleClick={() => setPackOpen(p.id)} title={p.prompt}>▤ {p.title}</div>)}
          <div className="piece" style={{ borderStyle: "dashed" }} onClick={async () => { const q = prompt("What should the context pack gather?"); if (q) { setBusy("gathering a context pack…"); try { await api("/packs", { body: { prompt: q, title: "" } }); } finally { setBusy(""); } } }}>+ new pack</div>
        </details>
        <details open><summary>models</summary>
          <details open style={{ marginLeft: 8 }}><summary>claude</summary>{lego?.models.claude.map((m) => <div key={m} className="piece" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-piece", JSON.stringify({ type: "model", ref: m, label: m.replace("claude-", "").replace(/-5-5$/, "") }))}>◇ {m.replace("claude-", "")}</div>)}</details>
          <details style={{ marginLeft: 8 }}><summary>gemini</summary>{lego?.models.gemini.map((m) => <div key={m} className="piece" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-piece", JSON.stringify({ type: "model", ref: m, label: m }))}>◇ {m}</div>)}</details>
        </details>
        <details open><summary>modules</summary>
          {lego?.modules.map((m) => <React.Fragment key={m.name}><div className="piece" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-piece", JSON.stringify({ type: "module", ref: m.name, label: m.title }))}>⚙ {m.title}</div><div className="desc">{m.description}</div></React.Fragment>)}
        </details>
        <div className="desc" style={{ marginTop: 10 }}>On the board: drag to move · shift-click a piece, then click another to draw an arrow · click a piece to select it · double-click a pack to open it.</div>
      </div>

      <div className="boardwrap">
        <div className="boardbar">
          <span style={{ color: isIts ? "var(--amber)" : "var(--green)" }}>{view.project.title}</span><span className={`badge ${view.project.status}`}>{isIts ? "its project · " : ""}{view.project.status}</span>
          <span className="grow" />
          <button disabled={viewing <= 1} onClick={() => setShowVersion(Math.max(1, viewing - 1))}>‹ back</button>
          <span className="dim">v{viewing}/{latest}</span>
          <button disabled={viewing >= latest} onClick={() => setShowVersion(viewing + 1 >= latest ? null : viewing + 1)}>forth ›</button>
          {!editable && <button onClick={async () => { await commit(historic); setShowVersion(null); }}>use this version</button>}
          {running ? <button className="danger" onClick={stopRun}>■ stop</button> : <button className="primary" onClick={go}>▶ go</button>}
          <button onClick={close}>close</button>
        </div>
        <div className="board" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onClick={() => { setSelected(null); setConnectFrom(null); }}>
          <BoardSvg svgRef={svgRef} board={board} width={width} height={height} selected={selected} busy={busyPieces} connectFrom={connectFrom} onPieceDown={dragPiece} onPieceClick={clickPiece} onArrowClick={(a) => { if (editable && confirm("Remove this arrow?")) void commit({ ...board, arrows: board.arrows.filter((x) => x.id !== a.id) }); }} />
          {proposed && editable && <div className="proposed"><BoardSvg board={proposed} width={width} height={height} ghost /></div>}
          {proposed && editable && (
            <div style={{ position: "absolute", right: 10, top: 10, zIndex: 3 }} className="row">
              <span style={{ color: "var(--lit)" }}>suggested board (dashed)</span>
              <button className="primary" onClick={accept}>accept</button>
            </div>
          )}
        </div>
        <div className="instr">
          {sel ? (
            <div className="col">
              <div className="row"><span style={{ color: "var(--white)" }}>{sel.type}: {sel.label}</span><span className="dim">{sel.ref}</span><span className="grow" />{sel.type !== "me" && <button className="danger" onClick={removeSelected}>remove</button>}</div>
              {sel.type === "model" && <textarea placeholder="instructions for this model only (otherwise the run's instructions are used)" defaultValue={sel.instructions ?? ""} key={sel.id} onBlur={(e) => commit({ ...board, pieces: board.pieces.map((p) => (p.id === sel.id ? { ...p, instructions: e.target.value } : p)) })} />}
            </div>
          ) : (
            <textarea placeholder="instructions for the whole run" defaultValue={board.runInstructions} key={`run-${viewing}`} disabled={!editable} onBlur={(e) => { if (e.target.value !== board.runInstructions) void commit({ ...board, runInstructions: e.target.value }); }} />
          )}
        </div>
      </div>

      <div className="wschat">
        <div className="chatlog" ref={logRef}>
          {!view.messages.length && <div className="dim">Tell it what to put on the board: "load this module, make a pack on…, then do this and this".</div>}
          {view.messages.filter((m) => m.role !== "it-note").map((m) => (
            <div key={m.id} className={`msg ${m.role === "isaak" ? "isaak" : "it"}`}>
              <div className="who">{m.role === "isaak" ? "you" : m.role === "it-self" ? "it (to itself)" : m.role === "system" ? "board" : "workspace ai"} · {when(m.created_at)}</div>
              <div className="text">{m.text}</div>
            </div>
          ))}
          {view.runs.map((r) => (
            <div key={r.id} className="msg it">
              <div className="who">run · {when(r.started_at)}</div>
              <div className="text"><a href="#" onClick={(e) => { e.preventDefault(); setRunOpen(r.id); }}>{r.status === "running" ? <><Spinner /> running…</> : r.status === "waiting" ? "waiting for you: answer below" : `${r.status}: open the result`}</a></div>
            </div>
          ))}
          {busy && <div className="dim"><Spinner /> {busy}</div>}
        </div>
        <div className="composer">
          {error && <div style={{ color: "var(--red)" }}>{error}</div>}
          <textarea value={text} placeholder={running?.status === "waiting" ? "It's waiting for your input…" : "Talk to the workspace…"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(); } }} />
          <div className="row"><Mic onText={(t) => setText((x) => (x ? `${x} ${t}` : t))} /><span className="grow" /><button className="primary" disabled={Boolean(busy)} onClick={say}>send ⏎</button></div>
        </div>
      </div>
      {runOpen && <RunModal run={view.runs.find((r) => r.id === runOpen)} onClose={() => setRunOpen(null)} />}
      {packOpen && <PackModal id={packOpen} onClose={() => setPackOpen(null)} />}
    </div>
  );
}

function BoardSvg({ board, width, height, selected, busy, connectFrom, ghost, svgRef, onPieceDown, onPieceClick, onArrowClick }: {
  board: Board; width: number; height: number; selected?: string | null; busy?: Set<string>; connectFrom?: string | null; ghost?: boolean; svgRef?: React.RefObject<SVGSVGElement>;
  onPieceDown?: (e: React.MouseEvent, p: Piece) => void; onPieceClick?: (e: React.MouseEvent, p: Piece) => void; onArrowClick?: (a: Arrow) => void;
}) {
  const byId = new Map(board.pieces.map((p) => [p.id, p]));
  const kindLabel: Record<string, string> = { pack: "context pack", model: "model", module: "module", me: "you · need input", result: "result" };
  return (
    <svg ref={svgRef} width={width} height={height} xmlns="http://www.w3.org/2000/svg" style={ghost ? { pointerEvents: "none" } : undefined}>
      <defs>
        <marker id={ghost ? "headg" : "head"} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={ghost ? "#ffe08a" : "#6f7f77"} /></marker>
      </defs>
      <rect width={width} height={height} fill="transparent" />
      {board.arrows.map((a) => {
        const f = byId.get(a.from); const t = byId.get(a.to);
        if (!f || !t) return null;
        const [x1, y1, x2, y2] = edge(f, t);
        return (
          <g key={a.id} className="arrow" onClick={(e) => { e.stopPropagation(); onArrowClick?.(a); }} style={{ cursor: onArrowClick ? "pointer" : undefined }}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={`url(#${ghost ? "headg" : "head"})`} style={ghost ? { stroke: "#ffe08a", strokeDasharray: "5 3" } : undefined} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={10} />
            {a.step != null && <text x={(x1 + x2) / 2 + 4} y={(y1 + y2) / 2 - 4}>{a.step}</text>}
          </g>
        );
      })}
      {board.pieces.map((p) => (
        <g key={p.id} className={`pc ${p.type} ${selected === p.id || connectFrom === p.id ? "sel" : ""} ${busy?.has(p.id) ? "busy" : ""}`} transform={`translate(${p.x},${p.y})`}
          onMouseDown={(e) => onPieceDown?.(e, p)} onClick={(e) => onPieceClick?.(e, p)} style={{ cursor: ghost ? undefined : "pointer" }}>
          <rect width={W} height={H} rx={2} />
          <text x={8} y={16} className="kind">{kindLabel[p.type]}{busy?.has(p.id) ? " · busy" : ""}</text>
          <text x={8} y={36}>{(p.label || p.ref).slice(0, 19)}</text>
        </g>
      ))}
    </svg>
  );
}

function edge(f: Piece, t: Piece): [number, number, number, number] {
  const cx1 = f.x + W / 2, cy1 = f.y + H / 2, cx2 = t.x + W / 2, cy2 = t.y + H / 2;
  const clip = (cx: number, cy: number, dx: number, dy: number) => {
    const sx = dx === 0 ? Infinity : (W / 2) / Math.abs(dx); const sy = dy === 0 ? Infinity : (H / 2) / Math.abs(dy);
    const s = Math.min(sx, sy);
    return [cx + dx * s, cy + dy * s];
  };
  const [x1, y1] = clip(cx1, cy1, cx2 - cx1, cy2 - cy1);
  const [x2, y2] = clip(cx2, cy2, cx1 - cx2, cy1 - cy2);
  return [x1, y1, x2, y2];
}

async function svgToPng(svg: SVGSVGElement | null): Promise<Blob | null> {
  if (!svg) return null;
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const style = document.createElement("style");
    style.textContent = `text{fill:#d6e2db;font:12px monospace} .kind{fill:#6f7f77;font-size:10px} rect{fill:#141a17;stroke:#2a3530} .model rect{stroke:#f2f5f3} .pack rect{stroke:#6fd6e8} .module rect{stroke:#f0b45c} .me rect{stroke:#84e6a6} .result rect{stroke:#84e6a6} line{stroke:#6f7f77} .arrow text{fill:#f0b45c}`;
    clone.insertBefore(style, clone.firstChild);
    const data = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([data], { type: "image/svg+xml" }));
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = svg.width.baseVal.value; canvas.height = svg.height.baseVal.value;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0b0d0c"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
  } catch { return null; }
}

function RunModal({ run, onClose }: { run?: Run; onClose: () => void }) {
  const [i, setI] = useState<number | null>(null);
  if (!run) return null;
  const [summary, raw] = run.result.split("\n\n---\n");
  const steps = run.log;
  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Win className="modal" style={{ width: 860, height: "84vh" }} title={`run · ${run.status} · ${when(run.started_at)}`} right={<button onClick={onClose}>×</button>}>
          {run.status === "running" && <div className="dim"><Spinner /> running…</div>}
          {summary && <div className="prose" style={{ marginBottom: 10 }}>{summary}</div>}
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="dim">replay, step by step:</span>
            <button disabled={!steps.length} onClick={() => setI(0)}>⏮</button>
            <button disabled={i === null || i <= 0} onClick={() => setI((x) => Math.max(0, (x ?? 0) - 1))}>‹</button>
            <span className="dim">{i === null ? "all" : `${i + 1}/${steps.length}`}</span>
            <button disabled={i !== null && i >= steps.length - 1} onClick={() => setI((x) => Math.min(steps.length - 1, (x ?? -1) + 1))}>›</button>
            <button onClick={() => setI(null)}>all</button>
          </div>
          {(i === null ? steps : [steps[i]]).map((s: any, k: number) => (
            <div key={k} className="logstep">
              <div><span className="k">{s.kind}</span> · {s.piece}{s.model ? ` (${s.model})` : ""}{s.step != null ? ` · step ${s.step}` : ""}{s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""} <span className="dim">{s.at?.slice(11, 19)}</span></div>
              {s.input && <><div className="dim">input</div><pre>{s.input}</pre></>}
              {s.thoughts && <><div className="dim">thoughts</div><pre style={{ color: "var(--amber)" }}>{s.thoughts}</pre></>}
              {s.output && <><div className="dim">output</div><pre>{s.output}</pre></>}
              {s.note && <pre className="dim">{s.note}</pre>}
            </div>
          ))}
          {raw && <details style={{ marginTop: 10 }}><summary className="dim">raw results</summary><pre style={{ whiteSpace: "pre-wrap" }}>{raw}</pre></details>}
        </Win>
      </div>
    </div>
  );
}

function PackModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [pack] = useLiveData<any>(() => api(`/packs/${id}`), [id]);
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => { if (pack && content === null) setContent(pack.content); }, [pack]);
  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Win className="modal" style={{ width: 760 }} title={`context pack · ${pack?.title ?? "…"}`} right={<button onClick={onClose}>×</button>}>
          <div className="col">
            <div className="dim">{pack?.prompt}</div>
            <textarea rows={18} value={content ?? ""} onChange={(e) => setContent(e.target.value)} />
            <div className="row"><span className="grow" /><button className="primary" onClick={async () => { await api(`/packs/${id}`, { method: "PATCH", body: { content } }); onClose(); }}>save</button></div>
          </div>
        </Win>
      </div>
    </div>
  );
}
