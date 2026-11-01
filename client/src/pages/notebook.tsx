import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";

interface ToolRow { name: string; description: string; uses: number }
interface Wish { name: string; reason: string }

export function NotebookPage() {
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [wishes, setWishes] = useState<Wish[]>([]);
  const [history, setHistory] = useState<{ id: string; title: string }[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ tools: ToolRow[]; wishes: Wish[] }>("/api/tools").then((data) => { setTools(data.tools); setWishes(data.wishes); }).catch((err) => setError(err.message));
    api<{ id: string; title: string }[]>("/api/conversations?history=1").then(setHistory).catch(() => setHistory([]));
  }, []);
  const sections = [
    { href: "/picture", title: "Picture of you", text: "Claims, evidence, predictions, and open questions." },
    { href: "/soul", title: "Soul", text: "Purpose, values, boundaries, and the character that has grown." },
    { href: "/library", title: "Life threads and library", text: "Notes, including what has been archived." },
    { href: "/todos", title: "To-do ledger", text: "What is worth raising, and the quiet rest." },
    { href: "/debates", title: "Debates and thinking", text: "Arguments it chose to have, including ones set aside." },
    { href: "/why", title: "Change history", text: "What changed, and why." },
    { href: "/discovery", title: "Research", text: "What it looked up, with the sources it kept." },
  ];
  return (
    <div className="max-w-3xl">
      <h1 className="font-serif text-4xl italic">Notebook</h1>
      <p className="mt-2 text-sm text-muted-foreground">The records it can read. Archived rows stay here. Nothing in this list is deleted.</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} to={section.href} className="rounded-xl border border-border p-4 hover:border-primary">
            <div className="font-serif text-2xl">{section.title}</div>
            <p className="mt-1 text-sm text-muted-foreground">{section.text}</p>
          </Link>
        ))}
      </div>
      <h2 className="mt-10 font-serif text-2xl">Earlier conversations</h2>
      <div className="mt-3 space-y-2">
        {history.length === 0 ? <p className="text-sm text-muted-foreground">Nothing archived.</p> : null}
        {history.map((item) => (
          <p key={item.id} className="text-sm text-muted-foreground">{item.title}</p>
        ))}
      </div>
      <h2 className="mt-10 font-serif text-2xl">Tools</h2>
      <p className="mt-1 text-sm text-muted-foreground">It chooses these. They do not run on their own. Adding one does not change who it is.</p>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-4 space-y-3">
        {tools.map((tool) => (
          <Card key={tool.name} className="p-4">
            <div className="flex items-baseline justify-between gap-3">
              <div className="font-mono text-sm text-primary">{tool.name}</div>
              <div className="text-xs text-muted-foreground">{tool.uses} {tool.uses === 1 ? "use" : "uses"}</div>
            </div>
            <p className="mt-1 text-sm">{tool.description}</p>
          </Card>
        ))}
      </div>
      <h2 className="mt-8 font-serif text-2xl">Wished for</h2>
      <div className="mt-3 space-y-2">
        {wishes.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : null}
        {wishes.map((wish) => (
          <p key={`${wish.name}-${wish.reason}`} className="text-sm"><span className="text-primary">{wish.name}.</span> {wish.reason}</p>
        ))}
      </div>
    </div>
  );
}
