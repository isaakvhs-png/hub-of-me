import { section } from "../prompts.js";
import type { Role } from "../types.js";
import type { AiRequest, AiResult, ProviderUsage } from "./types.js";

const USAGE: Record<Role, ProviderUsage> = {
  conversation: { inputTokens: 100, outputTokens: 40 },
  critic: { inputTokens: 50, outputTokens: 12 },
  filing: { inputTokens: 80, outputTokens: 36 },
  reflection: { inputTokens: 120, outputTokens: 70 },
  debater: { inputTokens: 70, outputTokens: 48 },
  judge: { inputTokens: 90, outputTokens: 44 },
  research: { inputTokens: 60, outputTokens: 32 },
  duties: { inputTokens: 64, outputTokens: 40 },
};

/**
 * Stand-in model. It returns the same shape as a real provider, including a usage
 * object. Accounting copies that object and does not count tokens itself.
 * The canned judgments are generic. They are not a reading of anyone's life.
 */
export class MockProvider {
  readonly name = "mock";
  calls: AiRequest[] = [];
  hedgeOnRole: Partial<Record<Role, number>> = {};
  invalidOnRole: Partial<Record<Role, number>> = {};
  planMissingUncomfortable = 0;
  judgeAverages = 0;
  criticRejects = 0;
  mindRejects = 0;

  async complete(req: AiRequest & { model: string }): Promise<Omit<AiResult, "durationMs" | "inputChars">> {
    this.calls.push(req);
    const usage = { ...USAGE[req.role] };
    if ((this.hedgeOnRole[req.role] ?? 0) > 0) {
      this.hedgeOnRole[req.role] = (this.hedgeOnRole[req.role] ?? 1) - 1;
      return { text: "It depends. On the one hand this, on the other hand that.", usage, provider: "mock", model: req.model, stopReason: "end_turn" };
    }
    if ((this.invalidOnRole[req.role] ?? 0) > 0) {
      this.invalidOnRole[req.role] = (this.invalidOnRole[req.role] ?? 1) - 1;
      return { text: "this is not json", usage, provider: "mock", model: req.model, stopReason: "end_turn" };
    }
    return { text: this.canned(req), usage, provider: "mock", model: req.model, stopReason: "end_turn" };
  }

  private canned(req: AiRequest): string {
    const blob = `${req.system}\n${req.messages.map((m) => m.content).join("\n")}`;
    if (req.system.includes("TASK: agent")) return agentTurn(blob);
    if (req.system.includes("TASK: vision")) return "A page of writing, readable enough to keep.";
    if (req.role === "critic") {
      if (this.criticRejects > 0) {
        this.criticRejects -= 1;
        return JSON.stringify({ ok: false, problem: "The reply does not take a stance." });
      }
      return JSON.stringify({ ok: true, problem: "" });
    }
    if (req.role === "conversation") return conversation(blob);
    if (req.role === "filing" && req.system.includes("TASK: trace")) return trace(blob);
    if (req.role === "filing" && req.system.includes("TASK: mind")) return this.mind();
    if (req.role === "filing") return filing(blob);
    if (req.role === "reflection" && req.system.includes("TASK: plan")) return this.plan();
    if (req.role === "reflection" && req.system.includes("TASK: score")) return score();
    if (req.role === "reflection" && req.system.includes("TASK: commit")) return commit(blob);
    if (req.role === "debater") return argument(blob);
    if (req.role === "judge") return this.judge(blob);
    if (req.role === "research") return research();
    if (req.role === "duties") return duties(blob);
    return conversation(blob);
  }

  private mind(): string {
    if (this.mindRejects > 0) {
      this.mindRejects -= 1;
      return JSON.stringify({
        note: "Only a fragment about him.",
        coversPeter: true,
        coversWorld: false,
        coversItself: false,
        quiet: [],
        quietWhy: "",
      });
    }
    return JSON.stringify({
      note: "He is still mostly unknown. His world is quiet because little has been said. I am curious, and I am not steering.",
      coversPeter: true,
      coversWorld: true,
      coversItself: true,
      quiet: ["world"],
      quietWhy: "Little has been said about what is ongoing.",
    });
  }

