import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { isFresh } from "@/lib/seen";

interface Region { name: string; known?: string; open?: string }
interface Version { kind: string; content: string; why: string; createdAt: string }
interface Ask { id: string; subject: string; question: string; context: string; why: string; rank: number | null; createdAt: string }
interface Understanding { portrait: string; map: Region[]; intentions: string; versions: Version[]; seen: string | null; asks: Ask[] }

/** Its understanding of him, in its own words: the portrait, the map of his life, and what it is going for. */
export function PicturePage() {
  const [data, setData] = useState<Understanding | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState(false);
  useEffect(() => {
    api<Understanding>("/api/picture")
      .then((next) => {
        setData(next);
        api("/api/seen", { method: "POST", body: JSON.stringify({ surface: "picture" }) }).catch(() => undefined);
      })
      .catch((err) => setError(err.message));
  }, []);
  if (!data) return <p className="text-sm text-muted-foreground">{error || "Opening its understanding of you…"}</p>;
  return (
    <div className="max-w-2xl">
      <h1 className="font-serif text-4xl italic">How it sees you</h1>
      <p className="mt-2 text-sm text-muted-foreground">Its own words, rewritten as it learns. Older versions are kept below.</p>

      <h2 className="mt-8 font-serif text-2xl">Portrait</h2>
      <Card className="mt-3 p-4">
        <p className="whitespace-pre-wrap">{data.portrait || "Not written yet."}</p>
      </Card>

      <h2 className="mt-8 font-serif text-2xl">The territory of your life</h2>
      <div className="mt-3 space-y-3">
        {data.map.length === 0 ? <p className="text-sm text-muted-foreground">Not drawn yet.</p> : null}
        {data.map.map((region) => (
          <Card key={region.name} className="p-4">
            <div className="text-lg">{region.name}</div>
            <p className="mt-1 text-sm"><span className="text-muted-foreground">Knows: </span>{region.known || "nothing yet"}</p>
            <p className="mt-1 text-sm"><span className="text-muted-foreground">Not seen yet: </span>{region.open || "?"}</p>
          </Card>
        ))}
      </div>

      <h2 className="mt-8 font-serif text-2xl">What it is going for</h2>
      <Card className="mt-3 p-4">
        <p className="whitespace-pre-wrap">{data.intentions || "No intentions yet."}</p>
      </Card>

      <h2 className="mt-8 font-serif text-2xl">Questions it holds for you</h2>
      <div className="mt-3 space-y-3">
        {data.asks.length === 0 ? <p className="text-sm text-muted-foreground">None open.</p> : null}
        {data.asks.map((ask) => (
          <Card key={ask.id} className={`p-4 ${isFresh(data.seen, ask.createdAt) ? "border-primary" : ""}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{ask.subject}</div>
            <p className="mt-1">{ask.question}</p>
            {ask.context ? <p className="mt-1 text-sm text-muted-foreground">{ask.context}</p> : null}
          </Card>
        ))}
      </div>
      <p className="mt-4 text-sm"><Link className="text-primary" to="/asks">Answer an open question</Link></p>

      <button className="mt-8 text-sm text-primary" onClick={() => setHistory((value) => !value)}>
        {history ? "Hide" : "Show"} how this changed ({data.versions.length} versions)
      </button>
      {history ? (
        <div className="mt-3 space-y-3">
          {data.versions.map((version, index) => (
            <Card key={index} className="p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {version.kind} · {new Date(version.createdAt).toLocaleString()} · {version.why}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{version.content}</p>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
