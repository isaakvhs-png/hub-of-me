import type { Db } from "./db.js";
import { asJson } from "./json.js";
import { id } from "./ids.js";
import { iso } from "./time.js";
import type { Folder, Note, NoteVersion, Settings, SoulVersion, UsageRow, User } from "./types.js";
import type { ProviderName } from "./types.js";

type Row = Record<string, unknown>;

function num(value: unknown): number {
  return Number(value);
}

function text(value: unknown): string | null {
  if (value == null) return null;
  return iso(value);
}

function mapUser(row: Row): User {
  return { id: String(row.id), email: String(row.email), name: String(row.name), createdAt: iso(row.created_at) };
}

function mapSettings(row: Row): Settings {
  return {
    userId: String(row.user_id),
    provider: String(row.provider) as ProviderName,
    cheapModel: String(row.cheap_model),
    strongModel: String(row.strong_model),
    judgeModel: String(row.judge_model),
    alternateModel: String(row.alternate_model),
    localCategories: asJson<string[]>(row.local_categories, []),
    forNowTtlHours: num(row.for_now_ttl_hours),
    dictationLang: String(row.dictation_lang ?? ""),
    priceOverrides: asJson(row.price_overrides, {}),
    usdToEur: num(row.usd_to_eur),
  };
}

function mapSoul(row: Row): SoulVersion {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    version: num(row.version),
    content: String(row.content),
    reason: String(row.reason),
    causingMessageId: row.causing_message_id == null ? null : String(row.causing_message_id),
    createdByRole: String(row.created_by_role),
    createdAt: iso(row.created_at),
  };
}

function mapFolder(row: Row): Folder {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    name: String(row.name),
    archivedAt: text(row.archived_at),
    createdAt: iso(row.created_at),
  };
}

function mapNote(row: Row): Note {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    folderId: row.folder_id == null ? null : String(row.folder_id),
    type: String(row.type),
    title: String(row.title),
    body: String(row.body),
    status: String(row.status),
    forNowExpiresAt: text(row.for_now_expires_at),
    archivedAt: text(row.archived_at),
    currentVersion: num(row.current_version),
    mockEra: row.mock_era === true || row.mock_era === "t",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapVersion(row: Row): NoteVersion {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    version: num(row.version),
    folderId: row.folder_id == null ? null : String(row.folder_id),
    type: String(row.type),
    title: String(row.title),
    body: String(row.body),
    status: String(row.status),
    reason: String(row.reason),
    causingMessageId: row.causing_message_id == null ? null : String(row.causing_message_id),
    createdAt: iso(row.created_at),
  };
}

function mapUsage(row: Row): UsageRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    role: String(row.role),
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    costUsdCents: row.cost_usd_cents == null ? null : num(row.cost_usd_cents),
    costEurCents: row.cost_eur_cents == null ? null : num(row.cost_eur_cents),
    priceKnown: row.price_known === true || row.price_known === "t",
    durationMs: num(row.duration_ms),
    inputChars: num(row.input_chars),
    outputText: String(row.output_text),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    jobId: row.job_id == null ? null : String(row.job_id),
    jobKind: row.job_kind == null ? null : String(row.job_kind),
    createdAt: iso(row.created_at),
  };
}

export async function insertUser(db: Db, input: { email: string; name: string; passwordHash: string }): Promise<User> {
  const userId = id();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [
    userId,
    input.email.toLowerCase(),
    input.name,
    input.passwordHash,
  ]);
  return getUserById(db, userId) as Promise<User>;
}

export async function getUserByEmail(db: Db, email: string): Promise<(User & { passwordHash: string }) | null> {
  const result = await db.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...mapUser(row), passwordHash: String(row.password_hash) };
}

export async function getUserById(db: Db, userId: string): Promise<User | null> {
  const result = await db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function listUsers(db: Db): Promise<User[]> {
  const result = await db.query(`SELECT id, email, name, created_at FROM users ORDER BY created_at`);
  return result.rows.map(mapUser);
}

export async function getUserWithPassword(db: Db, userId: string): Promise<(User & { passwordHash: string }) | null> {
  const result = await db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...mapUser(row), passwordHash: String(row.password_hash) };
}

export async function updateUserAccount(
  db: Db,
  userId: string,
  input: { email: string; name: string; passwordHash: string },
): Promise<User> {
  await db.query(`UPDATE users SET email = $2, name = $3, password_hash = $4 WHERE id = $1`, [
    userId,
    input.email.toLowerCase(),
    input.name,
    input.passwordHash,
  ]);
  const user = await getUserById(db, userId);
  if (!user) throw new Error("Account is missing.");
  return user;
}

export async function setUserPasswordHash(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
}

export async function createSession(db: Db, userId: string, tokenHash: string, expiresAt: string): Promise<void> {
  await db.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [id(), userId, tokenHash, expiresAt]);
}