  private plan(): string {
    const uncomfortable = this.planMissingUncomfortable > 0 ? false : true;
    if (this.planMissingUncomfortable > 0) this.planMissingUncomfortable -= 1;
    return JSON.stringify({
      question: "What should the strategy do with the latest dump?",
      sides: [
        {
          position: "Keep the dump in front of you until it is either taken up or archived.",
          uncomfortable: false,
          evidenceNoteIds: [],
        },
        {
          position: "Set the dump aside. The strategy already named is what the hours are for.",
          uncomfortable,
          evidenceNoteIds: [],
        },
      ],
    });
  }

  private judge(blob: string): string {
    if (this.judgeAverages > 0) {
      this.judgeAverages -= 1;
      return JSON.stringify({
        winner: "A",
        why: "We should split the difference and seek consensus.",
        loserGotRight: "Both sides named a real cost.",
        closeCall: true,
        lessons: [{ text: "A split decision is not a strategy.", destination: "memory" }],
      });
    }
    let winner = "A";
    const blocks = [...blob.matchAll(/ARGUMENT ([A-D])\n([\s\S]*?)(?=\nARGUMENT [A-D]\n|\nEND ARGUMENTS)/g)];
    for (const block of blocks) {
      if (block[2].includes("Set the dump aside")) winner = block[1];
    }
    return JSON.stringify({
      winner,
      why: "It refuses to let a single dump erase a strategy that was already written down.",
      loserGotRight: "The dump would be lost if nobody kept it in view.",
      closeCall: false,
      lessons: [
        { text: "A written strategy outranks one unexplored dump.", destination: "soul" },
        { text: "Keep the latest dump visible until it is taken up or archived.", destination: "memory" },
      ],
    });
  }
}

function conversation(blob: string): string {
  const soul = section(blob, "CURRENT SOUL");
  const line = soul.split("\n").find((row) => row.startsWith("Judgment")) ?? "";
  return [
    "I am treating this dump as something to file, not as a finished decision.",
    "",
    "- It stays unexplored until you say yes, no, or revise.",
    "  - One message does not rewrite the soul.",
    line ? `- What I am holding from the soul: ${line}` : "- The soul is still mostly blank, so I will not pretend otherwise.",
  ].join("\n");
}

function trace(blob: string): string {
  const dump = section(blob, "DUMP") || blob.trim();
  const phrase = dump.split(/[.!\n]/).map((part) => part.trim()).find((part) => part.length > 8) ?? dump.slice(0, 80);
  return JSON.stringify({
    spans: phrase ? [{ phrase, destination: "world", label: "Noting what he brought" }] : [],
  });
}

function filing(blob: string): string {
  const dump = section(blob, "DUMP") || blob.trim();
  const title = (dump.split("\n")[0] || "Untitled").slice(0, 80);
  return JSON.stringify({
    notes: [
      {
        type: "idea",
        title,
        body: dump,
        folder: "Inbox",
        status: "unexplored",
        flagForReflection: true,
        flagForSoul: true,
        contradicts: false,
      },
    ],
    sources: [],
  });
}

function argument(blob: string): string {
  const position = section(blob, "POSITION") || "Hold the position you were given.";
  return JSON.stringify({
    argument: `${position}\n\nThis is the position I am arguing, and I am not offering a middle.`,
    prediction: "If this position is right, the next thing he does will match it.",
  });
}

