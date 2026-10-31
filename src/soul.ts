import { BoundaryError } from "./errors.js";
import type { Db } from "./db.js";
import { getSoul, insertSoulVersion, listSoulVersions, logAction } from "./repo.js";
import type { SoulVersion } from "./types.js";

const ALLOWED = new Set(["reflection", "user", "seed"]);

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
