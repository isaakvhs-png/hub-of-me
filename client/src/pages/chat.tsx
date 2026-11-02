import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TraceDetail, TraceView, type TraceSpan } from "@/components/trace";
import { ApiError, api } from "@/lib/api";
import { readSse } from "@/lib/sse";
import { appendAttachments, removeAttachment } from "../../../src/attachments";

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
  const [traces, setTraces] = useState<TraceSpan[]>([]);
  const [work, setWork] = useState<{ status: string; label: string; targetId?: string | null } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftSpans, setDraftSpans] = useState<TraceSpan[]>([]);
  const [openTrace, setOpenTrace] = useState<TraceSpan | null>(null);
  const skipLoad = useRef(false);
  /** True from the moment Send is pressed: blocks a second send before React has re-rendered the button as busy. */
  const sending = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const media = useRef<MediaRecorder | null>(null);
  const speech = useRef<{ stop: () => void } | null>(null);
  const chunks = useRef<Blob[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const conversationId = params.get("c");

  async function loadLists() {
    setConversations(await api<Conversation[]>("/api/conversations"));
  }

  const [mind, setMind] = useState("");
  const [topicsOn, setTopicsOn] = useState<string[]>([]);
  useEffect(() => {
    api("/api/arrive", { method: "POST", body: "{}" })
      .then(async () => {
        const list = await api<Conversation[]>("/api/conversations");
        setConversations(list);
        const current = params.get("c");
        if (!current || !list.some((item) => item.id === current)) setParams(list[0] ? { c: list[0].id } : {}, { replace: true });
      })
      .catch((err) => setError(err.message));
    api<{ mind: { content: string } | null }>("/api/mind").then((data) => setMind(data.mind?.content ?? "")).catch(() => undefined);
  }, []);

  async function loadThread(id: string, flash = false) {
    let nextMessages: Message[];
    let nextTraces: TraceSpan[];
    try {
      [nextMessages, nextTraces] = await Promise.all([
        api<Message[]>(`/api/conversations/${id}/messages`),
        api<TraceSpan[]>(`/api/conversations/${id}/traces`),
      ]);
    } catch (err) {
      // A conversation that went into notebook history is not an error for him: just open the live chat.
      if (err instanceof ApiError && err.status === 404) {
        setParams({}, { replace: true });
        return;
      }
      throw err;
    }
    setMessages(nextMessages);
    const replay = nextTraces.filter((span) => flash || span.seen === false);
    setTraces(nextTraces.map((span) => ({ ...span, flash: flash || span.seen === false })));
    if (replay.length) api("/api/traces/seen", { method: "POST", body: JSON.stringify({ ids: replay.map((span) => span.id) }) }).catch(() => undefined);
    api<{ mind: { content: string } | null }>("/api/mind").then((data) => setMind(data.mind?.content ?? "")).catch(() => undefined);
  }

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setTraces([]);
      return;
    }
    if (skipLoad.current) {
      skipLoad.current = false;
      return;
    }
    loadThread(conversationId).catch((err) => {
      if (err instanceof ApiError && err.status === 404) setParams({}, { replace: true });
      else setError(err.message);
    });
  }, [conversationId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  useEffect(() => {
    const desktop = window.hubDesktop;
    if (!desktop) return;
    return desktop.onStartDictation(() => { void toggleRecord(); });
  }, [recording, text]);

  async function send(body: string, audio?: Blob) {
    const trimmed = body.trim();
    if (!trimmed && !audio && files.length === 0) return;
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    // The words leave the box at once: they show as the message being read, and a second press cannot send them twice.
    if (!files.length) setText("");
    try {
      let result: DumpResult;
      if (files.length && !audio) {
        const form = new FormData();
        for (const item of files) form.append("file", item);
        if (trimmed) form.set("text", trimmed);
        if (conversationId) form.set("conversationId", conversationId);
        const uploaded = await api<{ notes?: DumpResult["notes"]; note?: DumpResult["notes"][number]; closed: { title: string }[]; conversationId: string; errors?: string[] }>("/api/dump/file", { method: "POST", body: form });
        if (uploaded.conversationId !== conversationId) skipLoad.current = true;
        setParams({ c: uploaded.conversationId });
        await loadThread(uploaded.conversationId, true);
        setFiled(uploaded.notes ?? (uploaded.note ? [uploaded.note] : []));
        setText("");
        setFiles([]);
        if (fileRef.current) fileRef.current.value = "";
        await loadLists();
        if (uploaded.errors?.length) setError(uploaded.errors.join(" "));
        return;
      }
      if (audio) {
        const form = new FormData();
        form.set("audio", audio, "dump.webm");
        form.set("transcript", trimmed);
        if (conversationId) form.set("conversationId", conversationId);
        result = await api<DumpResult>("/api/voice", { method: "POST", body: form });
      } else {
        setDraft(trimmed);
        setDraftSpans([]);
        setWork(null);
        const unreachable = "It could not be reached, so nothing was sent. Your words are back in the box; try again in a moment.";
        let response: Response;
        try {
          response = await fetch("/api/dump/stream", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: trimmed, conversationId }),
          });
        } catch {
          setText(trimmed);
          throw new Error(unreachable);
        }
        if (!response.ok) {
          setText(trimmed);
          throw new Error(unreachable);
        }
        let donePayload: DumpResult | null = null;
        await readSse(response, (event, data) => {
          if (event === "span") setDraftSpans((prev) => [...prev, { ...(data as unknown as TraceSpan), flash: true }]);
          if (event === "work" && typeof data.label === "string") {
            setWork({ status: typeof data.status === "string" ? data.status : "running", label: data.label, targetId: (data.targetId as string | null) ?? null });
          }
          if (event === "error") throw new Error(typeof data.error === "string" ? data.error : "The dump did not land.");
          if (event === "done") donePayload = data as unknown as DumpResult;
        });
        if (!donePayload) throw new Error("The connection dropped before the answer came back. Your message is saved, and it will answer it within a couple of minutes.");
        result = donePayload;
      }
      if (result.conversationId !== conversationId) skipLoad.current = true;
      setParams({ c: result.conversationId });
      await loadThread(result.conversationId, true);
      setDraft(null);
      setDraftSpans([]);
      setWork(null);
      setFiled(result.notes);
      setText("");
      setLive("");
      await loadLists();
      const problems = [result.filingError, result.reflection && "error" in result.reflection ? result.reflection.error : null].filter(Boolean);
      if (problems.length) setError(problems.join(" "));
      window.hubDesktop?.notify("Filed", result.notes[0]?.title || "The dump is in.");
    } catch (err) {
      setDraft(null);
      setError(err instanceof Error ? err.message : "The dump did not land.");
    } finally {
      sending.current = false;
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
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[200px_1fr_240px]">
      <aside className="hidden lg:block">
        <button className="text-xs uppercase tracking-wide text-muted-foreground" onClick={() => setParams({})}>New chat</button>
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
        <h1 className="font-serif text-4xl italic">Chat</h1>
        <div className="mt-6 flex-1 space-y-6">
          {messages.length === 0 ? <p className="max-w-xl text-muted-foreground">Say what is taking up the room. It can answer from the notebook, or decide to think first.</p> : null}
          {messages.map((message) => {
            const allSpans = traces.filter((span) => span.messageId === message.id && span.start >= 0);
            const spans = allSpans.filter((span) => span.destination !== "topic" || topicsOn.includes(span.id));
            const topics = allSpans.filter((span) => span.destination === "topic");
            const lines = traces.filter((span) => span.messageId === message.id && span.start < 0);
            return (
              <article key={message.id} className={message.role === "assistant" ? "border-l-2 border-primary pl-4" : ""}>
                <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{message.role === "assistant" ? "Hub" : "You"}</div>
                <div className="mt-1">
                  {message.role === "user" && spans.length ? <TraceView text={message.content} spans={spans} onOpen={setOpenTrace} /> : <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>}
                </div>
                {lines.map((line) => (
                  <p key={line.id} className="mt-2 text-sm text-primary">
                    {line.targetId ? <Link to={`/debates/${line.targetId}`}>{line.label}</Link> : line.label}
                  </p>
                ))}
                {message.role === "user" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {topics.map((topic) => (
                      <button key={topic.id} type="button" className={`rounded-full border px-2 py-1 text-xs ${topicsOn.includes(topic.id) ? "border-primary text-primary" : "border-border text-muted-foreground"}`} onClick={() => setTopicsOn((current) => current.includes(topic.id) ? current.filter((id) => id !== topic.id) : [...current, topic.id])}>
                        {topic.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
          {draft ? (
            <article>
              <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">You</div>
              <div className="mt-1">
                <TraceView text={draft} spans={draftSpans} onOpen={setOpenTrace} />
              </div>
              {work ? <p className="mt-2 text-sm text-primary">{work.targetId ? <Link to={`/debates/${work.targetId}`}>{work.label}</Link> : work.label}</p> : null}
            </article>
          ) : null}
          {openTrace ? <TraceDetail span={openTrace} onClose={() => setOpenTrace(null)} /> : null}
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
        <form
          className={`mt-4 flex items-end gap-2 rounded-md ${dragging ? "ring-2 ring-primary" : ""}`}
          onSubmit={(event) => { event.preventDefault(); void send(text); }}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const chosen = Array.from(event.dataTransfer.files);
            setFiles((current) => appendAttachments(current, chosen));
          }}
        >
          <div className="flex-1">
            <Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Dump it here, or drop files" className="min-h-[88px]" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                id="dump-files"
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/*"
                className="sr-only"
                onChange={(event) => {
                  const chosen = Array.from(event.target.files ?? []);
                  setFiles((current) => appendAttachments(current, chosen));
                  event.target.value = "";
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>Attach</Button>
              {files.map((item, index) => (
                <span key={`${item.name}-${item.lastModified}-${index}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-primary">
                  {item.name}
                  <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${item.name}`} onClick={() => setFiles((current) => removeAttachment(current, index))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Button type="button" variant={recording ? "default" : "outline"} size="icon" onClick={() => void toggleRecord()} aria-label={recording ? "Stop recording" : "Record"}>
              {recording ? <Square size={16} /> : <Mic size={16} />}
            </Button>
            <Button type="submit" disabled={busy || (!text.trim() && files.length === 0)}>Send</Button>
          </div>
        </form>
        {recording ? <p className="mt-2 font-mono text-xs text-primary">Listening{live ? `: ${live}` : "…"}</p> : null}
      </section>
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-xl border border-border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">State of mind</div>
          <p className="mt-2 text-sm leading-relaxed">{mind || "Quiet for now."}</p>
        </div>
        {messages.some((message) => message.role === "assistant") ? (
          <p className="mt-3 text-xs text-muted-foreground">An answer can name the notebook entries it used. The traces on your lines are those draws.</p>
        ) : null}
      </aside>
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
