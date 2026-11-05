import { useEffect, useState } from "react";
import { MindMap } from "./mind-map";
import { api } from "@/lib/api";

/**
 * The Mind page: its web of bricks (MIND_DESIGN.md), drawn in mind-map.tsx with age, warmth and energy always shown;
 * next to it the brick you clicked, the agenda, and what its work sessions did.
 */

interface Brick { id: string; name: string; kind: string; origin: string; summary: string; contact: string; warmth: number; litCount: number; createdAt: string; moments: string[] }
interface Link { id: string; a: string; b: string; type: string; strength: number; reason: string }
interface Agenda { id: string; kind: string; text: string; why: string; nextStep: string; status: string; closeNote: string; createdAt: string; closedAt: string | null }
interface Session { id: string; goal: string; wins: string; leftOff: string; endedWhy: string; costEurCents: number; startedAt: string; endedAt: string | null; log: { step: number; thought: string; tools: { tool: string; what: string; result: string }[] }[] }
interface Brain { bornAt: string | null; now: string; bricks: Brick[]; links: Link[]; agenda: Agenda[]; sessions: Session[]; activation: { cause: string; energies: Record<string, number>; used: string[]; at: string } | null; running: { phase: string; label: string } | null }
interface Detail { brick: Brick; moments: { quote: string; at: string | null; source: string }[]; entries: { id: string; kind: string; text: string; origin: string; status: string; statusNote: string }[]; links: (Link & { other: string; otherName: string })[] }

/** Red for the oldest moment of its life, blue for the newest. */
function ageColor(at: string, born: number, now: number): string {
  const t = now > born ? Math.min(1, Math.max(0, (new Date(at).getTime() - born) / (now - born))) : 1;
  return `hsl(${Math.round(6 + t * 214)} 70% 56%)`;
}


export function MindPage() {
  const [brain, setBrain] = useState<Brain | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);

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

  async function explore() {
    try { await api("/api/brain/explore", { method: "POST", body: "{}" }); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Could not start."); }
  }

  if (!brain) return <p className="text-sm text-muted-foreground">{error || "Opening its mind…"}</p>;
  const born = brain.bornAt ? new Date(brain.bornAt).getTime() : Date.now() - 3_600_000;
  const now = new Date(brain.now).getTime();
  const open = brain.agenda.filter((a) => a.status === "open");
  const closed = brain.agenda.filter((a) => a.status !== "open").slice(-6).reverse();

  return (
    <div className="grid gap-4">
      <section className="min-w-0 rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <h1 className="mr-auto font-serif text-2xl italic">Mind</h1>
          <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50" disabled={Boolean(brain.running)} onClick={() => void explore()}>
            {brain.running ? "Exploring…" : "Explore now"}
          </button>
        </div>
        {error ? <p className="pb-2 text-sm text-destructive">{error}</p> : null}
        <div className="relative">
          <MindMap bricks={brain.bricks} links={brain.links} activation={brain.activation} running={brain.running} selected={selected} onSelect={setSelected} />
          {detail ? (
            <section className="absolute bottom-2 right-2 top-2 z-10 w-[min(380px,calc(100%-16px))] overflow-y-auto rounded-xl border border-border bg-card/95 p-4 shadow-xl backdrop-blur">
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
        </div>
      </section>

      <div className="grid min-w-0 content-start gap-4 md:grid-cols-2">

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
      </div>
    </div>
  );
}
