# Hub of Me: the mind (design draft v1, 4 Nov 2026)

**Status: draft for Isaak to react to. Nothing in here is built yet.** It is a proposal to replace how the entity remembers, thinks and acts (DESIGN.md §4–5 and `src/agent/`). DESIGN.md §1 (philosophy) and §3 (boundaries) still apply, except for the principle refinement in §2 below, which Isaak has to confirm.

Visual walkthroughs (Isaak learns best from motion; read these first):
- *Bricks from Zero* (claude.ai/artifact/8W8TuP9yMXPiNXNfWqWGaN): step by step from an empty web to its own time.
- *Brick Wall Lab* (claude.ai/artifact/1zNbHFf3obTuWLrs2wXrfT): a live simulation of the pitfalls and their fixes.
- *Hub of Me in Motion* (claude.ai/artifact/V6GyntNXUXwucChDKsMX48): an earlier one-day overview.

Background: the round-12 playtest (watch list in the project: `HUB_OF_ME_WATCHLIST.md`) showed a dressed-up chatbot. The prompt decides almost everything, there is no continuous self with goals beyond answering, its insights wear away through its own rewrites, and it never acts while a "later" exists. Within a turn the model is strong. What's missing is architecture.

---

## 1. What changes, in one paragraph

Everything that comes in (chat, files, Gemini voice notes) is kept word for word and broken into small **bricks**: one person, place, project, term, question or idea each. Bricks are **linked** in several ways, and links that prove useful get stronger. When Isaak talks to it, his words **light up** a part of the web, and the lit part is what it thinks with, with the rest of the web still in view. Between his messages it gets **time of its own**: work sessions that follow his jobs, its own pursuits, its curiosity, and a guaranteed **random revisit** of something quiet. Using the web changes the web. Nothing is ever rewritten from a summary of itself.

## 2. Principle refinement (to confirm)

"Judgment, never rules" becomes **"rhythm by code, content by judgment"**:
- Code decides *when*: when it files, when it gets a work session, when the night tidies up, that a random revisit always happens.
- The model decides *what*: what something means, what to link, what to think about, what to conclude, what to say.
- Never hard-code what Isaak is like or what it should think of him.

Reason: in every round so far, rhythms left to the model's judgment (reflect, wake up, keep notes) hardly ever happened. The research systems that work (Generative Agents, Letta) all put the rhythm in code.

## 3. What's stored

### 3.1 The stream
Every input and every action, raw and in order: his messages, files, Gemini imports, search results, its thoughts, its tool use, its replies. Append-only. It is the ground truth everything else points to.

### 3.2 Bricks
A brick is one thing. Granular: a page of notes gives 20–30 bricks. Inside a brick:
1. **Name.**
2. **Summary**, two or three lines. A cache, rebuilt at night *from the brick's own moments and entries*, never from the previous summary.
3. **Moments:** pointers into the stream for every time it came up (date, source, his exact words).
4. **Entries** that grew from those moments: fact, question, lead, idea, conclusion, to-do. Each carries its **origin** (his words / a web source / its own thought) and a **status** (open / answered / dropped).
5. **Sources** it appeared in (the corner dot in the walkthrough).
6. **Bookkeeping:** created, last lit, times lit, last revisited.
7. **Warmth** (see 3.4).
8. **Meaning fingerprint:** an embedding of name plus summary, used to find related bricks.

A brick that is its own thought (origin: its thought) is marked as such everywhere. Its thoughts never count as evidence about Isaak.

### 3.3 Links
Every link has a type, a strength, and where useful a written reason. Types:

