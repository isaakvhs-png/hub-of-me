import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { when } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  why: string;
  owner: string;
  status: string;
  dueAt: string | null;
  sourceKind: string;
  conversationId: string | null;
  createdAt: string;
}
interface Action {
  id: string;
  text: string;
  debateId: string | null;
  debateQuestion: string | null;
  kind: string;
}

export function ToDoList({ compact = false }: { compact?: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [error, setError] = useState("");
  async function reload() {
    const data = await api<{ tasks: Task[]; actions: Action[] }>("/api/tasks");
    setTasks(data.tasks);
    setActions(data.actions);
  }
  useEffect(() => { reload().catch((err) => setError(err.message)); }, []);
  async function setStatus(id: string, status: "done" | "archived" | "open") {
    setError("");
    try { await api(`/api/tasks/${id}`, { method: "POST", body: JSON.stringify({ status }) }); await reload(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not update that."); }
  }
  const empty = tasks.length === 0 && actions.length === 0;
  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {empty ? <p className="text-sm text-muted-foreground">Nothing open.</p> : null}
      {tasks.map((task) => (
        <Card key={task.id} className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{task.owner === "system" ? "Ask you for" : "For you"}{task.dueAt ? ` · due ${when(task.dueAt)}` : ""}</div>
          <p className="mt-1">{task.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{task.why}</p>
          {task.conversationId ? <Link className="mt-2 inline-block text-sm text-primary" to={`/?c=${task.conversationId}`}>From the dump</Link> : null}
          {compact ? null : (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void setStatus(task.id, "done")}>Done</Button>
              <Button size="sm" variant="ghost" onClick={() => void setStatus(task.id, "archived")}>Archive</Button>
            </div>
          )}
        </Card>
      ))}
      {actions.map((item) => (
        <Card key={item.id} className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">From a debate</div>
          <p className="mt-1">{item.text}</p>
          {item.debateId ? <Link className="mt-2 inline-block text-sm text-primary" to={`/debates/${item.debateId}`}>{item.debateQuestion || "The debate"}</Link> : null}
        </Card>
      ))}
    </div>
  );
}

export function ToDoPage() {
  return (
    <div className="max-w-xl">
      <h1 className="font-serif text-4xl italic">To-do</h1>
      <p className="mt-2 text-sm text-muted-foreground">What is open for you, what the system is still asking you for, and actions carried forward from debates. Nothing here is deleted.</p>
      <div className="mt-6">
        <ToDoList />
      </div>
    </div>
  );
}