export async function userIdForToken(db: Db, tokenHash: string): Promise<string | null> {
  const result = await db.query(`SELECT user_id, expires_at FROM sessions WHERE token_hash = $1`, [tokenHash]);
  const row = result.rows[0];
  if (!row) return null;
  if (new Date(iso(row.expires_at)).getTime() < Date.now()) return null;
  return String(row.user_id);
}

export async function expireSession(db: Db, tokenHash: string): Promise<void> {
  await db.query(`UPDATE sessions SET expires_at = now() WHERE token_hash = $1`, [tokenHash]);
}

export async function insertSettings(db: Db, settings: Settings): Promise<void> {
  await db.query(
    `INSERT INTO settings (user_id, provider, cheap_model, strong_model, judge_model, alternate_model, local_categories, for_now_ttl_hours, dictation_lang, price_overrides, usd_to_eur)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11)`,
    [
      settings.userId,
      settings.provider,
      settings.cheapModel,
      settings.strongModel,
      settings.judgeModel,
      settings.alternateModel,
      JSON.stringify(settings.localCategories),
      settings.forNowTtlHours,
      settings.dictationLang,
      JSON.stringify(settings.priceOverrides),
      settings.usdToEur,
    ],
  );
}

export async function getSettings(db: Db, userId: string): Promise<Settings> {
  const result = await db.query(`SELECT * FROM settings WHERE user_id = $1`, [userId]);
  if (!result.rows[0]) throw new Error("Settings are missing.");
  return mapSettings(result.rows[0]);
}

export async function updateSettings(db: Db, settings: Settings): Promise<Settings> {
  await db.query(
    `UPDATE settings SET provider=$2, cheap_model=$3, strong_model=$4, judge_model=$5, alternate_model=$6, local_categories=$7::jsonb, for_now_ttl_hours=$8, dictation_lang=$9, price_overrides=$10::jsonb, usd_to_eur=$11 WHERE user_id=$1`,
    [
      settings.userId,
      settings.provider,
      settings.cheapModel,
      settings.strongModel,
      settings.judgeModel,
      settings.alternateModel,
      JSON.stringify(settings.localCategories),
      settings.forNowTtlHours,
      settings.dictationLang,
      JSON.stringify(settings.priceOverrides),
      settings.usdToEur,
    ],
  );
  return getSettings(db, settings.userId);
}

export async function insertBudget(db: Db, userId: string, monthlyCapEurCents: number): Promise<void> {
  await db.query(`INSERT INTO budgets (user_id, monthly_cap_eur_cents) VALUES ($1,$2)`, [userId, monthlyCapEurCents]);
}

export async function getBudget(db: Db, userId: string): Promise<{ monthlyCapEurCents: number }> {
  const result = await db.query(`SELECT monthly_cap_eur_cents FROM budgets WHERE user_id = $1`, [userId]);
  return { monthlyCapEurCents: num(result.rows[0]?.monthly_cap_eur_cents ?? 2000) };
}

export async function setBudget(db: Db, userId: string, monthlyCapEurCents: number): Promise<void> {
  await db.query(`UPDATE budgets SET monthly_cap_eur_cents = $2 WHERE user_id = $1`, [userId, monthlyCapEurCents]);
}

export async function spendSince(db: Db, userId: string, sinceIso: string): Promise<{ spentEurCents: number; unpriced: number }> {
  const spent = await db.query(
    `SELECT COALESCE(SUM(cost_eur_cents), 0) AS spent FROM usage_records WHERE user_id = $1 AND created_at >= $2 AND price_known = true`,
    [userId, sinceIso],
  );
  const unpriced = await db.query(
    `SELECT COUNT(*) AS n FROM usage_records WHERE user_id = $1 AND created_at >= $2 AND price_known = false`,
    [userId, sinceIso],
  );
  return { spentEurCents: num(spent.rows[0]?.spent ?? 0), unpriced: num(unpriced.rows[0]?.n ?? 0) };
}

export async function listUsage(db: Db, userId: string, sinceIso: string): Promise<UsageRow[]> {
  const result = await db.query(`SELECT * FROM usage_records WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at`, [userId, sinceIso]);
  return result.rows.map(mapUsage);
}

export async function insertUsage(db: Db, row: Omit<UsageRow, "id" | "createdAt">): Promise<void> {
  await db.query(
    `INSERT INTO usage_records (id, user_id, role, provider, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd_cents, cost_eur_cents, price_known, duration_ms, input_chars, output_text, conversation_id, job_id, job_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id(),
      row.userId,
      row.role,
      row.provider,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheWriteTokens,
      row.cacheReadTokens,
      row.costUsdCents,
      row.costEurCents,
      row.priceKnown,
      row.durationMs,
      row.inputChars,
      row.outputText,
      row.conversationId,
      row.jobId,
      row.jobKind,
    ],
  );
}

export async function insertSoulVersion(db: Db, row: Omit<SoulVersion, "id" | "createdAt">): Promise<SoulVersion> {
  const soulId = id();
  await db.query(
    `INSERT INTO soul_versions (id, user_id, version, content, reason, causing_message_id, created_by_role) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [soulId, row.userId, row.version, row.content, row.reason, row.causingMessageId, row.createdByRole],
  );
  const result = await db.query(`SELECT * FROM soul_versions WHERE id = $1`, [soulId]);
  return mapSoul(result.rows[0]);
}

