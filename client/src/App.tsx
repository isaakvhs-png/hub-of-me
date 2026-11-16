import React, { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { ShellContext, Win, type Live, type Popup } from "./shared";
import { Home, type Float } from "./Home";
import { Calendar } from "./Calendar";
import { ProposalModal, WorkspaceLists, WorkspaceView } from "./Workspace";
import { Connections, Settings } from "./Pages";

type Tab = "home" | "calendar" | "workspace" | "connections" | "settings" | `ws:${string}`;

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => { api("/me").then(() => setAuthed(true)).catch(() => setAuthed(false)); }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell onSignedOut={() => setAuthed(false)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/login", { body: { email, password } }); onDone(); } catch (err: any) { setError(err.message); }
  };
  return (
    <div className="login">
      <Win title="hub-rings · sign in">
        <form className="col" onSubmit={submit}>
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div style={{ color: "var(--red)" }}>{error}</div>}
          <button className="primary" type="submit">sign in</button>
        </form>
      </Win>
    </div>
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const [live, setLive] = useState<Live | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string }[]>([]);
  const [floats, setFloats] = useState<Float[]>([]);
  const [proposalOpen, setProposalOpen] = useState<string | null>(null);
  const shownToasts = useRef(new Set<string>());
  const [down, setDown] = useState(false);

  // The live pulse: what lights up, what the chat and its own work are doing, popups.
  useEffect(() => {
    let alive = true;
    let last = 0;
    const tick = async () => {
      try {
        const l = await api<Live>("/live");
        if (alive) setDown(Boolean(l.restarting));
        if (alive && l.version !== last) { last = l.version; setLive(l); } else if (alive) setLive((old) => (old && JSON.stringify(old.lit) === JSON.stringify(l.lit) ? old : l));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onSignedOut();
        // No answer at all (or Render's own error page) while it restarts: show the circle until it is back.
        else if (alive) setDown(true);
      }
      if (alive) setTimeout(tick, 1200);
    };
    void tick();
    return () => { alive = false; };
  }, []);

  const openProject = useCallback(async (id: string) => {
    let title = "workspace";
    try { const v = await api(`/projects/${id}`); title = v.project.title; } catch { /* keep */ }
    setWorkspaces((w) => (w.some((x) => x.id === id) ? w : [...w, { id, title }]));
    setTab(`ws:${id}`);
  }, []);
  const openFloat = useCallback((type: "summary" | "source", id: string) => {
    setTab("home");
    setFloats((f) => {
      const existing = f.find((x) => x.type === type && x.id === id);
      if (existing) return [...f.filter((x) => x !== existing), existing];
      const n = f.length;
      return [...f, { key: `${type}:${id}:${Date.now()}`, type, id, x: 30 + (n % 6) * 34, y: 20 + (n % 6) * 30 }];
    });
  }, []);
  const shell = { live, openProject, openSummary: (id: string) => openFloat("summary", id), openSource: (id: string) => openFloat("source", id), goTab: (t: string) => setTab(t as Tab) };

  const popups = live?.popups ?? [];
  const big = popups.find((p) => p.kind === "shutdown");
  const question = popups.find((p) => p.kind === "question");
  const proposal = popups.find((p) => p.kind === "proposal");
  const toasts = popups.filter((p) => p.kind === "back");
  const dismiss = (p: Popup) => api(`/popups/${p.id}/dismiss`, { method: "POST" });

  const closeWs = (id: string) => { setWorkspaces((w) => w.filter((x) => x.id !== id)); if (tab === `ws:${id}`) setTab("workspace"); };
  const isWs = tab.startsWith("ws:");

  return (
    <ShellContext.Provider value={shell}>
      {down && (
        <div className="restarting">
          <div className="ring" />
          <div>The server is restarting. Don't touch anything; it'll be back in a minute.</div>
        </div>
      )}
      <div className="app">
        <div className="top">
          <div className="brand">&gt; hub-rings</div>
          <div className="tabs">
            {(["home", "calendar", "workspace", "connections", "settings"] as const).map((t) => <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</button>)}
            {workspaces.map((w) => (
              <button key={w.id} className={`tab wstab ${tab === `ws:${w.id}` ? "on" : ""} ${live?.litProjects[w.id] ? "litp" : ""}`} onClick={() => setTab(`ws:${w.id}`)}>
                ▣ {w.title}<span className="x" onClick={(e) => { e.stopPropagation(); closeWs(w.id); }}>×</span>
              </button>
            ))}
          </div>
          {/* The reopen button: a closed workspace stays one click away for 24 hours. */}
          {live?.reopenable.slice(0, 3).map((p) => <button key={p.id} className="tab reopenbtn" title="Reopen this workspace" onClick={async () => { await api(`/projects/${p.id}/reopen`, { method: "POST" }); void openProject(p.id); }}>↺ {p.title}</button>)}
          <div className="status" title={live?.doing}>
            {live?.down.length ? <span style={{ color: "var(--red)" }}>⚠ {live.down.map((d) => d.name).join(", ")} shut down</span>
              : live?.doing ? <span className="doing">● {live.doing}</span> : <span>idle</span>}
          </div>
          <button className="tab" onClick={async () => { await api("/logout", { method: "POST" }); onSignedOut(); }}>sign out</button>
        </div>
        <div className="main">
          {tab === "home" && <Home floats={floats} closeFloat={(k) => setFloats((f) => f.filter((x) => x.key !== k))} frontFloat={(k) => setFloats((f) => { const x = f.find((y) => y.key === k); return x && f[f.length - 1] !== x ? [...f.filter((y) => y !== x), x] : f; })} />}
          {tab === "calendar" && <Calendar />}
          {tab === "workspace" && <WorkspaceLists />}
          {tab === "connections" && <Connections />}
          {tab === "settings" && <Settings />}
          {isWs && <WorkspaceView key={tab} id={tab.slice(3)} onClosed={() => closeWs(tab.slice(3))} />}
        </div>

        {big && (
          <div className="overlay">
            <Win className="modal big" title={big.title} right={<button onClick={() => dismiss(big)}>×</button>}>
              <div className="prose">{big.body}</div>
              <div className="row" style={{ marginTop: 14 }}><span className="grow" /><button onClick={() => dismiss(big)}>understood</button></div>
            </Win>
          </div>
        )}
        {!big && question && (
          <div className="overlay" onClick={() => dismiss(question)}>
            <div onClick={(e) => e.stopPropagation()}>
              <Win className="modal" title={question.title} right={<button onClick={() => dismiss(question)}>×</button>}>
                <div className="prose">{question.body}</div>
                <div className="row" style={{ marginTop: 12 }}>
                  <span className="dim">Answer in the chat{question.ref_id ? " or in the project" : ""}.</span><span className="grow" />
                  {question.ref_id && <button className="primary" onClick={() => { void dismiss(question); void openProject(question.ref_id!); }}>open the project</button>}
                  <button onClick={() => { void dismiss(question); setTab("home"); }}>to the chat</button>
                </div>
              </Win>
            </div>
          </div>
        )}
        {!big && !question && proposal && !proposalOpen && (
          <div className="toast">
            <Win title={`new proposal · ${proposal.title}`} right={<button onClick={() => dismiss(proposal)}>×</button>}>
              <div className="dim">{proposal.body.slice(0, 240)}</div>
              <div className="row" style={{ marginTop: 8 }}><span className="grow" /><button className="primary" onClick={() => { setProposalOpen(proposal.ref_id); void dismiss(proposal); }}>open</button></div>
            </Win>
          </div>
        )}
        {toasts.length > 0 && (
          <div className="toast">
            {toasts.map((t) => { if (!shownToasts.current.has(t.id)) { shownToasts.current.add(t.id); setTimeout(() => void dismiss(t), 8000); } return <Win key={t.id} title={t.title}><div className="dim">{t.body}</div></Win>; })}
          </div>
        )}
        {proposalOpen && <ProposalModal id={proposalOpen} onClose={() => setProposalOpen(null)} />}
      </div>
    </ShellContext.Provider>
  );
}
