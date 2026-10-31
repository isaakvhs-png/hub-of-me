import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

interface Message { id: string; role: string; content: string }
interface Conversation { id: string; title: string }
interface DumpResult {
  conversationId: string;
  reply: string;
  notes: { id: string; title: string; status: string }[];
  filingError: string | null;
  reflection: { debateId?: string; error?: string; commitment?: string } | null;
}

export function ChatPage() {
  const [params, setParams] = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState("");
  const [filed, setFiled] = useState<DumpResult["notes"]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const media = useRef<MediaRecorder | null>(null);
  const speech = useRef<{ stop: () => void } | null>(null);
  const chunks = useRef<Blob[]>([]);
  const conversationId = params.get("c");

  async function loadLists() {
    setConversations(await api<Conversation[]>("/api/conversations"));
  }

  useEffect(() => { loadLists().catch((err) => setError(err.message)); }, []);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    api<Message[]>(`/api/conversations/${conversationId}/messages`).then(setMessages).catch((err) => setError(err.message));
  }, [conversationId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  useEffect(() => {
    const desktop = window.hubDesktop;
    if (!desktop) return;
    return desktop.onStartDictation(() => { void toggleRecord(); });
  }, [recording, text]);

  async function send(body: string, audio?: Blob) {
    const trimmed = body.trim();
    if (!trimmed && !audio) return;
    setBusy(true);
    setError("");
    try {
      let result: DumpResult;
      if (audio) {
        const form = new FormData();
        form.set("audio", audio, "dump.webm");
        form.set("transcript", trimmed);
        if (conversationId) form.set("conversationId", conversationId);
        result = await api<DumpResult>("/api/voice", { method: "POST", body: form });
      } else {
        result = await api<DumpResult>("/api/dump", { method: "POST", body: JSON.stringify({ text: trimmed, conversationId }) });
      }
      setParams({ c: result.conversationId });
      setMessages(await api<Message[]>(`/api/conversations/${result.conversationId}/messages`));
      setFiled(result.notes);
      setText("");
      setLive("");
      await loadLists();
      const problems = [result.filingError, result.reflection && "error" in result.reflection ? result.reflection.error : null].filter(Boolean);
      if (problems.length) setError(problems.join(" "));
      window.hubDesktop?.notify("Filed", result.notes[0]?.title || "The dump is in.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The dump did not land.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecord() {
    if (recording) {
      media.current?.stop();
      speech.current?.stop();
      setRecording(false);
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunks.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: recorder.mimeType || "audio/webm" });
        const transcript = (live || text).trim();
        if (!transcript) {
          setError("This browser kept the recording but did not transcribe it. Type the words and send.");
          return;
        }
        void send(transcript, blob);
      };
      recorder.start();
      media.current = recorder;
      const Speech = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition
        || (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
      if (Speech) {
        const rec = new Speech();
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (event) => {
          let said = "";
          for (let i = 0; i < event.results.length; i += 1) said += event.results[i][0].transcript;
          setLive(said);
          setText(said);
        };
        rec.start();
        speech.current = rec;
      } else {
        setLive("");
        setError("This browser has no speech recognition. The recording is kept; type the words beside it.");
      }
      setRecording(true);
    } catch {
      setError("Microphone permission was refused.");
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="hidden lg:block">
        <button className="text-xs uppercase tracking-wide text-muted-foreground" onClick={() => setParams({})}>New dump</button>
        <div className="mt-3 space-y-1">
          {conversations.length === 0 ? <p className="text-sm text-muted-foreground">No threads yet.</p> : null}
          {conversations.map((item) => (
            <button key={item.id} className={`block w-full truncate rounded-md px-2 py-2 text-left text-sm ${item.id === conversationId ? "bg-accent text-primary" : "text-muted-foreground"}`} onClick={() => setParams({ c: item.id })}>
              {item.title}
            </button>
          ))}
        </div>
      </aside>
      <section className="flex min-h-[70vh] flex-col">
        <h1 className="font-serif text-4xl italic">Dump</h1>
        <div className="mt-6 flex-1 space-y-6">
          {messages.length === 0 ? <p className="max-w-xl text-muted-foreground">Say the thing that is taking up the room. It will be filed as a note, and one message will not rewrite the soul.</p> : null}
          {messages.map((message) => (
            <article key={message.id} className={message.role === "assistant" ? "border-l-2 border-primary pl-4" : ""}>
              <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{message.role === "assistant" ? "Hub" : "You"}</div>
              <div className="mt-1 whitespace-pre-wrap leading-relaxed">{message.content}</div>
            </article>
          ))}
          {busy ? <p className="text-sm text-primary">Reading it, then filing.</p> : null}
          {filed.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {filed.map((note) => (
                <a key={note.id} href={`/library?note=${note.id}`} className="rounded-full border border-border px-3 py-1 text-xs text-primary">
                  {note.status} · {note.title}
                </a>
              ))}
            </div>
          ) : null}
          <div ref={bottom} />
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <form className="mt-4 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Dump it here" className="min-h-[88px]" />
          <div className="flex flex-col gap-2">
            <Button type="button" variant={recording ? "default" : "outline"} size="icon" onClick={() => void toggleRecord()} aria-label={recording ? "Stop recording" : "Record"}>
              {recording ? <Square size={16} /> : <Mic size={16} />}
            </Button>
            <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
          </div>
        </form>
        {recording ? <p className="mt-2 font-mono text-xs text-primary">Listening{live ? `: ${live}` : "…"}</p> : null}
      </section>
    </div>
  );
}

interface SpeechRec {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
  stop: () => void;
}