export async function getSoul(db: Db, userId: string): Promise<SoulVersion | null> {
  const result = await db.query(`SELECT * FROM soul_versions WHERE user_id = $1 ORDER BY version DESC LIMIT 1`, [userId]);
  return result.rows[0] ? mapSoul(result.rows[0]) : null;
}

export async function listSoulVersions(db: Db, userId: string): Promise<SoulVersion[]> {
  const result = await db.query(`SELECT * FROM soul_versions WHERE user_id = $1 ORDER BY version DESC`, [userId]);
  return result.rows.map(mapSoul);
}

export async function listFolders(db: Db, userId: string): Promise<Folder[]> {
  const result = await db.query(`SELECT * FROM folders WHERE user_id = $1 ORDER BY name`, [userId]);
  return result.rows.map(mapFolder);
}

export async function ensureFolderPath(db: Db, userId: string, path: string): Promise<string> {
  const parts = path.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Folder path is empty.");
  let parent: string | null = null;
  for (const name of parts) {
    const existing: { rows: { id: string }[] } = await db.query<{ id: string }>(
      `SELECT id FROM folders WHERE user_id = $1 AND name = $2 AND archived_at IS NULL AND parent_id IS NOT DISTINCT FROM $3`,
      [userId, name, parent],
    );
    if (existing.rows[0]) {
      parent = String(existing.rows[0].id);
      continue;
    }
    const folderId = id();
    await db.query(`INSERT INTO folders (id, user_id, parent_id, name) VALUES ($1,$2,$3,$4)`, [folderId, userId, parent, name]);
    parent = folderId;
  }
  return parent as string;
}

export async function logAction(db: Db, userId: string, entry: { what: string; why: string; source: string; payload?: unknown }): Promise<void> {
  if (!entry.why?.trim() || !entry.source?.trim()) {
    throw new Error("An action needs a why and a source.");
  }
  await db.query(`INSERT INTO action_log (id, user_id, what, why, source, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [
    id(),
    userId,
    entry.what,
    entry.why,
    entry.source,
    JSON.stringify(entry.payload ?? {}),
  ]);
}

export async function listActions(db: Db, userId: string, limit = 200): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM action_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  return result.rows.map((row) => ({
    id: String(row.id),
    what: String(row.what),
    why: String(row.why),
    source: String(row.source),
    payload: asJson(row.payload, {}),
    createdAt: iso(row.created_at),
  }));
}

export interface NoteDraft {
  folderId: string | null;
  type: string;
  title: string;
  body: string;
  status: string;
  forNowExpiresAt: string | null;
  reason: string;
  causingMessageId: string | null;
  source: string;
  mockEra?: boolean;
}

async function writeVersion(db: Db, noteId: string, version: number, draft: NoteDraft): Promise<void> {
  await db.query(
    `INSERT INTO note_versions (id, note_id, version, folder_id, type, title, body, status, reason, causing_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id(), noteId, version, draft.folderId, draft.type, draft.title, draft.body, draft.status, draft.reason, draft.causingMessageId],
  );
}

export async function insertNote(db: Db, userId: string, draft: NoteDraft): Promise<Note> {
  const noteId = id();
  const archivedAt = draft.status === "archived" ? new Date().toISOString() : null;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO notes (id, user_id, folder_id, type, title, body, status, for_now_expires_at, archived_at, current_version, mock_era) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)`,
      [noteId, userId, draft.folderId, draft.type, draft.title, draft.body, draft.status, draft.forNowExpiresAt, archivedAt, Boolean(draft.mockEra)],
    );
    await writeVersion(tx, noteId, 1, draft);
    await logAction(tx, userId, {
      what: `note created: ${draft.title}`,
      why: draft.reason,
      source: draft.source,
      payload: { noteId, status: draft.status },
    });
  });
  return (await getNote(db, userId, noteId)) as Note;
}

export async function reviseNote(db: Db, userId: string, noteId: string, draft: NoteDraft): Promise<Note> {
  const current = await getNote(db, userId, noteId);
  if (!current) throw new Error("Note not found.");
  const version = current.currentVersion + 1;
  const archivedAt = draft.status === "archived" ? new Date().toISOString() : null;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE notes SET folder_id=$2, type=$3, title=$4, body=$5, status=$6, for_now_expires_at=$7, archived_at=$8, current_version=$9, updated_at=now() WHERE id=$1 AND user_id=$10`,
      [noteId, draft.folderId, draft.type, draft.title, draft.body, draft.status, draft.forNowExpiresAt, archivedAt, version, userId],
    );
    await writeVersion(tx, noteId, version, draft);
    await logAction(tx, userId, {
      what: `note revised: ${draft.title}`,
      why: draft.reason,
      source: draft.source,
      payload: { noteId, version, status: draft.status },
    });
  });
  return (await getNote(db, userId, noteId)) as Note;
}

