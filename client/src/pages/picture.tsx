import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { isFresh } from "@/lib/seen";

interface Claim { id: string; statement: string; situations: string; status: string; updatedAt: string; evidence: { quote: string; source: string }[] }
interface Reaction { id: string; prediction: string; outcome: string | null; score: string | null; subjectKind: string }
type Mind = { id: string; content: string; createdAt: string } | null
interface Ask { id: string; subject: string; question: string; context: string; why: string; rank: number | null; debateId: string | null; createdAt: string }

export function PicturePage() {
  const [data, setData] = useState<{ claims: Claim[]; reactions: Reaction[]; mind: Mind; seen: string | null; asks: Ask[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<NonNullable<typeof data>>("/api/picture")
      .then((next) => {
        setData(next);
        api("/api/seen", { method: "POST", body: JSON.stringify({ surface: "picture" }) }).catch(() => undefined);
      })
      .catch((err) => setError(err.message));
  }, []);
  if (!data) return <p className="text-sm text-muted-foreground">{error || "Opening the picture…"}</p>;
  return (
    <div className="max-w-2xl">
      <h1 className="font-serif text-4xl italic">Picture of you</h1>
      <p className="mt-2 text-sm text-muted-foreground">Claims about how you think, with your words kept as evidence. Predictions are scored when you respond.</p>
      {data.mind ? (
        <Card className="mt-6 p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Mind note</div>
          <p className="mt-2 whitespace-pre-wrap">{data.mind.content}</p>
        </Card>
      ) : null}
      <div className="mt-6 space-y-4">
        {data.claims.length === 0 ? <p className="text-sm text-muted-foreground">No claims yet. New ground stays tentative until there is evidence.</p> : null}
        {data.claims.map((claim) => {
          const fresh = isFresh(data.seen, claim.updatedAt);
          const source = claim.evidence[0]?.source;
          return (
            <Card key={claim.id} className={`p-4 ${fresh ? "border-primary" : ""}`}>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {claim.status}
                {fresh ? ` · new${source ? ` · from a ${source}` : ""}` : ""}
                {claim.situations ? ` · ${claim.situations}` : ""}
              </div>
              <p className="mt-1">{claim.statement}</p>
              {claim.evidence.map((item, index) => (
                <blockquote key={index} className="mt-2 border-l-2 border-border pl-3 text-sm text-muted-foreground">“{item.quote}” <span className="uppercase">{item.source}</span></blockquote>
              ))}
            </Card>
          );
        })}
      </div>
      <h2 className="mt-8 font-serif text-2xl">Open questions</h2>
      <div className="mt-3 space-y-3">
        {data.asks.length === 0 ? <p className="text-sm text-muted-foreground">None open. Gaps turn into asks when reflection finds them.</p> : null}
        {data.asks.map((ask, index) => (
          <Card key={ask.id} className={`p-4 ${isFresh(data.seen, ask.createdAt) ? "border-primary" : ""}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{ask.rank != null ? `${ask.rank + 1}. ` : `${index + 1}. `}{ask.subject}{isFresh(data.seen, ask.createdAt) ? " · new · from a debate" : ""}</div>
            <p className="mt-1">{ask.question}</p>
            {ask.context ? <p className="mt-1 text-sm text-muted-foreground">{ask.context}</p> : null}
          </Card>
        ))}
      </div>
      <h2 className="mt-8 font-serif text-2xl">Predictions</h2>
      <div className="mt-3 space-y-2">
        {data.reactions.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : null}
        {data.reactions.map((item) => (
          <p key={item.id} className="text-sm">{item.score ?? "unscored"} · {item.prediction}{item.outcome ? ` — you: ${item.outcome}` : ""}</p>
        ))}
      </div>
      <p className="mt-6 text-sm"><Link className="text-primary" to="/asks">Answer an open question</Link></p>
    </div>
  );
}
