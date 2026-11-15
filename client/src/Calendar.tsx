import React, { useMemo, useState } from "react";
import { api } from "./api";
import { Mic, Win, useLiveData } from "./shared";

interface Ev { id: string; title: string; starts_at: string; ends_at: string; all_day: boolean; note: string; by: string; tags: string[] }

const DAY = 86400_000;
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); const wd = (x.getDay() + 6) % 7; return new Date(x.getTime() - wd * DAY); };
const local = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export function Calendar() {
  const [view, setView] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Partial<Ev> & { new?: boolean } | null>(null);
  const [error, setError] = useState("");
  const range = useMemo(() => {
    if (view === "week") { const s = startOfWeek(anchor); return { from: s, to: new Date(s.getTime() + 7 * DAY), days: 7 }; }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = startOfWeek(first);
    return { from: s, to: new Date(s.getTime() + 42 * DAY), days: 42 };
  }, [view, anchor]);
  const [events] = useLiveData<Ev[]>(() => api(`/calendar?from=${range.from.toISOString()}&to=${range.to.toISOString()}`), [range.from.getTime(), view]);
  const tags = useMemo(() => [...new Set((events ?? []).flatMap((e) => e.tags))].slice(0, 30), [events]);
  const shown = (events ?? []).filter((e) => [...filters].every((f) => (f === "by it" ? e.by === "it" : f === "by you" ? e.by === "isaak" : e.tags.includes(f))));

  const save = async () => {
    if (!editing) return;
    setError("");
    try {
      const body = { title: editing.title ?? "", startsAt: new Date(editing.starts_at!).toISOString(), endsAt: editing.ends_at ? new Date(editing.ends_at).toISOString() : undefined, allDay: Boolean(editing.all_day), note: editing.note ?? "" };
      if (editing.new) await api("/calendar", { body });
      else await api(`/calendar/${editing.id}`, { method: "PATCH", body });
      setEditing(null);
    } catch (e: any) { setError(e.message); }
  };
  const remove = async () => { if (editing?.id && confirm("Delete this?")) { await api(`/calendar/${editing.id}`, { method: "DELETE" }); setEditing(null); } };

  const step = (dir: number) => { const d = new Date(anchor); if (view === "week") d.setDate(d.getDate() + 7 * dir); else d.setMonth(d.getMonth() + dir); setAnchor(d); };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cells = Array.from({ length: range.days }, (_, i) => new Date(range.from.getTime() + i * DAY));
  return (
    <div className="cal">
      <div className="row">
        <button onClick={() => step(-1)}>‹</button>
        <button onClick={() => setAnchor(new Date())}>today</button>
        <button onClick={() => step(1)}>›</button>
        <span style={{ color: "var(--white)", minWidth: 180 }}>{view === "month" ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : `week of ${range.from.toLocaleDateString()}`}</span>
        <button className={view === "month" ? "primary" : ""} onClick={() => setView("month")}>month</button>
        <button className={view === "week" ? "primary" : ""} onClick={() => setView("week")}>week</button>
        <span className="grow" />
        <button className="primary" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); setEditing({ new: true, title: "", starts_at: local(s.toISOString()), ends_at: local(new Date(s.getTime() + 3600_000).toISOString()), all_day: false, note: "" }); }}>+ add</button>
      </div>
      <div className="filters" style={{ border: "none", padding: 0 }}>
        {["by you", "by it", ...tags].map((f) => <button key={f} className={`chip ${filters.has(f) ? "on" : ""}`} onClick={() => { const n = new Set(filters); if (n.has(f)) n.delete(f); else n.add(f); setFilters(n); }}>{f}</button>)}
      </div>
      <div className={`calgrid ${view === "week" ? "week" : ""}`}>
        {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => <div key={d} className="head">{d}</div>)}
        {cells.map((d) => {
          const dayEvents = shown.filter((e) => new Date(e.starts_at) < new Date(d.getTime() + DAY) && new Date(e.ends_at) > d);
          return (
            <div key={d.toISOString()} className={`cell ${view === "month" && d.getMonth() !== anchor.getMonth() ? "other" : ""} ${d.getTime() === today.getTime() ? "today" : ""}`}
              onDoubleClick={() => { const s = new Date(d); s.setHours(9); setEditing({ new: true, title: "", starts_at: local(s.toISOString()), ends_at: local(new Date(s.getTime() + 3600_000).toISOString()), all_day: false, note: "" }); }}>
              <div className="dim">{d.getDate()}</div>
              {dayEvents.map((e) => (
                <div key={e.id} className={`ev ${e.by === "it" ? "it" : ""}`} title={`${e.title}${e.note ? `\n${e.note}` : ""}`} onClick={() => setEditing({ ...e, starts_at: local(e.starts_at), ends_at: local(e.ends_at) })}>
                  {e.all_day ? "" : `${new Date(e.starts_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} `}{e.title}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {editing && (
        <div className="overlay" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <Win className="modal" title={editing.new ? "new appointment" : `appointment${editing.by === "it" ? " (added by it)" : ""}`} right={<button onClick={() => setEditing(null)}>×</button>}>
              <div className="col">
                <div className="row"><input className="grow" placeholder="title" value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /><Mic onText={(t) => setEditing({ ...editing, title: `${editing.title ?? ""} ${t}`.trim() })} /></div>
                <label className="row">all day <input type="checkbox" checked={Boolean(editing.all_day)} onChange={(e) => setEditing({ ...editing, all_day: e.target.checked })} /></label>
                <div className="row">from <input type="datetime-local" value={editing.starts_at ?? ""} onChange={(e) => setEditing({ ...editing, starts_at: e.target.value })} /> to <input type="datetime-local" value={editing.ends_at ?? ""} onChange={(e) => setEditing({ ...editing, ends_at: e.target.value })} /></div>
                <textarea rows={3} placeholder="note" value={editing.note ?? ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                {error && <div style={{ color: "var(--red)" }}>{error}</div>}
                <div className="row">{!editing.new && <button className="danger" onClick={remove}>delete</button>}<span className="grow" /><button className="primary" onClick={save}>save</button></div>
              </div>
            </Win>
          </div>
        </div>
      )}
    </div>
  );
}
