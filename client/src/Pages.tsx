import React from "react";
import { api } from "./api";
import { Win, useLiveData, when } from "./shared";

export function Settings() {
  const [s, reload] = useLiveData<any>(() => api("/settings"));
  if (!s) return <div className="page dim">Loading…</div>;
  const pct = (used: number, total: number) => (total > 0 ? Math.min(100, (used / total) * 100) : 0);
  const meterClass = (p: number) => (p > 90 ? "bad" : p > 70 ? "warn" : "");
  const hoursPct = pct(s.render.hoursUsed, s.render.hoursBudget);
  const dbPct = pct(s.database.usedMb, s.database.limitMb);
  return (
    <div className="page">
      <Win title="knobs">
        <table><tbody>
          {Object.entries(s.knobs).map(([name, k]: [string, any]) => (
            <tr key={name}>
              <td>{k.label}</td>
              <td>{k.type === "bool"
                ? <input type="checkbox" checked={Boolean(k.value)} onChange={async (e) => { await api("/settings/knob", { body: { name, value: e.target.checked } }); reload(); }} />
                : <input type="number" defaultValue={k.value} style={{ width: 120 }} onBlur={async (e) => { await api("/settings/knob", { body: { name, value: Number(e.target.value) } }); reload(); }} />}</td>
            </tr>
          ))}
        </tbody></table>
      </Win>
      <Win title="render: free hours this month">
        <div className="col">
          <div>{s.render.hoursUsed} of {s.render.hoursBudget} hours used · <span style={{ color: "var(--white)" }}>{s.render.hoursLeft} left</span> · resets {when(s.render.resetsAt)}</div>
          <div className={`meter ${meterClass(hoursPct)}`}><div style={{ width: `${hoursPct}%` }} /></div>
          <div className="dim">{s.render.note}</div>
        </div>
      </Win>
      <Win title="database space">
        <div className="col">
          <div>{s.database.usedMb} MB of {s.database.limitMb} MB used · <span style={{ color: "var(--white)" }}>{s.database.leftMb} MB left</span></div>
          <div className={`meter ${meterClass(dbPct)}`}><div style={{ width: `${dbPct}%` }} /></div>
          <div className="dim">Files you upload are stored here too. When it's full, nothing is deleted, but nothing new can be saved until there's more space.</div>
        </div>
      </Win>
      <Win title="models">
        <table><thead><tr><th>part</th><th>model</th><th>state</th></tr></thead><tbody>
          {s.models.roles.map((r: any) => <tr key={r.role}><td>{r.name}</td><td>{r.model}</td><td style={{ color: r.down ? "var(--red)" : "var(--green)" }}>{r.down ? `shut down since ${when(r.down.since)}: ${r.down.why}` : "working"}</td></tr>)}
        </tbody></table>
        <div className="dim" style={{ marginTop: 8 }}>
          Routes: Claude plan {s.models.routes.plan ? "on" : "off"} · Anthropic key {s.models.routes.anthropicKey ? "on" : "off"} · Gemini key {s.models.routes.geminiKey ? "on" : "off"}
          {s.models.plan && <> · plan limit: {s.models.plan.type || "?"} {s.models.plan.utilization != null ? `${Math.round(s.models.plan.utilization * 100)}% used` : "usage unknown"}{s.models.plan.resetsAt ? `, resets ${when(s.models.plan.resetsAt)}` : ""}</>}
        </div>
        <table style={{ marginTop: 8 }}><thead><tr><th>last 24 hours</th><th>calls</th><th>failed</th><th>characters</th></tr></thead><tbody>
          {s.models.last24h.map((c: any) => <tr key={c.model}><td>{c.model}</td><td>{c.calls}</td><td style={{ color: c.failed ? "var(--red)" : undefined }}>{c.failed}</td><td>{c.chars.toLocaleString()}</td></tr>)}
          {!s.models.last24h.length && <tr><td className="dim" colSpan={4}>no calls yet</td></tr>}
        </tbody></table>
      </Win>
    </div>
  );
}

export function Connections() {
  const [c] = useLiveData<any>(() => api("/connections"));
  return (
    <div className="page">
      <Win title="connections">
        {!c && <div className="dim">Loading…</div>}
        {c?.gmail && (
          <div className="item">
            <div className="row"><span>Gmail inbox</span><span className="badge">{c.gmail.configured ? "connected" : "not set up"}</span><span className="dim">{c.gmail.address ?? ""}</span><span className="grow" />{c.gmail.configured && <button onClick={() => api("/connections/gmail/check", { method: "POST" })}>check now</button>}</div>
            {c.gmail.configured ? (
              <div className="dim">{c.gmail.emails} email{c.gmail.emails === 1 ? "" : "s"} read · checks every 3 minutes{c.gmail.lastCheck ? ` · last checked ${when(c.gmail.lastCheck)}` : ""}. Each email goes into the web as a file; attachments as files of their own. It only reads; it sends nothing.</div>
            ) : <div className="dim">Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in Render to connect it.</div>}
            {c.gmail.lastError && <div style={{ color: "var(--red)" }}>Last check failed: {c.gmail.lastError}</div>}
          </div>
        )}
        {c?.connections.map((x: any) => <div key={x.id} className="item">{x.label} <span className="badge">{x.kind}</span></div>)}
        {c && <div className="dim" style={{ marginTop: 10 }}>Inbound door for connections: {c.inbound ? "open" : "not set up yet"}.</div>}
      </Win>
    </div>
  );
}
