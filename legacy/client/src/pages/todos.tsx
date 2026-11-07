import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { isFresh } from "@/lib/seen";
import { when } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  why: string;
  owner: string;
  status: string;
  dueAt: string | null;
  conversationId: string | null;
  whyNow: string | null;
  surfaced: boolean;
  fadeReason: string | null;
  createdAt: string;
  updatedAt: string;
  sourceKind?: string;
}
interface Action {
  id: string;
  text: string;
  debateId: string | null;
  debateQuestion: string | null;
  kind: string;
  createdAt?: string;
}

export function ToDoList({ compact = false }: { compact?: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [ledger, setLedger] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function reload(all = ledger, captureSeen = false) {
    const data = await api<{ tasks: Task[]; actions: Action[]; seen: string | null }>(`/api/tasks${all ? "?ledger=1" : ""}`);
    setTasks(data.tasks);
    setActions(data.actions);
    if (captureSeen) setSeen(data.seen);
  }
  useEffect(() => {
    reload(false, true)
      .then(() => api("/api/seen", { method: "POST", body: JSON.stringify({ surface: "todos" }) }).catch(() => undefined))
      .catch((err) => setError(err.message));
  }, []);
  const now = tasks.filter((task) => task.status === "open" && task.surfaced);
  const faded = tasks.filter((task) => task.status !== "open");
  const resting = tasks.filter((task) => task.status === "open" && !task.surfaced);
  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {now.length === 0 && actions.length === 0 ? <p className="text-sm text-muted-foreground">Nothing needs you right now.</p> : null}
      {now.map((task) => (
        <Card key={task.id} className={`p-4 ${isFresh(seen, task.updatedAt) ? "border-primary" : ""}`}>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{task.owner === "system" ? "Ask you for" : "For you"}{task.dueAt ? ` · due ${when(task.dueAt)}` : ""}{isFresh(seen, task.updatedAt) ? ` · new · from a ${task.sourceKind || "dump"}` : ""}</div>
          <p className="mt-1">{task.title}</p>
          {task.whyNow ? <p className="mt-1 text-sm text-primary">Why now: {task.whyNow}</p> : null}
          <p className="mt-1 text-sm text-muted-foreground">{task.why}</p>
          {task.conversationId ? <Link className="mt-2 inline-block text-sm text-primary" to={`/?c=${task.conversationId}`}>From the dump</Link> : null}
        </Card>
      ))}
      {actions.map((item) => (
        <Card key={item.id} className={`p-4 ${isFresh(seen, item.createdAt) ? "border-primary" : ""}`}>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">From a debate{isFresh(seen, item.createdAt) ? " · new" : ""}</div>
          <p className="mt-1">{item.text}</p>
          {item.debateId ? <Link className="mt-2 inline-block text-sm text-primary" to={`/debates/${item.debateId}`}>{item.debateQuestion || "The debate"}</Link> : null}
        </Card>
      ))}
      {compact ? null : (
        <div className="pt-4">
          <button className="text-xs uppercase tracking-wide text-muted-foreground" onClick={() => { const next = !ledger; setLedger(next); void reload(next).catch((err) => setError(err.message)); }}>{ledger ? "Hide the ledger" : "Open the full ledger"}</button>
          {ledger ? (
            <div className="mt-3 space-y-2">
              {resting.map((task) => (
                <p key={task.id} className="text-sm text-muted-foreground">{task.title} — held quietly. {task.why}</p>
              ))}
              {faded.map((task) => (
                <p key={task.id} className="text-sm text-muted-foreground">{task.status}: {task.title}{task.fadeReason ? ` — ${task.fadeReason}` : ""}</p>
              ))}
              {resting.length + faded.length === 0 ? <p className="text-sm text-muted-foreground">The ledger has nothing else.</p> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ToDoPage() {
  return (
    <div className="max-w-xl">
      <h1 className="font-serif text-4xl italic">To-do</h1>
      <p className="mt-2 text-sm text-muted-foreground">What is worth raising now, with why. Everything else stays in the ledger until it is done or it fades, with a reason. Nothing is deleted, and nothing here asks you to tick a box.</p>
      <div className="mt-6">
        <ToDoList />
      </div>
    </div>
  );
}