export async function getNote(db: Db, userId: string, noteId: string): Promise<Note | null> {
  const result = await db.query(`SELECT * FROM notes WHERE id = $1 AND user_id = $2`, [noteId, userId]);
  return result.rows[0] ? mapNote(result.rows[0]) : null;
}

export async function listNotes(db: Db, userId: string): Promise<Note[]> {
  const result = await db.query(`SELECT * FROM notes WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
  return result.rows.map(mapNote);
}

export async function countNotes(db: Db, userId: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS n FROM notes WHERE user_id = $1`, [userId]);
  return num(result.rows[0]?.n ?? 0);
}

export async function listNoteVersions(db: Db, noteId: string): Promise<NoteVersion[]> {
  const result = await db.query(`SELECT * FROM note_versions WHERE note_id = $1 ORDER BY version DESC`, [noteId]);
  return result.rows.map(mapVersion);
}

export async function createConversation(db: Db, userId: string, title: string, discoveryCardId?: string | null): Promise<string> {
  const conversationId = id();
  await db.query(`INSERT INTO conversations (id, user_id, title, discovery_card_id) VALUES ($1,$2,$3,$4)`, [
    conversationId,
    userId,
    title.slice(0, 120) || "Dump",
    discoveryCardId ?? null,
  ]);
  return conversationId;
}

export async function listConversations(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM conversations WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    discoveryCardId: row.discovery_card_id == null ? null : String(row.discovery_card_id),
    createdAt: iso(row.created_at),
  }));
}

export async function getConversation(db: Db, userId: string, conversationId: string): Promise<Row | null> {
  const result = await db.query(`SELECT * FROM conversations WHERE id = $1 AND user_id = $2`, [conversationId, userId]);
  const row = result.rows[0];
  if (!row) return null;
  return { id: String(row.id), title: String(row.title), discoveryCardId: row.discovery_card_id == null ? null : String(row.discovery_card_id), createdAt: iso(row.created_at) };
}

export async function addMessage(db: Db, conversationId: string, role: string, content: string): Promise<string> {
  const messageId = id();
  await db.query(`INSERT INTO messages (id, conversation_id, role, content) VALUES ($1,$2,$3,$4)`, [messageId, conversationId, role, content]);
  return messageId;
}

export async function listMessages(db: Db, conversationId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [conversationId]);
  return result.rows.map((row) => ({ id: String(row.id), role: String(row.role), content: String(row.content), createdAt: iso(row.created_at) }));
}

export async function insertSource(db: Db, userId: string, source: { title: string; url?: string | null; excerpt?: string; kind: string; rawText?: string; origin: string }): Promise<string> {
  const sourceId = id();
  await db.query(
    `INSERT INTO sources (id, user_id, title, url, excerpt, kind, raw_text, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sourceId, userId, source.title, source.url ?? null, source.excerpt ?? "", source.kind, source.rawText ?? "", source.origin],
  );
  await logAction(db, userId, { what: `source stored: ${source.title}`, why: "Sources are kept with no quality gate.", source: source.origin, payload: { sourceId } });
  return sourceId;
}

export async function listSources(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM sources WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    url: row.url == null ? null : String(row.url),
    excerpt: String(row.excerpt),
    kind: String(row.kind),
    origin: String(row.origin),
    createdAt: iso(row.created_at),
  }));
}

export async function insertConflict(db: Db, userId: string, description: string, noteIds: string[]): Promise<string> {
  const conflictId = id();
  await db.query(`INSERT INTO conflicts (id, user_id, description, note_ids) VALUES ($1,$2,$3,$4::jsonb)`, [conflictId, userId, description, JSON.stringify(noteIds)]);
  await logAction(db, userId, { what: "tension recorded", why: description, source: "filing", payload: { conflictId, noteIds } });
  return conflictId;
}

export async function listConflicts(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM conflicts WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    description: String(row.description),
    noteIds: asJson<string[]>(row.note_ids, []),
    resolvedAt: text(row.resolved_at),
    resolution: row.resolution == null ? null : String(row.resolution),
    createdAt: iso(row.created_at),
  }));
}

export async function resolveConflict(db: Db, userId: string, conflictId: string, resolution: string): Promise<void> {
  await db.query(`UPDATE conflicts SET resolved_at = now(), resolution = $3 WHERE id = $1 AND user_id = $2 AND resolved_at IS NULL`, [conflictId, userId, resolution]);
}

export async function insertInfoRequest(db: Db, userId: string, question: string, why: string): Promise<string> {
  const requestId = id();
  await db.query(`INSERT INTO info_requests (id, user_id, question, why, status) VALUES ($1,$2,$3,$4,'open')`, [requestId, userId, question, why]);
  await logAction(db, userId, { what: "info request", why, source: "reflection", payload: { requestId, question } });
  return requestId;
}

export async function listInfoRequests(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM info_requests WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    question: String(row.question),
    why: String(row.why),
    status: String(row.status),
    answer: row.answer == null ? null : String(row.answer),
    postponeUntil: text(row.postpone_until),
    createdAt: iso(row.created_at),
  }));
}

export async function updateInfoRequest(db: Db, userId: string, requestId: string, patch: { status: string; answer?: string | null; postponeUntil?: string | null }): Promise<void> {
  await db.query(
    `UPDATE info_requests SET status=$3, answer=$4, postpone_until=$5, updated_at=now() WHERE id=$1 AND user_id=$2`,
    [requestId, userId, patch.status, patch.answer ?? null, patch.postponeUntil ?? null],
  );
}

export async function enqueueReflection(db: Db, userId: string, noteId: string, reason: string): Promise<void> {
  await db.query(`INSERT INTO reflection_queue (id, user_id, note_id, reason) VALUES ($1,$2,$3,$4)`, [id(), userId, noteId, reason]);
}

export async function markQueueHandled(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE reflection_queue SET handled_at = now() WHERE user_id = $1 AND handled_at IS NULL`, [userId]);
}

