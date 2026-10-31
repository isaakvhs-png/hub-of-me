import type { Db } from "./db.js";
import { insertTask, listTasks, setTaskStatus, type Task } from "./repo.js";
import { taskMatchesDelivery } from "./wording.js";

export function parseDue(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function rememberTasks(
  db: Db,
  userId: string,
  tasks: { title: string; why: string; owner: "peter" | "system"; due?: string }[],
  source: { sourceKind: string; sourceId?: string | null; conversationId?: string | null },
): Promise<Task[]> {
  const saved: Task[] = [];
  for (const task of tasks) {
    saved.push(
      await insertTask(db, userId, {
        title: task.title,
        why: task.why,
        owner: task.owner,
        dueAt: parseDue(task.due),
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        conversationId: source.conversationId,
      }),
    );
  }
  return saved;
}

export async function closeDeliveredTasks(db: Db, userId: string, delivery: { title: string; text: string }, why: string): Promise<Task[]> {
  const open = await listTasks(db, userId, "open");
  const closed: Task[] = [];
  for (const task of open) {
    if (!taskMatchesDelivery(task.title, delivery)) continue;
    const updated = await setTaskStatus(db, userId, task.id, "done", why);
    if (updated) closed.push(updated);
  }
  return closed;
}

export async function closeNamedTasks(db: Db, userId: string, ids: string[], why: string): Promise<Task[]> {
  const open = new Set((await listTasks(db, userId, "open")).map((task) => task.id));
  const closed: Task[] = [];
  for (const taskId of ids) {
    if (!open.has(taskId)) continue;
    const updated = await setTaskStatus(db, userId, taskId, "done", why);
    if (updated) closed.push(updated);
  }
  return closed;
}