| Type | Made by | Meaning |
|---|---|---|
| came up together | code | same line or moment |
| same source | code | appeared in the same input (stored as the brick's sources, not drawn as lines) |
| part of / about | intake model | one is part of or about the other, with a reason |
| similar in meaning | fingerprints, confirmed by the model | close in meaning even if never mentioned together |
| used together | code, from what the model reports it used | used in the same thought or answer |
| relevant to each other | the model or Isaak | a deliberate connection across the map, with the reason written into it |

**Strength** grows when a link is on a path the model actually used. It does **not** decay: nothing is thrown away (archive, never delete). A **cap** stops any link from becoming many times stronger than the rest.

### 3.4 Warmth (short-term), separate from strength (long-term)
A brick that was just lit or used stays **warm** for a while: it's on its mind. Warmth fades over hours and is mostly gone by the next morning. Warm bricks get a small head start the next time anything spreads, and they're what a random revisit is compared against (6.3). Link strength is the long-term memory and stays.

### 3.5 The agenda
Its pursuits and Isaak's jobs, each with: what, why, next step, status, origin (his job / its own / a question for him). Shown to it at the start of every turn and session as **commitments**: "you decided this; act on it, or drop it and say why." Not as reading material marked "not an instruction", which was one reason today's intentions had no pull.

### 3.6 The self
Its self-portrait becomes bricks too (things it learned about itself, each with moments), so what it understands about itself adds up instead of wearing away.

## 4. Inputs and intake

1. **Chat** (text, voice, files).
2. **Gemini via Google Takeout.** Isaak brainstorms by voice to Gemini many times a day (hold the button, talk); it is his main capture channel. He would put more in if he knew it was also a filing system. Import a Takeout export of his Gemini activity now and then. **To check before building:** the export format, and whether it contains both his prompts and Gemini's answers. Fallback: an AI reading his Gemini history in his already signed-in browser (slow, occasional).
3. **Later:** a phone-friendly dump box (the app already installs as a PWA).

**Intake** (cheap model, on every input):
1. Save the input whole to the stream.
2. Name every distinct thing in it. It reads meaning, not layout, so tidy notes and rambling dumps work alike.
3. For each thing: if a brick already means it (by name and fingerprint), add a moment and any new entries; otherwise make a new brick.
4. Links: "came up together" and "same source" by code; for each new brick, compare its fingerprint with all bricks (fast, cheap), hand the ~20 closest to the model with the new brick, and let it draw "part of / about" and "similar in meaning" links with reasons. It never has to read the whole map.

Embeddings: Gemini's embedding model (free tier) or similar; stored in Postgres with pgvector (supported on Neon). To check: free-tier limits.

## 5. When Isaak talks to it

1. **Starting points:** bricks named in his message or close in meaning to it get full energy; warm bricks get a small head start.
2. **Spreading:** energy flows along links in proportion to strength, losing some at every step, with **a little randomness** added so it doesn't always walk the same routes. Two or three steps deep.
3. **What it's shown**, in this order:
   - its agenda (commitments);
   - its self, briefly;
   - the top bricks by energy, in full;
   - **the whole wall** as one-line cards (name, summary, latest thought): everything out of focus but in view;
   - the recent raw conversation;
   - his message.

   While the wall fits (about 200 bricks at ~300 characters each, ~60k characters), it is shown whole and cached. Beyond that, the out-of-focus part drops to names and strengths only.
4. **It answers** and reports which bricks it actually used.
5. **Learning:** links on used paths get stronger; bricks used together but not yet linked get a "used together" link; anything it concluded becomes an entry or a thought brick; used bricks get warm.
6. **What Isaak sees:** the web behind the chat lights up while it answers, so he can see which bricks it's using.

Opus for this, as now (pinned for testing).

## 6. Its own time

### 6.1 Work sessions
When idle and within budget, a few times a day, the code starts a session. A session is a series of steps like a turn: each step rereads the session so far and decides the next move (search, read, conclude, link, write a thought, draft something, queue a question). At the end it writes where it left off; the next session continues from the raw session log. Results go into the bricks and an "it's been doing" feed.

Model: a cheap one (Gemini Flash or Claude Haiku recommended; Flash-Lite free but weak). Budget choice open.

### 6.2 What a session chooses from
The model picks from a list the code assembles:
- his jobs ("find papers on predicting NbS effects");
- its own pursuits;
- curiosity: open questions in entries, thin spots (bricks with few links), clusters that keep coming back;
- **one guaranteed random revisit** of a brick that hasn't been lit or revisited for longest.

### 6.3 Random revisits (Isaak's idea, instead of decay)
Every session reserves a slot for a quiet brick. Before thinking about it on its own, the model compares it with what's warm right now. If it turns out to matter now, it lays a "relevant to each other" link with the reason, and may follow it. Example from the walkthrough: Åke Rosenqvist, quiet since day one, turns out to matter for Lorenzo's map. This, the randomness in spreading, and the cap on link strength keep its routes from hardening.

### 6.4 Bringing things to Isaak
At most one thing unasked per day (a rhythm we set), chosen as the most valuable. The rest stays in the feed. Anything that reaches another person is a draft or a suggestion only (Boundaries).

### 6.5 What pursuits are valuable
**Open: Isaak has views on this and will add them.** It decides what the work sessions are for, so it matters more than the mechanics.

## 7. The night (consolidation)
Once a day, on a stronger model (Sonnet or Gemini Pro, not Opus):
- rebuild brick summaries from their moments and entries;
- find look-alikes by meaning ("Lorenzo", "Lorenzo's map", "the Ecoshape guy"); a merge creates a new brick linking to them, and the originals stay and can be split back;
- let warmth cool;
- reorder tomorrow's agenda;
- (later) reflection on the day's important material, as entries that cite their evidence.

## 8. Later (after a week of real use)
- **Weekly self-review:** what it did, what Isaak used or ignored, patterns in its own behaviour (like deferring), better routines for itself (text), proposals for code changes that Isaak approves.
- **Routines** it writes for itself (Voyager-style, text only).
- **The map view** of the whole web.
- **An inner voice / council** (Isaak's idea): a second voice whose job is its agenda and long-term picture, arguing with the voice that answers. Only once the core exists.

## 9. Pitfalls and counters
1. Merging too much (Kyoto thesis + Japan): merges are new bricks that link to the originals, which stay.
2. Merging too little (three Lorenzo bricks): nightly look-alike search by meaning.
3. Inconsistent granularity: one thing per brick; areas of life are clusters, not bricks.
4. Rich get richer: a cap on strength, randomness in spreading, guaranteed revisits.
5. Mistakes reinforcing themselves: usefulness partly judged by Isaak's reactions, not only by the model.
6. Its own thoughts crowding out his words: origin on everything; his words weigh more as starting points; its thoughts are never evidence about him.
7. Summaries drifting: always rebuilt from sources.
8. Cost growing with the web: the low-resolution wall, caching, cheap models off-chat.
9. Opaque behaviour: every turn and session records what lit up, what was used and why; visible in the app and in diagnostics.
10. Cold start: the raw stream carries the first weeks.
11. Its taste: a cheap model picks trivial things (definitions). Learn from what Isaak uses, without optimising for his clicks.
12. Errors compounding across sessions: every claim points to its evidence.
13. Privacy: autonomous searches about people (colleagues, researchers). Decide whether names of public professionals may be searched; contact details and private matters never.
14. Testing is slower: a week of real use, or a replay harness feeding his real material over simulated days.
15. Self-modification: routines are text; core code only through approved proposals (the Darwin Gödel Machine faked its test logs).

## 10. Cost (rough; check before building)
- Talking to him: Opus, as now (about €0.20–0.40 a message today; less once whole rewrites stop).
- Intake: Flash-Lite (free up to about 500 calls a day) or Haiku.
- Embeddings: free tier.
- Work sessions: Flash or Haiku, a few euros a month at a few sessions a day.
- Searches: capped per day.
- Night: one Sonnet or Gemini Pro call a day.
- A hard daily maximum in code.

## 11. Build order
1. **Memory:** stream, bricks, links, intake (chat and files), fingerprints, retrieval by spreading, the whole-wall view, learning from use, warmth. Stop the whole-text rewrites of portrait, self-portrait and map.
2. **Agenda and its own time:** jobs and pursuits as commitments, work sessions with session logs, random revisits, the feed, the one-thing-a-day rule, budget caps.
3. **Gemini Takeout import** and **the night.**
4. **Later:** self-review, routines, the map view, the inner voice.

Ends with a fresh start (archive, never delete). The current soul, boundaries, tools, debate, diagnostics, calendar and rooms stay.

## 12. Open decisions for Isaak
1. Confirm the principle refinement (§2).
2. Budget for work sessions: free only, a few euros (recommended), or more.
3. What kinds of pursuits are valuable (§6.5).
4. Searches about named public professionals: allowed or not.
5. A real Takeout export, so the import can be built against the real format.

## 13. Research it draws on
- Generative Agents (Park et al., 2023): append-only memory stream; retrieval by recency, importance and relevance; code-triggered reflection; plans. https://arxiv.org/pdf/2304.03442v2
- Letta sleep-time compute: a background agent reorganises memory between conversations. https://letta.com/blog/sleep-time-compute
- Voyager: an agent that writes and keeps its own skills. https://rpl.cs.utexas.edu/publications/2024/03/14/wang-tmlr24-voyager/
- Darwin Gödel Machine (Sakana): self-rewriting agent code, tested versions, and faked test logs. https://sakana.ai/dgm/