export async function openQueue(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM reflection_queue WHERE user_id = $1 AND handled_at IS NULL ORDER BY created_at`, [userId]);
  return result.rows.map((row) => ({ id: String(row.id), noteId: String(row.note_id), reason: String(row.reason), createdAt: iso(row.created_at) }));
}

export async function startJob(db: Db, userId: string, kind: string, why: string): Promise<string> {
  const jobId = id();
  await db.query(`INSERT INTO jobs (id, user_id, kind, status, why) VALUES ($1,$2,$3,'running',$4)`, [jobId, userId, kind, why]);
  return jobId;
}

export async function finishJob(db: Db, jobId: string, status: string, report: string): Promise<void> {
  await db.query(`UPDATE jobs SET status=$2, report=$3, finished_at=now() WHERE id=$1`, [jobId, status, report]);
}

export async function listJobs(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM jobs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    report: String(row.report),
    why: String(row.why),
    startedAt: iso(row.started_at),
    finishedAt: text(row.finished_at),
  }));
}

export async function insertDebate(
  db: Db,
  row: { userId: string; question: string; judgeModel: string; jobId: string; mockEra?: boolean; triggeredByDebateId?: string | null; triggeredByFeedbackId?: string | null },
): Promise<string> {
  const debateId = id();
  await db.query(
    `INSERT INTO debates (id, user_id, question, status, judge_model, job_id, mock_era, triggered_by_debate_id, triggered_by_feedback_id) VALUES ($1,$2,$3,'running',$4,$5,$6,$7,$8)`,
    [debateId, row.userId, row.question, row.judgeModel, row.jobId, Boolean(row.mockEra), row.triggeredByDebateId ?? null, row.triggeredByFeedbackId ?? null],
  );
  return debateId;
}

export async function insertDebateSide(db: Db, row: { debateId: string; position: string; model: string; provider: string; uncomfortable: boolean; evidenceNoteIds: string[] }): Promise<string> {
  const sideId = id();
  await db.query(
    `INSERT INTO debate_sides (id, debate_id, position, model, provider, uncomfortable, evidence_note_ids) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [sideId, row.debateId, row.position, row.model, row.provider, row.uncomfortable, JSON.stringify(row.evidenceNoteIds)],
  );
  return sideId;
}

export async function updateDebateSide(
  db: Db,
  sideId: string,
  patch: { argument: string; prediction?: string | null; anonymousLabel?: string | null; model?: string | null; provider?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE debate_sides SET argument=$2, prediction=COALESCE($3, prediction), anonymous_label=COALESCE($4, anonymous_label), model=COALESCE($5, model), provider=COALESCE($6, provider) WHERE id=$1`,
    [sideId, patch.argument, patch.prediction ?? null, patch.anonymousLabel ?? null, patch.model ?? null, patch.provider ?? null],
  );
}

export async function failDebate(db: Db, debateId: string, reason: string): Promise<void> {
  await db.query(`UPDATE debates SET status = 'failed', why_won = $2 WHERE id = $1 AND status = 'running'`, [debateId, reason]);
}

/** A restart has no debate in flight. Anything still running was cut off. */
export async function settleStuckDebates(db: Db): Promise<number> {
  const marked = await db.query(
    `UPDATE debates d
     SET status = 'failed',
         why_won = COALESCE((SELECT NULLIF(j.report, '') FROM jobs j WHERE j.id = d.job_id), 'The server stopped before this debate finished.')
     WHERE d.status = 'running'
     RETURNING d.id`,
  );
  await db.query(
    `UPDATE jobs
     SET status = 'failed',
         report = CASE WHEN report = '' THEN 'The server stopped before this job finished.' ELSE report END,
         finished_at = COALESCE(finished_at, now())
     WHERE status = 'running'`,
  );
  return marked.rows.length;
}

export async function concludeDebate(db: Db, debateId: string, patch: { status: string; winnerSideId?: string | null; winnerModel?: string | null; whyWon?: string; loserGotRight?: string; closeCall?: boolean; commitment?: string }): Promise<void> {
  await db.query(
    `UPDATE debates SET status=$2, winner_side_id=$3, winner_model=$4, why_won=$5, loser_got_right=$6, close_call=$7, commitment=$8 WHERE id=$1`,
    [debateId, patch.status, patch.winnerSideId ?? null, patch.winnerModel ?? null, patch.whyWon ?? null, patch.loserGotRight ?? null, patch.closeCall ?? false, patch.commitment ?? null],
  );
}

export async function listDebates(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM debates WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map(mapDebate);
}

export async function getDebate(db: Db, userId: string, debateId: string): Promise<Row | null> {
  const result = await db.query(`SELECT * FROM debates WHERE id = $1 AND user_id = $2`, [debateId, userId]);
  return result.rows[0] ? mapDebate(result.rows[0]) : null;
}

export async function listDebateSides(db: Db, debateId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM debate_sides WHERE debate_id = $1 ORDER BY created_at`, [debateId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    position: String(row.position),
    argument: String(row.argument),
    evidenceNoteIds: asJson<string[]>(row.evidence_note_ids, []),
    model: String(row.model),
    provider: String(row.provider),
    uncomfortable: row.uncomfortable === true || row.uncomfortable === "t",
    anonymousLabel: row.anonymous_label == null ? null : String(row.anonymous_label),
    prediction: row.prediction == null ? null : String(row.prediction),
  }));
}

