import type { Db } from "../db.js";
import { listFolders, listNotes } from "../repo.js";
import type { Note, Settings } from "../types.js";

export async function loadVisibleNotes(db: Db, userId: string, settings: Settings): Promise<{ notes: Note[]; blockedBodies: string[] }> {
  const [notes, folders] = await Promise.all([listNotes(db, userId), listFolders(db, userId)]);
  const blockedNames = new Set(settings.localCategories.map((name) => name.toLowerCase()));
  const folderName = (folderId: string | null) => folders.find((folder) => folder.id === folderId)?.name.toLowerCase() ?? "";
  const blockedBodies = notes
    .filter((note) => note.type === "person" || blockedNames.has(folderName(note.folderId)))
    .map((note) => note.body);
  const visible = notes
    .filter((note) => note.status !== "archived")
    .filter((note) => !blockedNames.has(folderName(note.folderId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);
  return { notes: visible, blockedBodies };
}

export function renderNotes(notes: Note[]): string {
  if (notes.length === 0) return "";
  return notes.map((note) => `note:${note.id} (${note.type}, ${note.status}) ${note.title}\n${note.body}`).join("\n\n");
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/** Different evidence slices. Identical proposals are split round-robin by code. */
export function partitionEvidence(noteIds: string[], sideCount: number, proposed: string[][]): string[][] {
  const known = new Set(noteIds);
  const cleaned = proposed.map((ids) => [...new Set((ids ?? []).filter((item) => known.has(item)))]);
  while (cleaned.length < sideCount) cleaned.push([]);
  const slices = cleaned.slice(0, sideCount);
  const signature = (ids: string[]) => [...ids].sort().join(",");
  const distinct = new Set(slices.map(signature));
  const any = slices.some((ids) => ids.length > 0);
  if (distinct.size > 1 && any) return slices;
  if (noteIds.length === 0) return Array.from({ length: sideCount }, () => []);
  return Array.from({ length: sideCount }, (_, side) => noteIds.filter((_, index) => index % sideCount === side));
}

export function scrubArgument(text: string, secrets: string[]): string {
  let out = text.replace(/uncomfortable/gi, "");
  for (const secret of secrets) {
    if (secret.length > 1) out = out.split(secret).join("");
  }
  return out.trim();
}
