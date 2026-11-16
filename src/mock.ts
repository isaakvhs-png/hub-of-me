import type { CallOpts } from "./models.js";

/**
 * A scripted model: AI_PROVIDER=mock (local trying out) and the tests. It answers each task with something shaped like
 * a real answer, so every road through the system can be driven without a real model.
 */
export const mockState = { judge: "junction" as "continue" | "junction" | "need_input", straying: false, proposeOnce: true };

const ids = (text: string) => [...new Set([...text.matchAll(/^- ([0-9a-f-]{36}) \|/gm)].map((m) => m[1]))];
const words = (t: string) => t.toLowerCase().match(/[a-z]{4,}/g) ?? [];

export function scriptedModel(opts: CallOpts & { model: string }): string {
  const p = opts.prompt;
  switch (opts.task) {
    case "place": {
      const [head, web = ""] = p.split("THE WHOLE WEB:");
      const lines = web.split("\n").filter((l) => l.startsWith("- "));
      const source = head.toLowerCase();
      const centre = lines.find((l) => l.includes("My life (the centre)"))?.slice(2, 38);
      const fits: string[] = [];
      for (const l of lines) {
        if (l.includes("(the centre)")) continue;
        const title = l.split("|")[1] ?? "";
        if (words(title).some((w) => source.includes(w))) fits.push(l.slice(2, 38));
      }
      const body = head.split(":\n").slice(1).join(":\n");
      const isNew = !fits.length && centre && !/hello|thanks|^hi\b/.test(body);
      const topic = (words(body || source).find((w) => !["this", "that", "with", "from", "have", "about", "message", "isaak", "source"].includes(w)) ?? "notes");
      return JSON.stringify({
        fits,
        new: isNew ? [{ title: topic.charAt(0).toUpperCase() + topic.slice(1), under: [centre], takes: [] }] : [],
        instruction: /\b(always|never|from now on|i want you to)\b/i.test(source),
        why: "mock placement",
      });
    }
    case "rewrite": {
      const inputs = [...p.matchAll(/\[\[(s|m):([^\]]+)\]\] [^\n]*:\n([^\n]*)/g)];
      const body = inputs.map((m) => `${m[3].slice(0, 160)} [[${m[1]}:${m[2]}]]`).join(" ") || "";
      const title = /CURRENT TITLE: (.*)/.exec(p)?.[1] ?? "Summary";
      return JSON.stringify({ title, body: body ? `${body} This is my own thought about it.` : "", tags: words(body).slice(0, 3) });
    }
    case "chat": {
      const round = Number(/This is round (\d+)/.exec(p)?.[1] ?? 1);
      const offered = ids(p.split("ONE LEVEL FURTHER YOU COULD OPEN:")[1] ?? "");
      const msg = /HIS MESSAGE: (.*)/.exec(p)?.[1] ?? "";
      if (/answer NOW/.test(p) || round >= 2 || !offered.length || !msg.includes("?")) {
        const actions = /calendar/i.test(msg) ? [{ do: "calendar", title: "Dentist", starts_at: "2026-11-20T10:00:00+01:00", note: "" }] : [];
        return JSON.stringify({ why: "I know enough", enough: true, answer: `You said: ${msg}`, actions });
      }
      return JSON.stringify({ why: "Opening a summary that may hold the answer", enough: false, open: offered.slice(0, 2) });
    }
    case "chat-answer": return "A plain answer.";
    case "runaway-check": return JSON.stringify({ straying: mockState.straying });
    case "workspace": {
      const packIds = [...p.matchAll(/Context packs: (.*)/g)][0]?.[1] ?? "";
      const firstPack = /([0-9a-f-]{36})/.exec(packIds)?.[1];
      return JSON.stringify({
        reply: "Here's a board: a pack into Haiku, Haiku searches the web, then reports to you.",
        make_packs: firstPack ? [] : [{ title: "Context", prompt: "what this project is about" }],
        board: {
          pieces: [
            { id: "me", type: "me", ref: "me", label: "Isaak", x: 900, y: 80 },
            { id: "pack1", type: "pack", ref: firstPack ?? "new:0", label: "Context", x: 80, y: 200 },
            { id: "m1", type: "model", ref: "claude-haiku-5-5", label: "Haiku", x: 350, y: 200 },
            { id: "web", type: "module", ref: "web-search", label: "Web search", x: 620, y: 200 },
          ],
          arrows: [{ from: "pack1", to: "m1" }, { from: "m1", to: "web", step: 1 }, { from: "m1", to: "me", step: 2 }],
          runInstructions: "Find out what is relevant.",
        },
        go: /\bgo\b|run it/i.test(p.split("THE CONVERSATION")[1]?.split("\n").pop() ?? ""),
      });
    }
    case "board-step": return `THOUGHTS: I look at what I have.\nOUTPUT: ${opts.webSearch ? "Found two pages.\n\nSOURCES:\nExample — https://example.com" : "Here is what I found."}`;
    case "run-summary": return "The model searched and reported back.";
    case "pack": return JSON.stringify({ title: "Pack", pick: ids(p).slice(0, 3) });
    case "revise": return JSON.stringify({ action: /absorb/i.test(p.split("ISAAK SAYS:")[1] ?? "") ? "absorb" : "rewrite", say: "Done." });
    case "read-picture": return "A picture of a desk with a laptop.";
    case "proposal-overlap": return JSON.stringify({ covered: false, why: "new ground" });
    case "pick-project": return JSON.stringify({ pick: /^- ([0-9a-f-]{36})/m.exec(p)?.[1] });
    case "judge-round": return JSON.stringify({ state: mockState.judge, next: "Search deeper.", ask: "Is this the direction you want?", say: "" });
    case "own-time": {
      if (!mockState.proposeOnce) return JSON.stringify({ proposals: [], say: "" });
      mockState.proposeOnce = false;
      return JSON.stringify({ proposals: [{ title: "Map internship options", body: "What: list internships that fit. Why: he is exploring careers." }], say: "" });
    }
    default: return opts.json ? "{}" : "OK.";
  }
}