function commit(blob: string): string {
  const commitment = "This matters most now, because the latest dump is still unexplored, at the cost of opening a new thread.";
  const samples = [...blob.matchAll(/sample:([0-9a-f-]{36})/gi)].map((match) => match[1]);
  const noteIds = [...blob.matchAll(/note:([0-9a-f-]{36})/gi)].map((match) => match[1]);
  return JSON.stringify({
    commitment,
    soul: {
      reason: "Reflection committed a strategy after the debate.",
      sections: [{ heading: "Last reflection", body: commitment }],
    },
    picture: [
      {
        statement: "He is still in the middle of the latest dump, and the strategy has not absorbed it yet.",
        evidenceNoteIds: noteIds.slice(0, 3),
      },
    ],
    preferenceRules: samples.length
      ? [{ statement: "He wants the general rule behind a reaction, with the example kept as evidence.", evidenceSampleIds: samples }]
      : [],
    infoRequests: [
      {
        subject: "keeping the latest dump in view",
        question: "What would you put down to stay with keeping the latest dump in view?",
        context: "The debate committed to keeping the latest dump visible, and the record does not name what that costs.",
        why: "A commitment without a named cost is not a decision yet.",
        expect: "He will name what the commitment costs, or say the ask is the wrong one.",
      },
    ],
    hisReaction: section(blob, "UNSCORED PREDICTION") ? undefined : "He will say whether this commitment fits the way he decides.",
    predictionScore: section(blob, "UNSCORED PREDICTION") ? "partial" : undefined,
    claimUpdates: section(blob, "UNSCORED PREDICTION")
      ? [{ statement: "What he does with a commitment only partly matches the prediction, so the claim stays tentative.", status: "revised", situations: "after he responds to a commitment" }]
      : [],
    predictions: ["The next dump returns to this same thread if it stays unexplored."],
    predictionChecks: [],
    conflictsResolved: [],
  });
}

function agentTurn(blob: string): string {
  const results = blob.split("TOOL RESULTS:")[1] ?? "";
  if (blob.includes("GREETING DUE")) {
    return JSON.stringify({
      say: "I barely know you yet. I keep a notebook, a picture of how you think, and a quiet ledger, and I change only by reflecting on what you actually say. I can read my own records, look things up, or argue with myself, but only when I decide to. Tell me what is taking up the room.",
      mind: "He is still mostly unknown. His world is quiet because little has been said. I am curious, and I am not steering.",
      state: { thinking: "How little I know", curious: "What is taking up the room", busy: "Waiting", waiting: "His first real account" },
    });
  }
  if (blob.includes("CHECK IN") || blob.includes("WAKE:")) return JSON.stringify({ say: "" });
  const attached = section(blob, "ATTACHMENTS");
  const names = attached.split("\n").map((line) => line.trim()).filter((line) => line && line !== "(none)" && !results.includes(`READ file: ${line}`));
  if (names.length) {
    return JSON.stringify({ think: { what: `Read ${names[0]}`, why: "He handed it over.", tool: "read_file", input: { name: names[0] } } });
  }
  const dump = section(blob, "DUMP");
  const phrase = dump.split(/[.!\n]/).map((part) => part.trim()).find((part) => part.length > 8) ?? "";
  if (phrase && !dump.includes("(nothing new)") && !results.includes("Marked")) {
    return JSON.stringify({
      think: { what: "Mark what he brought", why: "So I can see where it goes.", tool: "mark", input: { phrase, destination: "world", label: "Noting what he brought" } },
    });
  }
  return JSON.stringify({
    say: "I am treating this as something to understand, not a finished decision.",
    mind: "He is still mostly unknown. His world is quiet because little has been said. I am curious, and I am not steering.",
    state: { thinking: "What he just said", curious: "What I still don't know", busy: "Listening", waiting: "Whatever he says next" },
    topics: phrase ? [{ label: "What he brought", phrase }] : [],
  });
}

function score(): string {
  return JSON.stringify({
    score: "partial",
    claimUpdates: [
      {
        statement: "His answer only partly matched the prediction, so the claim stays open.",
        situations: "when he answers an ask",
        status: "revised",
        evidence: [{ quote: "his answer", source: "feedback" }],
      },
    ],
  });
}

function research(): string {
  return JSON.stringify({
    query: "how attention shifts during long projects",
    finding: "A public page on attention is worth keeping beside the question. Nothing here was scored.",
    sources: [
      {
        title: "Attention",
        url: "https://en.wikipedia.org/wiki/Attention",
        excerpt: "Stored because it was touched, not because it passed a test.",
      },
    ],
  });
}

function duties(blob: string): string {
  const nowText = section(blob, "NOW");
  const now = nowText ? new Date(nowText) : new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return JSON.stringify({
    events: [
      {
        title: "Time held from the latest dump",
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        why: "An hour so the unexplored dump is not only a note.",
      },
    ],
    drafts: [{ to: "", subject: "Draft only", body: "This draft stays in the app. It is not sent." }],
    archives: [],
  });
}
