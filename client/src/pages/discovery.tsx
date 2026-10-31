import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface CardItem { id: string; title: string; finding: string; sourceIds: string[]; followed: boolean; conversationId: string | null }
interface Source { id: string; title: string; url: string | null; excerpt: string; kind: string }

export function DiscoveryPage() {
  const [cards, setCards] = useState<CardItem[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [topic, setTopic] = useState("");
  const [bookmark, setBookmark] = useState({ title: "", url: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function reload() {
    const data = await api<{ cards: CardItem[]; sources: Source[] }>("/api/discovery");
    setCards(data.cards);
    setSources(data.sources);
  }

  useEffect(() => { reload().catch((err) => setError(err.message)); }, []);

  async function research(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ blocked: boolean; reason?: string }>("/api/research", { method: "POST", body: JSON.stringify({ topic }) });
      if (result.blocked) setError(`Search refused: ${result.reason}. Private details stay out of the web.`);
      setTopic("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed.");
    } finally {
      setBusy(false);
    }
  }

  async function follow(id: string) {
    const result = await api<{ conversationId: string }>(`/api/discovery/${id}/follow`, { method: "POST", body: "{}" });
    navigate(`/?c=${result.conversationId}`);
  }

  async function saveBookmark(event: React.FormEvent) {
    event.preventDefault();
    await api("/api/sources", { method: "POST", body: JSON.stringify({ title: bookmark.title, url: bookmark.url }) });
    setBookmark({ title: "", url: "" });
    await reload();
  }

  return (
    <div>
      <h1 className="font-serif text-4xl italic">Discovery</h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">Findings already done, with their sources. Nothing is scored before it is kept.</p>
      <form className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={research}>
        <Input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="What should it look up?" required />
        <Button type="submit" disabled={busy}>{busy ? "Looking…" : "Research"}</Button>
      </form>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {cards.length === 0 ? <p className="text-sm text-muted-foreground">The deck is empty. Ask for a search, or drop a bookmark below.</p> : null}
        {cards.map((card) => (
          <Card key={card.id} className="p-4">
            <div className="text-xs uppercase tracking-wide text-primary">{card.followed ? "Following" : "Finding"}</div>
            <h2 className="mt-1 font-serif text-2xl">{card.title}</h2>
            <p className="mt-2 text-sm leading-relaxed">{card.finding}</p>
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {sources.filter((source) => card.sourceIds.includes(source.id)).map((source) => (
                <li key={source.id}>{source.url ? <a className="underline" href={source.url}>{source.title}</a> : source.title}</li>
              ))}
            </ul>
            <Button className="mt-4" size="sm" variant="outline" onClick={() => void follow(card.id)}>Follow</Button>
          </Card>
        ))}
      </div>
      <form className="mt-8 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={saveBookmark}>
        <Input value={bookmark.title} onChange={(event) => setBookmark({ ...bookmark, title: event.target.value })} placeholder="Bookmark title" required />
        <Input value={bookmark.url} onChange={(event) => setBookmark({ ...bookmark, url: event.target.value })} placeholder="https://" />
        <Button type="submit" variant="secondary">Keep</Button>
      </form>
    </div>
  );
}
