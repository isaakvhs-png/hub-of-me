import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { eur, when } from "@/lib/utils";

export function BriefPage() {
  const [briefs, setBriefs] = useState<{ id: string; content: string; why: string; createdAt: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() { setBriefs(await api("/api/brief")); }
  useEffect(() => { reload().catch((err) => setError(err.message)); }, []);
  async function write() {
    setBusy(true);
    setError("");
    try { await api("/api/brief", { method: "POST", body: "{}" }); await reload(); }
    catch (err) { setError(err instanceof Error ? err.message : "No brief."); }
    finally { setBusy(false); }
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-serif text-4xl italic">Brief</h1>
        <Button onClick={() => void write()} disabled={busy}>{busy ? "Writing…" : "Write one"}</Button>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-6 space-y-4">
        {briefs.length === 0 ? <p className="text-sm text-muted-foreground">No brief yet. Ask for one whenever you want the day in one page.</p> : null}
        {briefs.map((brief) => (
          <Card key={brief.id} className="p-4">
            <div className="font-mono text-xs text-muted-foreground">{when(brief.createdAt)} · {brief.why}</div>
            <div className="mt-3 whitespace-pre-wrap leading-relaxed">{brief.content}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function AsksPage() {
  const [asks, setAsks] = useState<{ id: string; question: string; why: string; status: string; answer: string | null }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  async function reload() { setAsks(await api("/api/asks")); }
  useEffect(() => { reload().catch((err) => setError(err.message)); }, []);
  async function act(id: string, action: string, answer?: string) {
    setError("");
    try {
      await api(`/api/asks/${id}`, { method: "POST", body: JSON.stringify({ action, answer }) });
      await reload();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save that."); }
  }
  const open = asks.filter((ask) => ask.status === "open" || ask.status === "postponed");
  return (
    <div>
      <h1 className="font-serif text-4xl italic">Asks</h1>
      <p className="mt-2 text-sm text-muted-foreground">Questions reflection judged worth asking. Answer, postpone, or never ask again.</p>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <div className="mt-6 space-y-4">
        {open.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting. That is allowed.</p> : null}
        {open.map((ask) => (
          <Card key={ask.id} className="p-4">
            <div className="font-serif text-2xl">{ask.question}</div>
            <p className="mt-2 text-sm text-muted-foreground">{ask.why}</p>
            <Textarea className="mt-3" value={drafts[ask.id] ?? ""} onChange={(event) => setDrafts({ ...drafts, [ask.id]: event.target.value })} placeholder="Your answer" />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void act(ask.id, "answer", drafts[ask.id])}>Answer</Button>
              <Button size="sm" variant="outline" onClick={() => void act(ask.id, "postpone")}>Postpone</Button>
              <Button size="sm" variant="ghost" onClick={() => void act(ask.id, "never")}>Never ask</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

interface DebateRow { id: string; question: string; status: string; whyWon: string | null; loserGotRight: string | null; closeCall: boolean; commitment: string | null; createdAt: string; userFeedback: string | null; mockEra?: boolean; judgeModel?: string | null }

export function DebatesPage() {
  const [rows, setRows] = useState<DebateRow[]>([]);
  useEffect(() => { api<DebateRow[]>("/api/debates").then(setRows).catch(() => setRows([])); }, []);
  return (
    <div>
      <h1 className="font-serif text-4xl italic">Debates</h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">Already concluded. Open one if you want to see the sides. The conclusion does not wait.</p>
      <div className="mt-6 space-y-3">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No debate yet. A dump that bears on the soul will start one.</p> : null}
        {rows.map((row) => (
          <Link key={row.id} to={`/debates/${row.id}`} className="block rounded-xl border border-border p-4 hover:border-primary">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              {row.status} {row.mockEra || row.judgeModel?.startsWith("mock") ? <span>mock</span> : null} {row.closeCall ? <span className="text-primary">close call</span> : null}
            </div>
            <div className="mt-1 text-lg">{row.question}</div>
            {row.commitment ? <div className="mt-2 text-sm text-primary">{row.commitment}</div> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function DebatePage() {
  const { id } = useParams();
  const [data, setData] = useState<{ debate: DebateRow; sides: { id: string; position: string; argument: string; uncomfortable: boolean; model: string; anonymousLabel: string | null }[]; predictions: { id: string; prediction: string; cameTrue: boolean | null; outcome: string | null }[] } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [observed, setObserved] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState("");
  async function reload() { if (id) setData(await api(`/api/debates/${id}`)); }
  useEffect(() => { reload().catch((err) => setError(err.message)); }, [id]);
  useEffect(() => {
    if (data?.debate.status !== "running") return;
    const timer = window.setInterval(() => { void reload().catch(() => undefined); }, 1500);
    return () => window.clearInterval(timer);
  }, [id, data?.debate.status]);
  async function runAgain() {
    if (!id) return;
    setRerunning(true);
    setRerunError("");
    setError("");
    try {
      const result = await api<{ reflection: { error?: string; debateId?: string } }>(`/api/debates/${id}/rerun`, { method: "POST", body: "{}" });
      if (result.reflection.error) {
        setRerunError(result.reflection.error);
        await reload();
        return;
      }
      const nextId = result.reflection.debateId;
      if (!nextId) {
        setRerunError("The rerun did not start a debate.");
        return;
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const view = await api<{ debate: DebateRow }>(`/api/debates/${nextId}`);
        if (view.debate.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        if (view.debate.status === "failed") {
          setRerunError(view.debate.whyWon || "The debate failed.");
          return;
        }
        window.location.assign(`/debates/${nextId}`);
        return;
      }
      setRerunError("The debate is still running. It will keep updating on this page if you open it.");
    } catch (err) {
      setRerunError(err instanceof Error ? err.message : "Could not run it again.");
    } finally {
      setRerunning(false);
    }
  }
  if (!data) return <p className="text-sm text-muted-foreground">{error || "Opening the debate…"}</p>;
  const winner = data.sides.find((side) => data.debate.whyWon && side.position);
  return (
    <div>
      <Link to="/debates" className="text-xs uppercase tracking-wide text-muted-foreground">All debates</Link>
      <h1 className="mt-2 font-serif text-4xl italic">{data.debate.question}</h1>
      {data.debate.mockEra || data.debate.judgeModel?.startsWith("mock") ? <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">Mock-era debate. It is not evidence for a real provider.</p> : null}
      {data.debate.status === "running" || rerunning ? (
        <p className="mt-4 text-sm text-primary" role="status">Running the debate…</p>
      ) : null}
      {data.debate.status === "failed" ? (
        <div className="mt-4">
          <p className="text-sm text-destructive">{rerunError || data.debate.whyWon || "This debate failed."}</p>
          <Button className="mt-3" variant="outline" disabled={rerunning || busy} onClick={() => void runAgain()}>{rerunning ? "Running…" : "Run again"}</Button>
        </div>
      ) : null}
      {data.debate.closeCall ? <p className="mt-2 text-sm text-primary">Close call. The conclusion already stands.</p> : null}
      <p className="mt-4 max-w-2xl">{data.debate.whyWon}</p>
      <p className="mt-2 text-sm text-muted-foreground">What the losing side got right: {data.debate.loserGotRight}</p>
      {data.debate.commitment ? <p className="mt-4 border-l-2 border-primary pl-3">{data.debate.commitment}</p> : null}
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {data.sides.map((side) => (
          <Card key={side.id} className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{side.uncomfortable ? "Uncomfortable side" : "Side"} · judge saw {side.anonymousLabel} · {side.model}</div>
            <div className="mt-2 font-medium">{side.position}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{side.argument}</p>
          </Card>
        ))}
      </div>
      <div className="mt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Predictions</div>
        {data.predictions.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">None logged on this debate.</p> : null}
        {data.predictions.map((item) => (
          <div key={item.id} className="mt-3 rounded-md border border-border p-3 text-sm">
            <div>{item.prediction}</div>
            {item.cameTrue == null ? (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input value={observed[item.id] ?? ""} onChange={(event) => setObserved({ ...observed, [item.id]: event.target.value })} placeholder="What actually happened" />
                <Button size="sm" variant="outline" onClick={() => api(`/api/predictions/${item.id}`, { method: "POST", body: JSON.stringify({ cameTrue: true, observed: observed[item.id] || "It happened." }) }).then(reload)}>Came true</Button>
                <Button size="sm" variant="outline" onClick={() => api(`/api/predictions/${item.id}`, { method: "POST", body: JSON.stringify({ cameTrue: false, observed: observed[item.id] || "It did not." }) }).then(reload)}>Did not</Button>
              </div>
            ) : <div className="mt-1 text-muted-foreground">{item.cameTrue ? "Came true" : "Did not"} — {item.outcome}</div>}
          </div>
        ))}
      </div>
      <form className="mt-8 max-w-xl space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try { await api(`/api/debates/${id}/feedback`, { method: "POST", body: JSON.stringify({ text: feedback }) }); setFeedback(""); await reload(); }
        catch (err) { setError(err instanceof Error ? err.message : "Feedback was not folded in."); }
        finally { setBusy(false); }
      }}>
        <Label>Your reaction, if you have one</Label>
        <Textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Kept as evidence, not as a rule." />
        <Button type="submit" disabled={busy || !feedback.trim()}>{busy ? "Folding it in…" : "Send feedback"}</Button>
        {data.debate.userFeedback ? <p className="text-sm text-muted-foreground">Already noted: {data.debate.userFeedback}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {winner ? null : null}
      </form>
    </div>
  );
}

export function SoulPage() {
  const [data, setData] = useState<{ current: { version: number; content: string; reason: string; createdByRole: string } | null; versions: { version: number; reason: string; createdByRole: string; createdAt: string }[]; picture: { id: string; statement: string; evidenceNoteIds: string[] }[]; preferences: { id: string; statement: string; evidenceIds: string[] }[] } | null>(null);
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function reload() {
    const next = await api<NonNullable<typeof data>>("/api/soul");
    setData(next);
    setContent(next.current?.content ?? "");
  }
  useEffect(() => { reload().catch((err) => setError(err.message)); }, []);
  if (!data?.current) return <p className="text-sm text-muted-foreground">{error || "Opening the soul…"}</p>;
  return (
    <div className="grid gap-8 lg:grid-cols-[1.4fr_0.8fr]">
      <div>
        <h1 className="font-serif text-4xl italic">Soul</h1>
        <p className="mt-2 text-sm text-muted-foreground">Version {data.current.version}, written by {data.current.createdByRole}. Chat cannot overwrite this. Reflection can. You can correct it.</p>
        <Textarea className="mt-4 min-h-[360px] font-serif" value={content} onChange={(event) => setContent(event.target.value)} />
        <Input className="mt-3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this correction" />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => api("/api/soul", { method: "POST", body: JSON.stringify({ content, reason: reason || "You corrected it." }) }).then(reload).catch((err) => setError(err.message))}>Save correction</Button>
          <Button variant="outline" onClick={() => api("/api/soul/undo", { method: "POST", body: "{}" }).then(reload).catch((err) => setError(err.message))}>Undo</Button>
          <a className="inline-flex h-10 items-center text-sm text-primary" href="/api/soul/docx">Word</a>
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <ul className="mt-6 space-y-2">
          {data.versions.map((version) => (
            <li key={version.version} className="text-sm text-muted-foreground">v{version.version} · {version.createdByRole} · {when(version.createdAt)} · {version.reason}</li>
          ))}
        </ul>
      </div>
      <div className="space-y-6">
        <div>
          <h2 className="font-serif text-2xl">Picture of you</h2>
          {data.picture.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Blank until reflection has your words.</p> : null}
          {data.picture.map((line) => <p key={line.id} className="mt-3 text-sm">{line.statement}</p>)}
        </div>
        <div>
          <h2 className="font-serif text-2xl">Preferences</h2>
          <p className="mt-1 text-xs text-muted-foreground">General rules. The examples stay attached as evidence.</p>
          {data.preferences.map((rule) => <p key={rule.id} className="mt-3 text-sm">{rule.statement}</p>)}
        </div>
      </div>
    </div>
  );
}

export function WhyPage() {
  const [data, setData] = useState<{ actions: { id: string; what: string; why: string; source: string; createdAt: string }[]; conflicts: { id: string; description: string; resolvedAt: string | null; resolution: string | null }[] } | null>(null);
  useEffect(() => { api<NonNullable<typeof data>>("/api/why").then(setData).catch(() => setData({ actions: [], conflicts: [] })); }, []);
  const open = data?.conflicts.filter((item) => !item.resolvedAt) ?? [];
  return (
    <div>
      <h1 className="font-serif text-4xl italic">Why</h1>
      <p className="mt-2 text-sm text-muted-foreground">Every action keeps what, why, and the source. Tensions sit here quietly: {open.length}.</p>
      <div className="mt-6 space-y-2">
        {open.map((item) => <div key={item.id} className="rounded-md border border-border px-3 py-2 text-sm">{item.description}</div>)}
        {data?.actions.map((item) => (
          <div key={item.id} className="grid gap-1 border-b border-border py-3 text-sm md:grid-cols-[160px_1fr]">
            <div className="font-mono text-xs text-muted-foreground">{when(item.createdAt)} · {item.source}</div>
            <div><div>{item.what}</div><div className="text-muted-foreground">{item.why}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Health {
  capEurCents: number; spentEurCents: number; leftEurCents: number; unpricedCalls: number; usdToEur: number;
  calls: number; mockCalls: number; inputTokens: number; outputTokens: number;
  byDay: { key: string; calls: number; inputTokens: number; outputTokens: number; costEurCents: number }[];
  byConversation: { key: string; calls: number; inputTokens: number; outputTokens: number; costEurCents: number }[];
  byJob: { key: string; calls: number; inputTokens: number; outputTokens: number; costEurCents: number }[];
  drift: { flagged: boolean; detail: string };
  winsByModel: Record<string, number>;
}

export function HealthPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Health>("/api/health").then(setHealth).catch((err) => setError(err.message)); }, []);
  if (!health) return <p className="text-sm text-muted-foreground">{error || "Counting real tokens…"}</p>;
  return (
    <div>
      <h1 className="font-serif text-4xl italic">Health</h1>
      <div className="mt-4 font-serif text-6xl text-primary ledger">{eur(health.leftEurCents)}</div>
      <p className="mt-1 text-sm text-muted-foreground">left of {eur(health.capEurCents)} this month. Spent {eur(health.spentEurCents)}. Rate {health.usdToEur} USD to EUR. {health.calls} calls, {health.inputTokens} in, {health.outputTokens} out.</p>
      {health.unpricedCalls > 0 ? <p className="mt-2 text-sm text-destructive">{health.unpricedCalls} calls have no list price, so further calls are blocked rather than guessed.</p> : null}
      {health.mockCalls > 0 ? <p className="mt-2 text-sm text-muted-foreground">{health.mockCalls} calls are tagged mock. They are not used as evidence once a real provider is selected.</p> : null}
      <p className={`mt-3 text-sm ${health.drift.flagged ? "text-primary" : "text-muted-foreground"}`}>{health.drift.detail}</p>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Ledger title="By day" rows={health.byDay} />
        <Ledger title="By conversation" rows={health.byConversation} />
        <Ledger title="By job" rows={health.byJob} />
      </div>
      <div className="mt-6 text-sm text-muted-foreground">
        Wins by model: {Object.entries(health.winsByModel).map(([model, count]) => `${model} ${count}`).join(" · ") || "none yet"}
      </div>
    </div>
  );
}

function Ledger({ title, rows }: { title: string; rows: Health["byDay"] }) {
  return (
    <div>
      <h2 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h2>
      <table className="mt-2 w-full text-left text-sm ledger">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border">
              <td className="py-1 pr-2">{row.key.slice(0, 22)}</td>
              <td className="py-1">{row.inputTokens + row.outputTokens}</td>
              <td className="py-1 text-right">{eur(row.costEurCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPage() {
  const [state, setState] = useState<{ settings: { provider: string; cheapModel: string; strongModel: string; judgeModel: string; alternateModel: string; localCategories: string[]; forNowTtlHours: number; dictationLang: string; usdToEur: number }; budget: { monthlyCapEurCents: number }; gmail: { scopes: string[]; enabled: boolean }; keys: { anthropic: boolean; gemini: boolean }; providerChoice: { active: string; why: string; envAiProvider: string | null } } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState("");
  useEffect(() => { api<NonNullable<typeof state>>("/api/settings").then(setState).catch((err) => setError(err.message)); }, []);
  if (!state) return <p className="text-sm text-muted-foreground">{error || "Opening settings…"}</p>;
  const settings = state.settings;
  function patch(partial: Partial<typeof settings>) { setState({ ...state!, settings: { ...settings, ...partial } }); }
  return (
    <div className="max-w-xl">
      <h1 className="font-serif text-4xl italic">Settings</h1>
      <div className="mt-6 space-y-4">
        <div>
          <Label>Provider</Label>
          <p className="mt-1 text-sm">Calls use {state.providerChoice.active}.</p>
          <select className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3" value={settings.provider} onChange={(event) => patch({ provider: event.target.value })}>
            <option value="mock">Mock (no key)</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{state.providerChoice.why} Anthropic key {state.keys.anthropic ? "is set" : "is missing"}. Gemini key {state.keys.gemini ? "is set" : "is missing"}. A saved choice applies now. If AI_PROVIDER is set, the next start writes that value again. A failed real call is shown here and in the log. It is not replaced with mock.</p>
        </div>
        {(["cheapModel", "strongModel", "judgeModel", "alternateModel"] as const).map((key) => (
          <div key={key}>
            <Label>{key}</Label>
            <Input className="mt-1" value={settings[key]} onChange={(event) => patch({ [key]: event.target.value })} />
          </div>
        ))}
        <div>
          <Label>Monthly cap, EUR</Label>
          <Input className="mt-1" type="number" step="1" value={state.budget.monthlyCapEurCents / 100} onChange={(event) => setState({ ...state, budget: { monthlyCapEurCents: Math.round(Number(event.target.value) * 100) } })} />
        </div>
        <div>
          <Label>USD to EUR</Label>
          <Input className="mt-1" type="number" step="0.0001" value={settings.usdToEur} onChange={(event) => patch({ usdToEur: Number(event.target.value) })} />
        </div>
        <div>
          <Label>Local categories, kept out of model calls</Label>
          <Input className="mt-1" value={settings.localCategories.join(", ")} onChange={(event) => patch({ localCategories: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="health, finances" />
        </div>
        <div>
          <Label>For-now bin, hours</Label>
          <Input className="mt-1" type="number" value={settings.forNowTtlHours} onChange={(event) => patch({ forNowTtlHours: Number(event.target.value) })} />
        </div>
        <div>
          <Label>Dictation language, blank uses the browser</Label>
          <Input className="mt-1" value={settings.dictationLang} onChange={(event) => patch({ dictationLang: event.target.value })} placeholder="nl-NL" />
        </div>
        <Button onClick={() => api("/api/settings", { method: "POST", body: JSON.stringify({ ...settings, monthlyCapEur: state.budget.monthlyCapEurCents / 100 }) }).then(() => setSaved("Saved.")).catch((err) => setError(err.message))}>Save</Button>
        {saved ? <p className="text-sm text-primary">{saved}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Card className="p-4">
          <h2 className="font-serif text-2xl">Password</h2>
          <p className="mt-2 text-sm text-muted-foreground">This takes effect now. If USER_PASSWORD is set in the environment, the server writes that password again the next time it starts. The account and its notes stay.</p>
          <div className="mt-3 space-y-3">
            <div>
              <Label htmlFor="current-password">Current password</Label>
              <Input id="current-password" className="mt-1" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="new-password">New password</Label>
              <Input id="new-password" className="mt-1" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </div>
            <Button onClick={() => api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }).then(() => { setPasswordSaved("Password changed."); setPasswordError(""); setCurrentPassword(""); setNewPassword(""); }).catch((err) => { setPasswordError(err.message); setPasswordSaved(""); })}>Change password</Button>
            {passwordSaved ? <p className="text-sm text-primary">{passwordSaved}</p> : null}
            {passwordError ? <p className="text-sm text-destructive">{passwordError}</p> : null}
          </div>
        </Card>
        <Card className="p-4">
          <h2 className="font-serif text-2xl">Gmail</h2>
          <p className="mt-2 text-sm text-muted-foreground">Read-only. Scope: {state.gmail.scopes.join(", ")}. No Drive, no Photos, and no send. Drafts stay in the app.</p>
          <Button className="mt-3" variant="outline" onClick={() => api<{ url?: string; error?: string }>("/api/modules/gmail/auth-url").then((result) => { if (result.url) window.location.href = result.url; else setError(result.error || "Gmail is not configured."); }).catch((err) => setError(err.message))}>Link Gmail</Button>
        </Card>
      </div>
    </div>
  );
}