function mapDebate(row: Row): Row {
  return {
    id: String(row.id),
    question: String(row.question),
    status: String(row.status),
    winnerSideId: row.winner_side_id == null ? null : String(row.winner_side_id),
    winnerModel: row.winner_model == null ? null : String(row.winner_model),
    whyWon: row.why_won == null ? null : String(row.why_won),
    loserGotRight: row.loser_got_right == null ? null : String(row.loser_got_right),
    closeCall: row.close_call === true || row.close_call === "t",
    commitment: row.commitment == null ? null : String(row.commitment),
    userFeedback: row.user_feedback == null ? null : String(row.user_feedback),
    judgeModel: row.judge_model == null ? null : String(row.judge_model),
    jobId: row.job_id == null ? null : String(row.job_id),
    mockEra: row.mock_era === true || row.mock_era === "t",
    triggeredByDebateId: row.triggered_by_debate_id == null ? null : String(row.triggered_by_debate_id),
    triggeredByFeedbackId: row.triggered_by_feedback_id == null ? null : String(row.triggered_by_feedback_id),
    createdAt: iso(row.created_at),
  };
}

export interface DebateFeedback {
  id: string;
  debateId: string;
  body: string;
  status: string;
  ledToDebateId: string | null;
  ledToQuestion: string | null;
  soulVersion: number | null;
  soulReason: string | null;
  error: string | null;
  createdAt: string;
}

function mapDebateFeedback(row: Row): DebateFeedback {
  return {
    id: String(row.id),
    debateId: String(row.debate_id),
    body: String(row.body),
    status: String(row.status),
    ledToDebateId: row.led_to_debate_id == null ? null : String(row.led_to_debate_id),
    ledToQuestion: row.led_to_question == null ? null : String(row.led_to_question),
    soulVersion: row.soul_version == null ? null : num(row.soul_version),
    soulReason: row.soul_reason == null ? null : String(row.soul_reason),
    error: row.error == null ? null : String(row.error),
    createdAt: iso(row.created_at),
  };
}

export async function insertDebateFeedback(db: Db, userId: string, debateId: string, body: string): Promise<DebateFeedback> {
  const feedbackId = id();
  await db.query(`INSERT INTO debate_feedback (id, user_id, debate_id, body, status) VALUES ($1,$2,$3,$4,'pending')`, [feedbackId, userId, debateId, body]);
  const rows = await listDebateFeedback(db, debateId);
  return rows.find((item) => item.id === feedbackId) as DebateFeedback;
}

export async function listDebateFeedback(db: Db, debateId: string): Promise<DebateFeedback[]> {
  const result = await db.query(
    `SELECT f.*, led.question AS led_to_question
     FROM debate_feedback f
     LEFT JOIN debates led ON led.id = f.led_to_debate_id
     WHERE f.debate_id = $1
     ORDER BY f.created_at`,
    [debateId],
  );
  return result.rows.map(mapDebateFeedback);
}

export async function listUserDebateFeedback(db: Db, userId: string): Promise<DebateFeedback[]> {
  const result = await db.query(
    `SELECT f.*, led.question AS led_to_question
     FROM debate_feedback f
     LEFT JOIN debates led ON led.id = f.led_to_debate_id
     WHERE f.user_id = $1
     ORDER BY f.created_at`,
    [userId],
  );
  return result.rows.map(mapDebateFeedback);
}

