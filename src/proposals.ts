import { id } from "./ids.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { addSource } from "./web.js";
import { popup } from "./popups.js";
import { bump, db, wake } from "./state.js";

/**
 * Proposals (IDEA.md): it may write as many as it likes, a description of what and why for a start. They pop up in any
 * window; the proposals tab is an overview. He can accept, revise (type into it) or decline. If he wants it dropped
 * completely he says why, and that goes into the web. It may always revisit an idea. Its own projects only start from
 * an accepted proposal.
 */

export interface Proposal { id: string; kind: string; title: string; body: string; status: string; why: string; project_id: string | null; created_at: string; decided_at: string | null }

export async function createProposal(p: { title: string; body: string; kind?: string }): Promise<string> {
  if (!p.title.trim() || !p.body.trim()) throw new ValidationError("A proposal needs a title and a description.");
  const proposalId = id();
  await db().query(`INSERT INTO proposals (id, kind, title, body) VALUES ($1,$2,$3,$4)`, [proposalId, p.kind ?? "project", p.title.trim().slice(0, 300), p.body.trim()]);
  const sourceId = await addSource({ kind: "proposal", origin: "self", title: `Proposal: ${p.title.trim().slice(0, 200)}`, text: p.body.trim() });
  void sourceId;
  await popup("proposal", p.title.trim(), p.body.trim(), proposalId);
  bump();
  return proposalId;
}

export async function getProposal(proposalId: string): Promise<Proposal> {
  const r = await db().query<Proposal>(`SELECT * FROM proposals WHERE id = $1`, [proposalId]);
  if (!r.rows[0]) throw new NotFoundError("No such proposal.");
  return r.rows[0];
}

export async function listProposals(): Promise<Proposal[]> {
  const r = await db().query<Proposal>(`SELECT * FROM proposals ORDER BY (status = 'open') DESC, created_at DESC LIMIT 300`);
  return r.rows;
}

/** He typed into it: the new text, kept as his words. */
export async function reviseProposal(proposalId: string, body: string, title?: string): Promise<void> {
  const p = await getProposal(proposalId);
  if (p.status !== "open") throw new ValidationError("This proposal is already decided.");
  if (!body.trim()) throw new ValidationError("The proposal can't be empty.");
  await db().query(`UPDATE proposals SET body = $2, title = $3 WHERE id = $1`, [proposalId, body.trim(), (title ?? p.title).trim().slice(0, 300) || p.title]);
  await addSource({ kind: "proposal", origin: "isaak", title: `Isaak revised the proposal "${p.title}"`, text: body.trim() });
  bump();
}

export async function acceptProposal(proposalId: string, body?: string): Promise<string> {
  if (body?.trim()) await reviseProposal(proposalId, body);
  const p = await getProposal(proposalId);
  if (p.status !== "open") throw new ValidationError("This proposal is already decided.");
  const { createProject } = await import("./projects.js");
  const projectId = await createProject({ title: p.title, owner: "it", goal: p.body, proposalId });
  await db().query(`UPDATE proposals SET status = 'accepted', decided_at = now(), project_id = $2 WHERE id = $1`, [proposalId, projectId]);
  await addSource({ kind: "proposal", origin: "isaak", title: `Isaak accepted the proposal "${p.title}"`, text: `Isaak accepted this proposal:\n${p.body}`, projectId });
  await db().query(`UPDATE popups SET seen = true WHERE ref_id = $1`, [proposalId]);
  bump();
  wake();
  return projectId;
}

/** Decline; "drop" = drop it completely, which needs his reason (that reason is data for it, so it goes into the web). */
export async function declineProposal(proposalId: string, why: string, drop = false): Promise<void> {
  const p = await getProposal(proposalId);
  if (p.status !== "open") throw new ValidationError("This proposal is already decided.");
  if (drop && !why.trim()) throw new ValidationError("To drop it completely, say why: that reason goes into its memory.");
  await db().query(`UPDATE proposals SET status = $2, why = $3, decided_at = now() WHERE id = $1`, [proposalId, drop ? "dropped" : "declined", why.trim()]);
  await addSource({ kind: "decline", origin: "isaak", title: `Isaak ${drop ? "dropped" : "declined"} the proposal "${p.title}"`,
    text: `Isaak ${drop ? "dropped completely" : "declined"} this proposal${why.trim() ? `, because: ${why.trim()}` : " (no reason given)"}.\n\nThe proposal was:\n${p.body}` });
  await db().query(`UPDATE popups SET seen = true WHERE ref_id = $1`, [proposalId]);
  bump();
}
