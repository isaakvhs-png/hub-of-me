import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { RichText, time } from "./text";

/**
 * The workshop (BUILD_SPEC §5.8): your bench (everything addressed to you, and your own notes), proposals per target
 * (ready first; yes / not now / no, because… / revise / discuss; a thread), requests, reports, goals, the queue and
 * the upkeep backlog, the knobs (read-only). "Now" is the live map itself. What you open is recorded as attention.
 */
interface W {
  bench: { id: string; kind: string; title: string; body: string; status: string; origin: string; createdAt: string; target: string }[];
  proposals: { id: string; target: string; title: string; why: string; requestIds: string[]; status: string; hisDecision: string | null; hisWhy: string; spec: string; prediction: string; cost: string; createdAt: string }[];
  requests: { id: string; target: string; title: string; kind: string; problem: string; proposal: string; status: string; evidenceCount: number; protected: boolean; hisWhy: string; unblocks: string[]; dependsOn: string[] }[];
  goals: { id: string; text: string; why: string; status: string; steps: { at: string; note: string }[]; origin: string }[];
  queue: { id: string; trigger: string; job: string; purpose: string; status: string; dueAt: string | null }[];
  reports: { id: string; scale: string; period: string; body: string; created_at: string }[];
  threads: { target_kind: string; target_id: string; his_text: string; its_reply: string; status: string }[];
  backlog: number;
  knobs: Record<string, unknown>;
}

function Section({ id, title, count, children, open }: { id: string; title: string; count?: number; children: React.ReactNode; open?: boolean }) {
  const since = useRef<number | null>(open ? Date.now() : null);
  return (
    <details className="wsec" open={open} onToggle={(e) => {
      const isOpen = (e.target as HTMLDetailsElement).open;
      if (isOpen) since.current = Date.now();
      else if (since.current) { void api("/api/attention", { method: "POST", body: JSON.stringify({ what: `workshop:${id}`, ms: Math.min(3_600_000, Date.now() - since.current) }) }).catch(() => undefined); since.current = null; }
    }}>
      <summary>{title}{count != null ? <span className="count">{count}</span> : null}</summary>
      {children}
    </details>
  );
}