export async function claimNextDebateFeedback(db: Db, userId: string): Promise<DebateFeedback | null> {
  const running = await db.query(`SELECT id FROM debate_feedback WHERE user_id = $1 AND status = 'running' LIMIT 1`, [userId]);
  if (running.rows[0]) return null;
  const pending = await db.query(
    `SELECT id, debate_id FROM debate_feedback WHERE user_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 1`,
    [userId],
  );
  const next = pending.rows[0];
  if (!next) return null;
  const updated = await db.query(`UPDATE debate_feedback SET status = 'running' WHERE id = $1 AND status = 'pending' RETURNING *`, [next.id]);
  const row = updated.rows[0];
  if (!row) return null;
  const listed = await listDebateFeedback(db, String(row.debate_id));
  return listed.find((item) => item.id === String(row.id)) ?? mapDebateFeedback(row);
}

export async function finishDebateFeedback(
  db: Db,
  feedbackId: string,
  patch: { status: string; ledToDebateId?: string | null; soulVersion?: number | null; soulReason?: string | null; error?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE debate_feedback SET status=$2, led_to_debate_id=$3, soul_version=$4, soul_reason=$5, error=$6 WHERE id=$1`,
    [feedbackId, patch.status, patch.ledToDebateId ?? null, patch.soulVersion ?? null, patch.soulReason ?? null, patch.error ?? null],
  );
}

export async function listRecentDumps(db: Db, userId: string, limit = 5): Promise<{ content: string; createdAt: string }[]> {
  const result = await db.query(
    `SELECT m.content, m.created_at
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1 AND m.role = 'user'
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((row) => ({ content: String(row.content).slice(0, 2000), createdAt: iso(row.created_at) }));
}

export async function setDebateFeedback(db: Db, userId: string, debateId: string, feedback: string): Promise<void> {
  await db.query(`UPDATE debates SET user_feedback = $3 WHERE id = $1 AND user_id = $2`, [debateId, userId, feedback]);
}

export async function insertPrediction(db: Db, userId: string, debateId: string | null, prediction: string): Promise<string> {
  const predictionId = id();
  await db.query(`INSERT INTO predictions (id, user_id, debate_id, prediction) VALUES ($1,$2,$3,$4)`, [predictionId, userId, debateId, prediction]);
  return predictionId;
}

export async function listPredictions(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM predictions WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    debateId: row.debate_id == null ? null : String(row.debate_id),
    prediction: String(row.prediction),
    outcome: row.outcome == null ? null : String(row.outcome),
    cameTrue: row.came_true == null ? null : row.came_true === true || row.came_true === "t",
    checkedAt: text(row.checked_at),
    createdAt: iso(row.created_at),
  }));
}

export async function setPredictionOutcome(db: Db, userId: string, predictionId: string, outcome: { cameTrue: boolean; observed: string }): Promise<void> {
  await db.query(`UPDATE predictions SET came_true=$3, outcome=$4, checked_at=now() WHERE id=$1 AND user_id=$2`, [predictionId, userId, outcome.cameTrue, outcome.observed]);
}

