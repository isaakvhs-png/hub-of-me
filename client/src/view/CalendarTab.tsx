import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** The calendar (kept as is): your events in amber, the ones it added or promised in violet. */
interface Ev { id: string; title: string; startsAt: string; endsAt: string; allDay: boolean; why: string; source: string }

export function CalendarTab() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [err, setErr] = useState("");
  const load = () => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 14 * 86_400_000);
    void api<Ev[]>(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`).then(setEvents);
  };
  useEffect(load, []);
  const days: { key: string; label: string; items: Ev[] }[] = [];
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i);
    const key = d.toDateString();
    days.push({ key, label: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), items: events.filter((e) => new Date(e.startsAt).toDateString() === key) });
  }
  async function add() {
    setErr("");
    if (!title.trim() || !start) return;
    try { await api("/api/calendar", { method: "POST", body: JSON.stringify({ title, startsAt: new Date(start).toISOString(), why: "added by Isaak" }) }); setTitle(""); setStart(""); load(); } catch (e) { setErr(e instanceof Error ? e.message : "Not added."); }
  }
  return (
    <div className="calendar">
      <p className="note">The next two weeks. Amber: yours. Violet: things it scheduled or promised.</p>
      {days.map((d) => (
        <div key={d.key} className="cal-day">
          <div className="cal-h">{d.label}</div>
          {d.items.length ? d.items.map((e) => (
            <div key={e.id} className={`ev ${e.source === "its" ? "it" : "you"}`} title={e.why}>
              {e.allDay ? "all day" : new Date(e.startsAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · {e.title}
              <button type="button" aria-label={`Archive ${e.title}`} onClick={async () => { await api(`/api/calendar/${e.id}/archive`, { method: "POST" }); load(); }}>archive</button>
            </div>
          )) : <div className="cal-empty">·</div>}
        </div>
      ))}
      <div className="row"><input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} /><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /><button type="button" onClick={() => void add()}>Add</button></div>
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}
