import { ValidationError } from "./errors.js";

/**
 * A board: Lego pieces and arrows (IDEA.md). Pieces are only ever things defined beforehand: context packs, models,
 * modules, "me" (the need-input element) and result pieces. It cannot make up pieces on the spot.
 *
 * Arrows from a model carry that model's step numbers: "arrows show how a model moves, what it does, in what sequence".
 * An arrow from a context pack into a model gives the model that pack. Converging lines mean: wait for both inputs
 * to finish before continuing.
 */

export type PieceType = "pack" | "model" | "module" | "me" | "result";

export interface Piece { id: string; type: PieceType; ref: string; label: string; x: number; y: number; instructions?: string; version?: "current" | "snapshot" }
export interface Arrow { id: string; from: string; to: string; step?: number }
export interface Board { pieces: Piece[]; arrows: Arrow[]; runInstructions: string }

export interface ModuleDef { name: string; title: string; description: string }

export const MODULES: ModuleDef[] = [
  {
    name: "web-search",
    title: "Web search",
    description: "Searches the web. For now this is the model's own built-in web search (Claude's or Gemini's): the model gets its context and instructions, searches, and returns what it found with the pages it used. It gets better as we build onto it.",
  },
];

export const emptyBoard = (): Board => ({ pieces: [{ id: "me", type: "me", ref: "me", label: "Isaak", x: 80, y: 80 }], arrows: [], runInstructions: "" });

export function parseBoard(raw: string | null | undefined): Board {
  if (!raw) return emptyBoard();
  try {
    const b = JSON.parse(raw) as Partial<Board>;
    return { pieces: Array.isArray(b.pieces) ? b.pieces : [], arrows: Array.isArray(b.arrows) ? b.arrows : [], runInstructions: String(b.runInstructions ?? "") };
  } catch { return emptyBoard(); }
}

/** Keeps a board honest: only known kinds of pieces, arrows between pieces that exist, "me" always there. */
export function cleanBoard(input: unknown, known: { packs: Set<string>; models: Set<string>; runs: Set<string> }): Board {
  const b = (input ?? {}) as Partial<Board>;
  const pieces: Piece[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(b.pieces) ? b.pieces : []) {
    const p = raw as Partial<Piece>;
    const type = p.type as PieceType;
    const ref = String(p.ref ?? "");
    if (!["pack", "model", "module", "me", "result"].includes(type)) continue;
    if (type === "pack" && !known.packs.has(ref)) continue;
    if (type === "model" && !known.models.has(ref)) continue;
    if (type === "module" && !MODULES.some((m) => m.name === ref)) continue;
    if (type === "result" && !known.runs.has(ref)) continue;
    const pid = String(p.id ?? "").trim() || `${type}-${pieces.length + 1}`;
    if (ids.has(pid)) continue;
    ids.add(pid);
    pieces.push({ id: pid, type, ref: type === "me" ? "me" : ref, label: String(p.label ?? ref).slice(0, 120), x: num(p.x, 80 + pieces.length * 40), y: num(p.y, 80 + pieces.length * 30), ...(p.instructions ? { instructions: String(p.instructions).slice(0, 8000) } : {}), ...(type === "pack" && p.version === "snapshot" ? { version: "snapshot" as const } : {}) });
  }
  if (!pieces.some((p) => p.type === "me")) pieces.unshift({ id: "me", type: "me", ref: "me", label: "Isaak", x: 80, y: 80 });
  const arrows: Arrow[] = [];
  for (const raw of Array.isArray(b.arrows) ? b.arrows : []) {
    const a = raw as Partial<Arrow>;
    const from = String(a.from ?? ""); const to = String(a.to ?? "");
    if (!ids.has(from) && !(from === "me" && pieces.some((p) => p.id === "me"))) continue;
    if (!pieces.some((p) => p.id === to) || from === to) continue;
    arrows.push({ id: String(a.id ?? `a${arrows.length + 1}`), from, to, ...(a.step != null && Number.isFinite(Number(a.step)) ? { step: Number(a.step) } : {}) });
  }
  return { pieces, arrows, runInstructions: String(b.runInstructions ?? "").slice(0, 20000) };
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(4000, n)) : fallback;
}

export function validateRunnable(board: Board): void {
  if (!board.pieces.some((p) => p.type === "model")) throw new ValidationError("There is no model on the board to run.");
  // Models that hand to each other in a circle would each wait for the other forever.
  const models = new Set(board.pieces.filter((p) => p.type === "model").map((p) => p.id));
  const next = new Map<string, string[]>();
  for (const a of board.arrows) if (models.has(a.from) && models.has(a.to)) (next.get(a.from) ?? next.set(a.from, []).get(a.from)!).push(a.to);
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const m of next.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  for (const m of models) if (visit(m)) throw new ValidationError("Some models hand their work to each other in a circle, so each would wait for the other forever. Break the circle and try again.");
}

/** A short text picture of a board, for the models. */
export function describeBoard(board: Board): string {
  const lines = board.pieces.map((p) => `- piece ${p.id}: ${p.type} ${p.type === "me" ? "(Isaak: the need-input element)" : p.ref}${p.label && p.label !== p.ref ? ` "${p.label}"` : ""}${p.instructions ? ` — instructions: ${p.instructions.slice(0, 400)}` : ""}`);
  const arrows = board.arrows.map((a) => `- arrow ${a.from} → ${a.to}${a.step != null ? ` (step ${a.step})` : ""}`);
  return `PIECES:\n${lines.join("\n") || "(none)"}\nARROWS:\n${arrows.join("\n") || "(none)"}\nINSTRUCTIONS FOR THE WHOLE RUN: ${board.runInstructions || "(none)"}`;
}
