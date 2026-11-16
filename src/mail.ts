import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "./state.js";
import { addSource } from "./web.js";
import { readUpload } from "./ingest.js";

/**
 * The Gmail inbox (Isaak, 16 Nov): he forwards emails to a Gmail account; it reads that inbox over IMAP with an app
 * password (GMAIL_ADDRESS, GMAIL_APP_PASSWORD). Each email is one file in the web (his decision: emails are files, like
 * an upload); each attachment is its own file, linked to its email and stored whole even when it can't be read yet.
 * Read only: it sends nothing.
 */

const KEY_UID = "gmail:last-uid";
const KEY_VALIDITY = "gmail:uid-validity";
const KEY_CHECKED = "gmail:last-check";
const KEY_ERROR = "gmail:last-error";

export function mailAccount(): { user: string; pass: string } | null {
  const user = process.env.GMAIL_ADDRESS?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  return user && pass ? { user, pass } : null;
}

async function getMeta(key: string): Promise<string | null> {
  return (await db().query<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [key])).rows[0]?.value ?? null;
}
async function setMeta(key: string, value: string): Promise<void> {
  await db().query(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

export async function mailStatus() {
  const acc = mailAccount();
  const count = Number((await db().query<{ n: string }>(`SELECT count(*) AS n FROM sources WHERE kind = 'email'`)).rows[0]?.n ?? 0);
  return { configured: Boolean(acc), address: acc?.user ?? null, lastCheck: await getMeta(KEY_CHECKED), lastError: await getMeta(KEY_ERROR), emails: count };
}

let checking = false;

/** Reads every email it hasn't read yet. Returns how many came in. */
export async function checkMail(): Promise<number> {
  const acc = mailAccount();
  if (!acc || checking) return 0;
  checking = true;
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: acc, logger: false });
  let n = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const validity = String((client.mailbox as { uidValidity?: bigint | number } | false) ? (client.mailbox as { uidValidity?: bigint | number }).uidValidity ?? "" : "");
      if ((await getMeta(KEY_VALIDITY)) !== validity) { await setMeta(KEY_VALIDITY, validity); await setMeta(KEY_UID, "0"); }
      const last = Number((await getMeta(KEY_UID)) ?? 0);
      const found: { uid: number; source: Buffer }[] = [];
      for await (const msg of client.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid > last && msg.source) found.push({ uid: msg.uid, source: msg.source });
      }
      found.sort((a, b) => a.uid - b.uid);
      for (const m of found) {
        await storeEmail(m.source);
        await setMeta(KEY_UID, String(m.uid));
        n += 1;
      }
    } finally { lock.release(); }
    await client.logout();
    await setMeta(KEY_ERROR, "");
  } catch (error) {
    await setMeta(KEY_ERROR, String((error as Error).message ?? error).slice(0, 500));
    try { client.close(); } catch { /* already closed */ }
  } finally {
    await setMeta(KEY_CHECKED, new Date().toISOString());
    checking = false;
  }
  return n;
}

/** One email as a file; its attachments as files of their own; an email forwarded as an attachment as an email of its own. */
export async function storeEmail(raw: Buffer, partOf: string | null = null): Promise<string> {
  const mail: ParsedMail = await simpleParser(raw);
  const subject = mail.subject?.trim() || "(no subject)";
  const addr = (a: ParsedMail["from"] | ParsedMail["to"]) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a?.text ?? "");
  const bodyText = (mail.text || (typeof mail.html === "string" ? mail.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ") : "")).trim();
  const files = (mail.attachments ?? []).filter((a) => !a.related);
  const head = [`From: ${addr(mail.from)}`, `To: ${addr(mail.to)}`, mail.cc ? `Cc: ${addr(mail.cc)}` : "", `Date: ${mail.date?.toISOString() ?? "unknown"}`, `Subject: ${subject}`].filter(Boolean).join("\n");
  const emailId = await addSource({
    kind: "email", origin: "isaak", title: subject,
    text: `${head}\n\n${bodyText}${files.length ? `\n\nAttachments: ${files.map((a) => a.filename ?? a.contentType).join(", ")}` : ""}`,
    fileName: `${subject.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)}.eml`, mime: "message/rfc822", bytes: raw, readable: true,
  });
  if (partOf) await db().query(`UPDATE sources SET part_of = $2 WHERE id = $1`, [emailId, partOf]);
  for (const a of files) {
    if (a.contentType === "message/rfc822") { await storeEmail(a.content, emailId); continue; }
    const name = a.filename || `attachment.${(a.contentType.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "")}`;
    const read = await readUpload(name, a.content).catch(() => ({ text: "", readable: false, mime: a.contentType }));
    const fileId = await addSource({ kind: "file", origin: "isaak", title: `${name} (attached to the email "${subject}")`, text: read.text, fileName: name, mime: read.mime || a.contentType, bytes: a.content, readable: read.readable });
    await db().query(`UPDATE sources SET part_of = $2 WHERE id = $1`, [fileId, emailId]);
  }
  return emailId;
}

/** Checks the inbox on start and every few minutes. */
export function startMail(): () => void {
  if (!mailAccount()) return () => {};
  void checkMail();
  const t = setInterval(() => { void checkMail(); }, 3 * 60_000);
  return () => clearInterval(t);
}
