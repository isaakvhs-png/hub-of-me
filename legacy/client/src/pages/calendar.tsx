import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";

interface EventItem { id: string; title: string; startsAt: string; endsAt: string; why: string; source: string }

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function CalendarPage() {
  const [cursor, setCursor] = useState(() => new Date());
  const [view, setView] = useState("month");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", startsAt: "", endsAt: "", why: "" });

  async function reload(anchor: Date) {
    const from = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1).toISOString();
    const to = new Date(anchor.getFullYear(), anchor.getMonth() + 2, 1).toISOString();
    setEvents(await api<EventItem[]>(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
  }

  useEffect(() => { reload(cursor).catch((err) => setError(err.message)); }, [cursor]);

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const pad = (first.getDay() + 6) % 7;
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const list: (Date | null)[] = Array.from({ length: pad }, () => null);
    for (let day = 1; day <= days; day += 1) list.push(new Date(cursor.getFullYear(), cursor.getMonth(), day));
    while (list.length % 7) list.push(null);
    return list;
  }, [cursor]);

  const weekStart = useMemo(() => {
    const date = new Date(cursor);
    const pad = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - pad);
    date.setHours(0, 0, 0, 0);
    return date;
  }, [cursor]);

  function eventsOn(date: Date) {
    const key = dayKey(date);
    return events.filter((event) => dayKey(new Date(event.startsAt)) === key);
  }

  async function addEvent(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/calendar", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
        }),
      });
      setForm({ title: "", startsAt: "", endsAt: "", why: "" });
      await reload(cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not write the calendar.");
    }
  }

  const label = cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-4xl italic">Calendar</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, cursor.getDate()))}>Prev</Button>
          <div className="min-w-32 text-center text-sm">{label}</div>
          <Button variant="outline" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate()))}>Next</Button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
            <TabsTrigger value="day">Day</TabsTrigger>
          </TabsList>
        </Tabs>
        <Dialog>
          <DialogTrigger asChild><Button size="sm">Add</Button></DialogTrigger>
          <DialogContent>
            <DialogTitle className="font-serif text-2xl">Hold time</DialogTitle>
            <form className="mt-4 space-y-3" onSubmit={addEvent}>
              <div><Label>Title</Label><Input className="mt-1" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></div>
              <div><Label>Starts</Label><Input className="mt-1" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required /></div>
              <div><Label>Ends</Label><Input className="mt-1" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} required /></div>
              <div><Label>Why</Label><Input className="mt-1" value={form.why} onChange={(e) => setForm({ ...form, why: e.target.value })} required /></div>
              <Button type="submit">Write it</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      {view === "month" ? (
        <div className="mt-4 grid grid-cols-7 gap-1 text-sm">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div key={day} className="px-1 py-2 text-[11px] uppercase text-muted-foreground">{day}</div>)}
          {cells.map((date, index) => (
            <button key={index} className="min-h-20 rounded-md border border-border p-1 text-left" onClick={() => { if (date) { setCursor(date); setView("day"); } }}>
              <div className="text-xs text-muted-foreground">{date?.getDate() ?? ""}</div>
              {date ? eventsOn(date).slice(0, 2).map((item) => (
                <div key={item.id} className={`mt-1 truncate text-[11px] ${item.source === "user" ? "text-foreground" : "text-primary"}`}>{item.title}</div>
              )) : null}
            </button>
          ))}
        </div>
      ) : null}
      {view === "week" ? (
        <div className="mt-4 grid gap-2 md:grid-cols-7">
          {Array.from({ length: 7 }, (_, index) => {
            const date = new Date(weekStart);
            date.setDate(weekStart.getDate() + index);
            return (
              <div key={index} className="rounded-md border border-border p-2">
                <button className="text-xs text-muted-foreground" onClick={() => { setCursor(date); setView("day"); }}>{date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}</button>
                {eventsOn(date).map((item) => <EventCard key={item.id} item={item} />)}
              </div>
            );
          })}
        </div>
      ) : null}
      {view === "day" ? (
        <div className="mt-4 space-y-2">
          <div className="text-sm text-muted-foreground">{cursor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
          {eventsOn(cursor).length === 0 ? <p className="text-sm text-muted-foreground">Nothing held this day.</p> : null}
          {eventsOn(cursor).map((item) => <EventCard key={item.id} item={item} />)}
        </div>
      ) : null}
    </div>
  );
}

function EventCard({ item }: { item: EventItem }) {
  return (
    <div className="mt-2 rounded-md bg-secondary px-2 py-2 text-xs">
      <div className={item.source === "user" ? "" : "text-primary"}>{item.title}</div>
      <div className="mt-1 text-muted-foreground">{item.source}: {item.why}</div>
    </div>
  );
}
