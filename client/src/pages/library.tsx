import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { when } from "@/lib/utils";

interface Folder { id: string; name: string; parentId: string | null; archivedAt: string | null }
interface Note {
  id: string; folderId: string | null; type: string; title: string; body: string; status: string;
  forNowExpiresAt: string | null; currentVersion: number; updatedAt: string; mockEra?: boolean;
}
interface Version { id: string; version: number; title: string; body: string; status: string; reason: string; createdAt: string }

const filters = ["all", "unexplored", "for_now", "archived"] as const;

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ title: "", body: "", type: "idea", folder: "Inbox" });
  const selected = params.get("note");

  async function reload() {
    const [nextFolders, nextNotes] = await Promise.all([api<Folder[]>("/api/folders"), api<Note[]>("/api/notes")]);
    setFolders(nextFolders.filter((folder) => !folder.archivedAt));
    setNotes(nextNotes);
  }

  useEffect(() => { reload().catch((err) => setError(err.message)); }, []);

  useEffect(() => {
    if (!selected) return;
    api<{ note: Note; versions: Version[] }>(`/api/notes/${selected}`).then((data) => {
      setVersions(data.versions);
      const folder = folders.find((item) => item.id === data.note.folderId);
      setDraft({ title: data.note.title, body: data.note.body, type: data.note.type, folder: folder?.name || "Inbox" });
    }).catch((err) => setError(err.message));
  }, [selected, folders.length]);

  const visible = useMemo(() => notes.filter((note) => {
    if (folderId && note.folderId !== folderId) return false;
    if (filter === "all") return note.status !== "archived";
    return note.status === filter;
  }), [notes, folderId, filter]);

  const note = notes.find((item) => item.id === selected);

  async function act(path: string, body?: unknown) {
    setError("");
    try {
      await api(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
    }
  }

  async function upload(file: File) {
    const form = new FormData();
    form.set("file", file);
    setError("");
    try {
      const result = await api<{ note: Note }>("/api/ingest", { method: "POST", body: form });
      await reload();
      setParams({ note: result.note.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl italic">Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">Folders, then notes. Each click narrows. Nothing is deleted.</p>
        </div>
        <label className="cursor-pointer text-sm text-primary">
          Import PDF or Word
          <input className="hidden" type="file" accept=".pdf,.docx,.txt,.md" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        </label>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-6 grid gap-6 lg:grid-cols-[180px_240px_1fr]">
        <div className="space-y-1">
          <button className={`block w-full rounded-md px-2 py-1 text-left text-sm ${folderId === null ? "text-primary" : "text-muted-foreground"}`} onClick={() => setFolderId(null)}>All folders</button>
          {folders.map((folder) => (
            <button key={folder.id} className={`block w-full rounded-md px-2 py-1 text-left text-sm ${folderId === folder.id ? "text-primary" : "text-muted-foreground"}`} onClick={() => setFolderId(folder.id)}>
              {folder.name}
            </button>
          ))}
        </div>
        <div>
          <div className="mb-3 flex flex-wrap gap-1">
            {filters.map((item) => (
              <button key={item} className={`rounded-full px-2 py-1 text-xs ${filter === item ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setFilter(item)}>{item.replace("_", " ")}</button>
            ))}
          </div>
          {visible.length === 0 ? <p className="text-sm text-muted-foreground">Nothing in this slice. Dump something in the chat.</p> : null}
          <div className="space-y-2">
            {visible.map((item) => (
              <button key={item.id} className={`block w-full rounded-lg border px-3 py-2 text-left ${item.id === selected ? "border-primary" : "border-border"}`} onClick={() => setParams({ note: item.id })}>
                <div className="text-sm">{item.title}</div>
                <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{item.type} · {item.status}{item.mockEra ? " · mock" : ""}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          {!note ? <p className="text-sm text-muted-foreground">Choose a note to read its versions and undo.</p> : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge>{note.status}</Badge>
                {note.mockEra ? <Badge>mock</Badge> : null}
                <Badge>v{note.currentVersion}</Badge>
                {note.forNowExpiresAt ? <Badge>until {when(note.forNowExpiresAt)}</Badge> : null}
              </div>
              <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <Textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} className="min-h-[180px]" />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => act(`/api/notes/${note.id}`, draft)}>Save edit</Button>
                <Button variant="outline" onClick={() => act(`/api/notes/${note.id}/respond`, { stance: "yes" })}>Yes</Button>
                <Button variant="outline" onClick={() => act(`/api/notes/${note.id}/respond`, { stance: "no" })}>No</Button>
                <Button variant="outline" onClick={() => act(`/api/notes/${note.id}/undo`)}>Undo</Button>
                <Button variant="ghost" onClick={() => act(`/api/notes/${note.id}/archive`, { why: "Archived from the library." })}>Archive</Button>
                <a className="inline-flex h-10 items-center text-sm text-primary" href={`/api/notes/${note.id}/docx`}>Word</a>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Versions</div>
                <ul className="mt-2 space-y-2">
                  {versions.map((version) => (
                    <li key={version.id} className="rounded-md border border-border px-3 py-2 text-sm">
                      <div className="font-mono text-xs text-muted-foreground">v{version.version} · {when(version.createdAt)} · {version.status}</div>
                      <div className="mt-1">{version.reason}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
