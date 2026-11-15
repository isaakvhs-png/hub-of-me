import React, { createContext, useContext, useEffect, useRef, useState } from "react";

export interface Popup { id: string; kind: string; title: string; body: string; ref_id: string | null; created_at: string }
export interface Live {
  version: number;
  lit: Record<string, number>;
  litProjects: Record<string, number>;
  chat: { busy: boolean; round: number; why: string; stopAsked: boolean };
  doing: string;
  popups: Popup[];
  down: { role: string; name: string; model: string; since: string; why: string }[];
  reopenable: { id: string; title: string; closed_at: string }[];
}

export interface Shell {
  live: Live | null;
  openProject: (id: string) => void;
  openSummary: (id: string) => void;
  openSource: (id: string) => void;
  goTab: (tab: string) => void;
}

export const ShellContext = createContext<Shell>({ live: null, openProject: () => {}, openSummary: () => {}, openSource: () => {}, goTab: () => {} });
export const useShell = () => useContext(ShellContext);

/** Fetches again whenever anything changed on the server (the live version moved). */
export function useLiveData<T>(load: () => Promise<T>, deps: unknown[] = []): [T | null, () => void, string] {
  const { live } = useShell();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    loadRef.current().then((d) => { if (alive) { setData(d); setError(""); } }).catch((e) => { if (alive) setError(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [live?.version, nonce, ...deps]);
  return [data, () => setNonce((n) => n + 1), error];
}

/** Dictation through the browser's own speech recognition (Chrome, Edge). */
export function useDictation(onText: (text: string) => void) {
  const [on, setOn] = useState(false);
  const recRef = useRef<any>(null);
  const supported = typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  const toggle = () => {
    if (!supported) { alert("Dictation needs Chrome or Edge."); return; }
    if (on) { recRef.current?.stop(); setOn(false); return; }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) if (e.results[i].isFinal) text += e.results[i][0].transcript;
      if (text.trim()) onText(text.trim());
    };
    rec.onend = () => setOn(false);
    rec.onerror = () => setOn(false);
    rec.start();
    recRef.current = rec;
    setOn(true);
  };
  return { on, toggle, supported };
}

export function Mic({ onText }: { onText: (t: string) => void }) {
  const d = useDictation(onText);
  return <button type="button" className={`mic ${d.on ? "on" : ""}`} title={d.supported ? "Dictate" : "Dictation needs Chrome or Edge"} onClick={d.toggle}>{d.on ? "● rec" : "mic"}</button>;
}

export function Win({ title, children, right, className, style, barProps }: { title: React.ReactNode; children: React.ReactNode; right?: React.ReactNode; className?: string; style?: React.CSSProperties; barProps?: React.HTMLAttributes<HTMLDivElement> }) {
  return (
    <div className={`win ${className ?? ""}`} style={style}>
      <div className="bar" {...barProps}><span className="title">{title}</span>{right}</div>
      <div className="body">{children}</div>
    </div>
  );
}

export const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};

export function Spinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % frames.length), 90); return () => clearInterval(t); }, []);
  return <span className="spinner">{frames[i]}</span>;
}
