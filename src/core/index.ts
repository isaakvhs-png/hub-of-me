import type { Db } from "../db.js";
import { migrate } from "../db.js";
import { textFromUpload } from "../ingest.js";
import { ensureAccount, listUserIds, providerFor } from "./accounts.js";
import { LiveModels, type Models } from "./ai.js";
import { freshStartOnce } from "./fresh.js";
import { registerJobs } from "./jobs.js";
import { MockModels } from "./mock.js";
import { enqueue, recoverStuck, type Run } from "./queue.js";
import { migrateCore } from "./schema.js";
import { addSource, addStream, streamByClientId, type StreamRow } from "./store.js";
import type { Ctx } from "./steps.js";

export { registerJobs };

const STORE_LIMIT = 200_000; // characters a file may keep whole; beyond it the source records the cut (orig vs stored size)

/** Migrate, create the account, archive the old web once, register the jobs, put back runs a restart interrupted. */
export async function bootCore(db: Db, opts: { now?: () => Date } = {}): Promise<{ userIds: string[]; fresh: Awaited<ReturnType<typeof freshStartOnce>> }> {
  await migrate(db);
  await migrateCore(db);
  const fresh = await freshStartOnce(db, (opts.now ?? (() => new Date()))());
  await ensureAccount(db);
  registerJobs();
  const userIds = await listUserIds(db);
  for (const userId of userIds) await recoverStuck({ db, userId, ai: new MockModels(), now: opts.now ?? (() => new Date()) });
  return { userIds, fresh };
}

const live = new LiveModels();
const mock = new MockModels();

export async function modelsFor(db: Db, userId: string): Promise<Models> {
  return (await providerFor(db, userId)) === "mock" ? mock : live;
}

export async function ctxFor(db: Db, userId: string, ai?: Models, now?: () => Date): Promise<Ctx> {
  return { db, userId, ai: ai ?? (await modelsFor(db, userId)), now: now ?? (() => new Date()) };
}

export interface Upload { name: string; bytes?: Buffer; text?: string }

/**
 * Isaak sends something: the message goes into the stream with its client message id (gaps and duplicates can be
 * detected), files into sources whole, linked "sent together"; then a run is queued that jumps the queue.
 */
export async function send(ctx: Ctx, input: { text: string; clientMsgId?: string; files?: Upload[] }): Promise<{ stream: StreamRow; run: Run | null; duplicate: boolean }> {
  if (input.clientMsgId) {
    const dup = await streamByClientId(ctx, input.clientMsgId);
    if (dup) return { stream: dup, run: null, duplicate: true };
  }
  const sourceIds: string[] = [];
  const titles: string[] = [];
  const pending: { title: string; body: string; orig: number }[] = [];
  for (const f of input.files ?? []) {
    const text = f.text ?? (f.bytes ? (await textFromUpload(f.name, f.bytes)).text : "");
    pending.push({ title: f.name, body: text.slice(0, STORE_LIMIT), orig: text.length });
    titles.push(f.name);
  }
  const content = input.text.trim() || (titles.length ? `(sent ${titles.join(", ")})` : "");
  const stream = await addStream(ctx, { kind: "his", content: titles.length ? `${content}${input.text.trim() ? `\n📎 ${titles.join(", ")}` : ""}` : content, clientMsgId: input.clientMsgId ?? null });
  for (const p of pending) {
    const { source } = await addSource(ctx, { kind: "file", title: p.title, body: p.body, origSize: p.orig, streamId: stream.id });
    sourceIds.push(source.id);
  }
  if (sourceIds.length) await ctx.db.query(`UPDATE stream SET sent_with_source=$3 WHERE user_id=$1 AND id=$2`, [ctx.userId, stream.id, sourceIds.join(",")]);
  const run = await enqueue(ctx, { trigger: "you", job: "reply", purpose: `Answer Isaak: ${content.slice(0, 120)}`, input: { message: input.text.trim(), streamId: stream.id, sourceIds } });
  await ctx.db.query(`UPDATE stream SET run_id=$3 WHERE user_id=$1 AND id=$2`, [ctx.userId, stream.id, run.id]);
  return { stream, run, duplicate: false };
}
