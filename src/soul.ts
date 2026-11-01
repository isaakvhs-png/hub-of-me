import { BoundaryError } from "./errors.js";
import type { Db } from "./db.js";
import { getSoul, insertSoulVersion, listSoulVersions, listUsers, logAction } from "./repo.js";
import type { SoulVersion } from "./types.js";

const ALLOWED = new Set(["reflection", "user", "seed", "repair", "fresh"]);

export const REQUIRED_SOUL_HEADINGS = ["Purpose", "Values", "Boundaries"] as const;

/** A hint for reflection when character is turning into instructions. Not a veto by itself. */
export function ruleListHint(content: string): string | null {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => /^(?:[-*]|\d+\.)?\s*(always|never|do not|don't|must|you should)\b/i.test(line));
  if (lines.length < 6) return null;
  return "Character is starting to read as a list of rules. Consolidate it into a few principles, each traceable to a real moment.";
}

export function soulHeadings(content: string): string[] {
  return [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
}

export function missingSoulSections(content: string): string[] {
  const have = new Set(soulHeadings(content));
  return REQUIRED_SOUL_HEADINGS.filter((heading) => !have.has(heading));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace or append named sections. The rest of the document stays. */
export function mergeSoulSections(current: string, edits: { heading: string; body: string }[]): string {
  let doc = `${current.trimEnd()}\n`;
  for (const edit of edits) {
    const heading = edit.heading.trim();
    const body = edit.body.trim();
    const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
    if (!pattern.test(doc)) {
      doc = `${doc.trimEnd()}\n\n## ${heading}\n${body}\n`;
      continue;
    }
    const lines = doc.split("\n");
    const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`).test(line));
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    const next = [...lines.slice(0, start + 1), body, "", ...lines.slice(end)];
    doc = next.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return `${doc.trim()}\n`;
}

export async function changeSoul(
  db: Db,
  userId: string,
  input: { content: string; reason: string; via: string; causingMessageId?: string | null },
): Promise<SoulVersion> {
  if (!ALLOWED.has(input.via)) {
    throw new BoundaryError("The soul changes only through reflection, or an explicit correction by you.");
  }
  const current = await getSoul(db, userId);
  if (input.via === "seed" && current) {
    throw new BoundaryError("The opening soul is only written once.");
  }
  if (!input.reason.trim() || !input.content.trim()) {
    throw new BoundaryError("A soul change needs content and a reason.");
  }
  const missing = missingSoulSections(input.content);
  if (missing.length > 0) {
    throw new BoundaryError(`A soul update cannot drop required sections: ${missing.join(", ")}.`);
  }
  const saved = await insertSoulVersion(db, {
    userId,
    version: (current?.version ?? 0) + 1,
    content: input.content,
    reason: input.reason,
    causingMessageId: input.causingMessageId ?? null,
    createdByRole: input.via,
  });
  await logAction(db, userId, {
    what: `soul version ${saved.version}`,
    why: input.reason,
    source: input.via,
    payload: { version: saved.version },
  });
  return saved;
}

export function sectionBody(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`).test(line));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

const CURIOSITY = "Curiosity is a core value. Understand him before steering him. What is not yet understood is something to explore, not a gap to paper over.";

/** One soul edit for installs that predate curiosity. No-op once the word is already there. */
export async function ensureCuriosity(db: Db): Promise<number> {
  const users = await listUsers(db);
  let edited = 0;
  for (const user of users) {
    const soul = await getSoul(db, user.id);
    if (!soul || /curiosity/i.test(soul.content)) continue;
    const heading = sectionBody(soul.content, "Values") ? "Values" : sectionBody(soul.content, "Values and long-term direction") ? "Values and long-term direction" : "Values";
    const existing = sectionBody(soul.content, heading);
    const body = existing ? `${existing}\n\n${CURIOSITY}` : CURIOSITY;
    await changeSoul(db, user.id, {
      content: mergeSoulSections(soul.content, [{ heading, body }]),
      reason: "Curiosity is a core value of how this system understands him.",
      via: "repair",
    });
    edited += 1;
  }
  return edited;
}

/** If the current soul is missing required sections, append a new version with version 1's text. */
export async function restoreCorruptedSouls(db: Db): Promise<number> {
  const users = await listUsers(db);
  let restored = 0;
  for (const user of users) {
    const current = await getSoul(db, user.id);
    if (!current || missingSoulSections(current.content).length === 0) continue;
    const versions = await listSoulVersions(db, user.id);
    const original = versions.find((version) => version.version === 1);
    if (!original || missingSoulSections(original.content).length > 0) continue;
    await changeSoul(db, user.id, {
      content: original.content,
      reason: "Restored after mock-era overwrite",
      via: "repair",
    });
    restored += 1;
  }
  return restored;
}

export async function undoSoul(db: Db, userId: string): Promise<SoulVersion> {
  const versions = await listSoulVersions(db, userId);
  const previous = versions[1];
  if (!previous) throw new BoundaryError("There is no earlier soul to restore.");
  return changeSoul(db, userId, {
    content: previous.content,
    reason: `Undo to soul version ${previous.version}.`,
    via: "user",
  });
}