export function Workshop({ tick, onMemory, onMap }: { tick: number; onMemory: (k: string, id: string) => void; onMap: (p: string) => void }) {
  const [w, setW] = useState<W | null>(null);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const load = () => void api<W>("/api/workshop").then(setW).catch((e) => setErr(String(e.message)));
  useEffect(load, [tick]);
  if (!w) return <p className="note">{err || "Opening the workshop…"}</p>;

  const benchOpen = w.bench.filter((b) => b.status === "open");
  const targets = [...new Set(w.proposals.map((p) => p.target))];
  async function decide(id: string, decision: string) {
    setErr("");
    try { await api(`/api/proposals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, why: why[id] ?? "" }) }); load(); } catch (e) { setErr(e instanceof Error ? e.message : "Not saved."); }
  }
  async function bench(id: string, status: string) { await api(`/api/bench/${id}`, { method: "POST", body: JSON.stringify({ status }) }); load(); }
  async function addNote(kind: "note" | "todo") { if (!note.trim()) return; await api("/api/bench", { method: "POST", body: JSON.stringify({ kind, title: note.trim(), body: "" }) }); setNote(""); load(); }

  return (
    <div className="workshop">
      {err ? <p className="err">{err}</p> : null}
      <Section id="bench" title="Your bench" count={benchOpen.length} open>
        {benchOpen.map((b) => (
          <div key={b.id} className={`card k-${b.kind}`}>
            <div className="card-h"><span className="tag">{b.origin === "his" ? `your ${b.kind}` : b.kind}</span><b>{b.title}</b></div>
            {b.body ? <div className="card-b"><RichText text={b.body} onMap={onMap} onMemory={onMemory} /></div> : null}
            <div className="card-a"><span className="note">{time(b.createdAt)}</span><button type="button" onClick={() => void bench(b.id, b.kind === "draft" ? "used" : "done")}>{b.kind === "draft" ? "Used it" : "Done"}</button><button type="button" onClick={() => void bench(b.id, "dismissed")}>Dismiss</button></div>
          </div>
        ))}
        {!benchOpen.length ? <p className="note">Nothing waiting for you.</p> : null}
        <div className="row"><input value={note} placeholder="A note or to-do of your own…" onChange={(e) => setNote(e.target.value)} /><button type="button" onClick={() => void addNote("note")}>Note</button><button type="button" onClick={() => void addNote("todo")}>To-do</button></div>
      </Section>

      <Section id="proposals" title="Proposals" count={w.proposals.filter((p) => p.status === "ready").length} open={w.proposals.some((p) => p.status === "ready")}>
        {targets.map((t) => (
          <div key={t}>
            <p className="note">For {t === "self" ? "itself" : `project ${t}`}</p>
            {w.proposals.filter((p) => p.target === t).map((p) => (
              <div key={p.id} className={`card${p.status === "ready" ? " ready" : ""}`}>
                <div className="card-h"><span className="tag">{p.status}</span><b>{p.title}</b></div>
                <div className="card-b">
                  <p>{p.why}</p>
                  {p.spec ? <p><b>Spec:</b> {p.spec}</p> : null}
                  {p.prediction ? <p><b>Prediction:</b> {p.prediction}</p> : null}
                  {p.cost ? <p><b>Cost:</b> {p.cost}</p> : null}
                  <p className="note">Evidence: {p.requestIds.map((r) => { const q = w.requests.find((x) => x.id === r); return q ? `${q.title} (${q.evidenceCount} run(s)${q.protected ? ", protected" : ""})` : r; }).join("; ")}</p>
                  {p.hisDecision ? <p className="note">You said: {p.hisDecision}{p.hisWhy ? `, because ${p.hisWhy}` : ""}</p> : null}
                  {w.threads.filter((x) => x.target_kind === "proposal" && x.target_id === p.id).map((x, i) => <div key={i} className="thread"><p><b>You:</b> {x.his_text}</p><p><b>It:</b> <RichText text={x.its_reply} onMap={onMap} onMemory={onMemory} /></p></div>)}
                </div>
                <input placeholder="Why, or what to change (needed for no)" value={why[p.id] ?? ""} onChange={(e) => setWhy({ ...why, [p.id]: e.target.value })} />
                <div className="card-a">
                  <button type="button" className="primary" onClick={() => void decide(p.id, "yes")}>Yes</button>
                  <button type="button" onClick={() => void decide(p.id, "not_now")}>Not now</button>
                  <button type="button" onClick={() => void decide(p.id, "no")}>No, because…</button>
                  <button type="button" onClick={() => void decide(p.id, "revise")}>Revise</button>
                  <button type="button" onClick={() => void decide(p.id, "discuss")}>Discuss</button>
                  {p.status === "accepted" ? <button type="button" onClick={() => void decide(p.id, "live")}>It's live</button> : null}
                </div>
              </div>
            ))}
          </div>
        ))}
        {!w.proposals.length ? <p className="note">No proposals yet. Requests become proposals once they have enough evidence (or block something), in the nightly review.</p> : null}
      </Section>

      <Section id="requests" title="Requests (what it asks for)" count={w.requests.filter((r) => r.status === "open" || r.status === "ready").length}>
        {w.requests.map((r) => (
          <div key={r.id} className="card">
            <div className="card-h"><span className="tag">{r.status}</span><b>{r.title}</b>{r.protected ? <span className="tag warn">protected</span> : null}</div>
            <div className="card-b"><p>{r.problem}</p>{r.proposal ? <p className="muted">{r.proposal}</p> : null}<p className="note">{r.kind} · {r.evidenceCount} run(s) of evidence{r.unblocks.length ? ` · unblocks: ${r.unblocks.join(", ")}` : ""}{r.dependsOn.length ? ` · depends on: ${r.dependsOn.join(", ")}` : ""}{r.hisWhy ? ` · ${r.hisWhy}` : ""}</p></div>
          </div>
        ))}
      </Section>

      <Section id="reports" title="Reports" count={w.reports.length}>
        {w.reports.map((r) => <details key={r.id} className="card"><summary>{r.scale === "week" ? "Week" : "Night"} of {r.period}</summary><div className="card-b"><RichText text={r.body} onMap={onMap} onMemory={onMemory} /></div></details>)}
        {!w.reports.length ? <p className="note">The first nightly review runs at 23:30.</p> : null}
      </Section>

      <Section id="goals" title="Its goals" count={w.goals.filter((g) => g.status === "open").length}>
        {w.goals.map((g) => <div key={g.id} className="card"><div className="card-h"><span className="tag">{g.status}</span><b>{g.text}</b></div><div className="card-b"><p className="muted">{g.why}</p>{g.steps.slice(-4).map((s, i) => <p key={i} className="note">{time(s.at)}: {s.note.slice(0, 200)}</p>)}</div></div>)}
      </Section>

      <Section id="queue" title="Queue and upkeep" count={w.queue.length}>
        <p className="note">Stale pages waiting: {w.backlog}</p>
        {w.queue.map((q) => <p key={q.id} className="note">{q.status} · {q.trigger}/{q.job}{q.dueAt ? ` · due ${time(q.dueAt)}` : ""} · {q.purpose}</p>)}
      </Section>

      <Section id="knobs" title="Knobs (read-only)">
        <table className="knobs"><tbody>{Object.entries(w.knobs).map(([k, v]) => <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>)}</tbody></table>
        <p className="note">A knob is a starting point, not a rule. They live in src/knobs.ts.</p>
      </Section>
    </div>
  );
}