export async function insertEvent(db: Db, userId: string, event: { title: string; startsAt: string; endsAt: string; why: string; source: string; allDay?: boolean }): Promise<string> {
  const eventId = id();
  await db.query(
    `INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, all_day, why, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [eventId, userId, event.title, event.startsAt, event.endsAt, event.allDay ?? false, event.why, event.source],
  );
  await logAction(db, userId, { what: `calendar: ${event.title}`, why: event.why, source: event.source, payload: { eventId } });
  return eventId;
}

export async function listEvents(db: Db, userId: string, fromIso: string, toIso: string): Promise<Row[]> {
  const result = await db.query(
    `SELECT * FROM calendar_events WHERE user_id = $1 AND archived_at IS NULL AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at`,
    [userId, fromIso, toIso],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    allDay: row.all_day === true || row.all_day === "t",
    why: String(row.why),
    source: String(row.source),
    createdAt: iso(row.created_at),
  }));
}

export async function archiveEvent(db: Db, userId: string, eventId: string, why: string): Promise<void> {
  await db.query(`UPDATE calendar_events SET archived_at = now() WHERE id = $1 AND user_id = $2`, [eventId, userId]);
  await logAction(db, userId, { what: "calendar event archived", why, source: "user", payload: { eventId } });
}

export async function insertFeedback(db: Db, userId: string, content: string, context: string): Promise<string> {
  const sampleId = id();
  await db.query(`INSERT INTO feedback_samples (id, user_id, content, context) VALUES ($1,$2,$3,$4)`, [sampleId, userId, content, context]);
  return sampleId;
}

export async function listFeedback(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM feedback_samples WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({ id: String(row.id), content: String(row.content), context: String(row.context), createdAt: iso(row.created_at) }));
}

export async function insertPreference(db: Db, userId: string, statement: string, evidenceIds: string[]): Promise<string> {
  const ruleId = id();
  await db.query(`INSERT INTO preference_rules (id, user_id, statement, evidence_ids) VALUES ($1,$2,$3,$4::jsonb)`, [ruleId, userId, statement, JSON.stringify(evidenceIds)]);
  await logAction(db, userId, { what: "preference recorded", why: statement, source: "reflection", payload: { ruleId, evidenceIds } });
  return ruleId;
}

export async function listPreferences(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM preference_rules WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({ id: String(row.id), statement: String(row.statement), evidenceIds: asJson<string[]>(row.evidence_ids, []), createdAt: iso(row.created_at) }));
}

export async function insertPicture(db: Db, userId: string, statement: string, evidenceNoteIds: string[]): Promise<void> {
  await db.query(`INSERT INTO picture_statements (id, user_id, statement, evidence_note_ids) VALUES ($1,$2,$3,$4::jsonb)`, [id(), userId, statement, JSON.stringify(evidenceNoteIds)]);
}

export async function listPicture(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM picture_statements WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({ id: String(row.id), statement: String(row.statement), evidenceNoteIds: asJson<string[]>(row.evidence_note_ids, []), createdAt: iso(row.created_at) }));
}

export async function insertBrief(db: Db, userId: string, content: string, why: string): Promise<string> {
  const briefId = id();
  await db.query(`INSERT INTO briefs (id, user_id, content, why) VALUES ($1,$2,$3,$4)`, [briefId, userId, content, why]);
  await logAction(db, userId, { what: "brief written", why, source: "conversation", payload: { briefId } });
  return briefId;
}

export async function listBriefs(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM briefs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  return result.rows.map((row) => ({ id: String(row.id), content: String(row.content), why: String(row.why), createdAt: iso(row.created_at) }));
}

export async function insertDiscovery(db: Db, userId: string, card: { title: string; finding: string; sourceIds: string[] }): Promise<string> {
  const cardId = id();
  await db.query(`INSERT INTO discovery_cards (id, user_id, title, finding, source_ids) VALUES ($1,$2,$3,$4,$5::jsonb)`, [
    cardId,
    userId,
    card.title,
    card.finding,
    JSON.stringify(card.sourceIds),
  ]);
  await logAction(db, userId, { what: `discovery: ${card.title}`, why: "Research stored a finding and its sources.", source: "research", payload: { cardId } });
  return cardId;
}

export async function listDiscovery(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM discovery_cards WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    finding: String(row.finding),
    sourceIds: asJson<string[]>(row.source_ids, []),
    followed: row.followed === true || row.followed === "t",
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    createdAt: iso(row.created_at),
  }));
}

export async function followDiscovery(db: Db, userId: string, cardId: string, conversationId: string): Promise<void> {
  await db.query(`UPDATE discovery_cards SET followed = true, conversation_id = $3 WHERE id = $1 AND user_id = $2`, [cardId, userId, conversationId]);
  await db.query(`UPDATE conversations SET discovery_card_id = $2 WHERE id = $1`, [conversationId, cardId]);
}

export async function insertOutreach(db: Db, userId: string, draft: { kind: string; draft: string; recipient: string }): Promise<string> {
  const outreachId = id();
  await db.query(`INSERT INTO outreach_requests (id, user_id, kind, draft, recipient, status, explicit_yes) VALUES ($1,$2,$3,$4,$5,'draft',false)`, [
    outreachId,
    userId,
    draft.kind,
    draft.draft,
    draft.recipient,
  ]);
  await logAction(db, userId, { what: "draft stored", why: "Drafting is allowed. Sending is not.", source: "duties", payload: { outreachId } });
  return outreachId;
}

export async function listOutreach(db: Db, userId: string): Promise<Row[]> {
  const result = await db.query(`SELECT * FROM outreach_requests WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    draft: String(row.draft),
    recipient: String(row.recipient),
    status: String(row.status),
    explicitYes: row.explicit_yes === true || row.explicit_yes === "t",
    createdAt: iso(row.created_at),
  }));
}

export async function insertRecording(db: Db, userId: string, row: { transcript: string; mime?: string; byteSize?: number; path?: string; messageId?: string }): Promise<string> {
  const recordingId = id();
  await db.query(`INSERT INTO recordings (id, user_id, message_id, transcript, mime, byte_size, path) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    recordingId,
    userId,
    row.messageId ?? null,
    row.transcript,
    row.mime ?? null,
    row.byteSize ?? null,
    row.path ?? null,
  ]);
  return recordingId;
}

export async function getModule(db: Db, userId: string, key: string): Promise<Row | null> {
  const result = await db.query(`SELECT * FROM modules WHERE user_id = $1 AND key = $2`, [userId, key]);
  const row = result.rows[0];
  if (!row) return null;
  return { id: String(row.id), key: String(row.key), enabled: row.enabled === true || row.enabled === "t", config: asJson<Record<string, unknown>>(row.config, {}) };
}

export async function upsertModule(db: Db, userId: string, key: string, enabled: boolean, config: unknown): Promise<void> {
  const existing = await getModule(db, userId, key);
  if (!existing) {
    await db.query(`INSERT INTO modules (id, user_id, key, enabled, config) VALUES ($1,$2,$3,$4,$5::jsonb)`, [id(), userId, key, enabled, JSON.stringify(config ?? {})]);
    return;
  }
  await db.query(`UPDATE modules SET enabled=$3, config=$4::jsonb WHERE user_id=$1 AND key=$2`, [userId, key, enabled, JSON.stringify(config ?? {})]);
}
