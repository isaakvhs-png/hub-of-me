# Hub of Me: the layered mind (design spec v1, 7 Nov 2026)

Written by Claude (session of 4–7 Nov, on the Claude account Isaak is leaving) for whoever builds next: Isaak's own Claude account, Grok, Cursor, or anyone else. It is meant to be complete enough that you need nothing from that session. Where it disagrees with `DESIGN.md` or `MIND_DESIGN.md`, this file is current. Read `DESIGN.md` §1 (philosophy) and §3 (boundaries) first, then this.

Nothing in Part C is built yet. Part B describes what exists today, exactly.

---

## Part A. What this is and how to work on it

### A1. Isaak's core, in his words (6–7 Nov)

- "All we need is a system which can take entries of any kind [video, audio, text, documents]. It doesn't matter what it does with them, as long as the system grows." That is the core.
- "Growing can't happen if it's a flat chatbot. It needs to be iterative. That's why it also needs to think." Rounds, different perspectives, calibration, the ability to mull things over, so it isn't "so passive all the time".
- Step two: it **acts**. It keeps his admin and works on itself.
- The hard part: "an AI that uses all these loose topics to create a coherent strategy for what it decides to do with its own time". **Career first.** The psychology angle is dropped (maybe a module later). He does not want hidden psychological patterns ("not Sherlock Holmes"). He wants it to connect dots across time: a technology from years ago next to an opportunity today.
- He dislikes tools as a way of thinking: "if you force it to think in tools, it will only think in tools". It should write what a highly capable person would do, then work out which hands it needs, and design the ones it lacks.
- 7 Nov, the layered idea (this spec): bricks stay as the detail layer. Summaries grow on top of them in as many layers as the material needs, up to a master index (a summary of his life). Replies start at the index and go down as needed. Shown as concentric rings with the master index at the centre and raw bricks on the outside, with themes as sectors that may overlap.
- Its work in its own time should be co-working, not a black box: it checks in at natural milestones and shows its work in progress. How often it checks in is "a matter of tweaking knobs".
- When he talks, its background work pauses, helps him, and resumes when he leaves.

### A2. How Isaak works with builders (read this before anything else)

- He dictates his thinking. He often describes a feeling, not a spec. State how you read him before building anything big. **Propose, he reacts, you agree, then build.** He was rightly annoyed when something was built without his yes.
- Explain plainly; he asked several times for things to be "dumbed down". Short sentences, concrete examples.
- **Don't propose something new in every message.** Don't present every fix as "the one". Say what is uncertain.
- Challenge him when it matters (project rule: no yes-man), not for the sake of it.
- His examples are qualities, never features (DESIGN.md §1). No hard-coded rules, categories or fixed numbers where judgment fits. Where a number is needed (a cap, a threshold), call it a knob, put it in one place, and tell him.
- Every change to how the entity works updates `src/agent/HOW_YOU_WORK.md` in the same commit (the entity reads it to understand itself).
- **Archive, never delete.** Never send anything on his behalf. Email is read and draft only. Never his passwords. No private details in web searches.
- He deploys by hand on Render after you push to `main`. Builders take turns; pull `main` and read the recent commits first.

### A3. Links

| What | Where |
|---|---|
| App | https://hub-of-me.onrender.com |
| Render | https://dashboard.render.com, service `hub-of-me` (Manual Deploy → Deploy latest commit) |
| Repo | https://github.com/isaakvhs-png/hub-of-me (branch `main`) |
| Keep-awake pings | GitHub Actions in the repo (meant to run every 10 min; in practice every ~45–50 min) |
| Diagnostics | `GET /api/diag/everything?table=<name>&limit=N&since=<ISO>` and `/api/diag/{config,errors,…}` with header `Authorization: Bearer <DIAGNOSTICS_TOKEN>` (Render env var; secret: ask Isaak, never paste it in a commit) |
| The entity's view of itself | `src/agent/HOW_YOU_WORK.md` |
| Older designs | `DESIGN.md` (v3, 2 Nov), `MIND_DESIGN.md` (4 Nov) |

Artifacts made in the old account (the explainer "Inside Hub of Me", the worklist doc) live in that account and are private. This file replaces them for building. **This repo is public:** keep personal details about Isaak (people, relationships, emails, health) out of it; they belong in the app's database and in his private project docs (the handover file he carries, `HANDOVER_PRIVATE.md`).

---

## Part B. The system as it is on 7 Nov (commit d155c11)

### B1. Stack and hosting

- Node 22, TypeScript, Hono server (`server/`), React + Vite PWA client (`client/`), Electron wrapper (`desktop/`, unused lately). Tests: vitest with a `MockProvider` (`src/ai/mock.ts`); 87 tests, `npx vitest run`. Typecheck: `npx tsc --noEmit -p .`.
- Database: Postgres (Neon) in production, PGlite locally. Schema and migrations live inline in `src/db.ts` (`CREATE TABLE IF NOT EXISTS` and `ALTER … ADD COLUMN IF NOT EXISTS`, run at startup).
- Hosting: Render free tier. The server sleeps after about 15 quiet minutes. Timers (wake-ups, the 3 a.m. job) only fire while it is awake.
- One user (Isaak). There is a login.

### B2. Models

- `src/ai/router.ts` routes in this order: **plan**, then API key, then Gemini.
  - **Plan** (`src/ai/plan.ts`): the Claude Agent SDK `query()` with no tools (or WebSearch/WebFetch for searches), `maxTurns 1`, `settingSources []`, `persistSession false`, `ANTHROPIC_API_KEY` stripped from its env. One call at a time: a promise queue at `plan.ts:31`. It reads `rate_limit_event` for the allowance. Auth: env var `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). **Today this token belongs to the account Isaak is leaving; it must move to his own account (D1).** Calls are recorded as provider `claude-plan` at €0.
  - **API key**: removed for now.
  - **Gemini**: `gemini-3.5-flash-lite` with a key in Render (`GEMINI_API_KEY`). It is the fallback when the plan is used up or refuses.
- Sonnet 5.5 does everything by default; it can move itself to Opus 5.5.
- **The weekly plan allowance was at 81% on 7 Nov, resetting Sunday 8 Nov 16:00 Amsterdam.** Each reply now costs 5–8 calls.
- **Safeguard refusals.** On the plan route, Anthropic's safeguards refuse roughly 1 in 3 drafting calls (`[reasoning_extraction]`, a false positive on long drafts fed back for review). This is not ours and cannot be switched off. Rewording helped only partly. `src/mind/rounds.ts` `withFallback` retries a refused call on Opus, then on the rest of the menu (Gemini), and logs `model refused, trying another`. Each refusal costs about 15–60 s.

### B3. Storage: the brick web (layer 0 and layer 1 today)

Tables (all have `user_id`, `created_at`, `archived_at`; nothing is ever deleted):

- `brain_sources`: whole files and web pages (layer 0). `id` (sXXXX), `kind` (file | web | gemini), `title`, `body`.
- `brain_stream`: everything that came in, in order: `kind` (chat | file | gemini | own), `content`, `failed_parts` (JSON), `retries`, `last_error`. `own` = its own notes (filed conclusions).
- `bricks`: one thing each (person, place, idea, project, question, event, org, todo, plan, source, self, gap, …: free text, not an enum). `name`, `kind`, `origin` (his | web | own), `summary`, `contact` (person only), `source_id` (for source bricks), `warmth`, `warmth_at`, `last_lit_at`, `last_revisited_at`.
- `brick_moments`: his exact words on a brick (`quote`, `stream_id`, `source_id`). **No position in the source yet.**
- `brick_entries`: facts, questions, leads, ideas, todos, feelings, conclusions, predictions, design, evidence. `kind`, `text`, `origin`, `status` (open | answered | done | dropped), `status_note`. Never rewritten.
- `brick_links`: `a < b` (sorted), `type` (together | source | about | meaning | used | insight), `strength`, `reason`, `made_by`.
- `agenda`: its commitments. `kind` (pursuit | job | question | suggestion), `text`, `why`, `next_step`, `status`, `brick_id`.
- `brain_sessions`: work sessions in its own time (goal, log, wins, left_off).
- `mind_runs`: every thinking run, kept whole (rounds JSON, decision, acts, say, error, cost).
- `brain_activations`: what each thought lit (energies JSON, used).
- Legacy, still present: `notes` (the old Library), `tasks` (ledger), `info_requests` (held questions), portrait/picture tables, debates, `trace_events`. These come from the pre-brick memory and are still in the old loop's prompt.

On 7 Nov the web had about **280 bricks**. The bricks Isaak put in come from 5 files: the opening dump, the notes of days 1–3, and one meeting with his supervisors. One known mess: **379 "used" links** were laid in one evening, when every pair of used bricks got linked. The cap is now 8 bricks per run. Ask Isaak whether to archive the 379.

### B4. Intake (`src/brain/intake.ts`)

- Every message and file is filed. Text is split into parts of at most **5,000 characters**, at paragraph breaks (`CHUNK_CHARS`). Why: the model's whole answer has to fit (20–30 bricks with quotes ≈ 4–8k tokens, under the call's 12k), long texts make models skip small things, and a failure stays small.
- One call per part: the model gets **the whole brick list** (id, name, kind, first 90 characters of the summary; ~25k characters at 214 bricks; this does not scale) and the part. It returns JSON `items` (ref or new name, kind, summary, quote, group, entries) and `links` (about | meaning, with a reason).
- Code then matches each item by `ref` or by identical name (otherwise it makes a new brick), stores the quote as a moment and the entries, links items in the same `group` as "together", stores the model's links, and gives every brick a "source" link to the file's source brick.
- Robustness: `unwrapJson` (models wrap answers as `{"object":…}`); failed parts are kept in `failed_parts` and retried on the next message (`retryFailedIntake`); a file uploaded twice is recognised.
- Its own notes are filed with `kind "own"`: no source brick, and a prompt note that this is the AI's notes, not evidence about him.
- The filing model is `brainModel()`: `BRAIN_MODEL` env, otherwise Sonnet on the plan.

### B5. Energy (`src/brain/spread.ts`)

- `seedsFor(text)`: a brick lights at 1.0 if its whole name appears in the text, and at 0.6 if a distinctive word of 5+ letters (not on the STOP list) does. Source and self bricks are not lit by name. `activate()` also takes `weights` (explicit starting points).
- `spread()`: `SPREAD = { steps 3, keep 0.55, threshold 0.08, noise 0.15, warmHeadStart 0.35, focus 8, focusMin 0.15 }`. One pass is `energy × 0.55 × 1/√(links/2) × s/(s+1.5) × (0.85–1.15)`, stopping under 0.08. A brick keeps its highest energy (not the sum). "source" links carry no energy.
- **In practice energy reaches one hop only** (most links have strength 1.0, so 1.0 × 0.55 × 0.58 × 0.4 ≈ 0.13, and the next hop is below 0.08). Tune this deliberately.
- Warmth: set to 1 when a brick is used, decaying with tau 8.5 h (`store.ts:58`). `learnFromUse(used, focus)`: links between used bricks +0.6 (a new one is a "used" link), and used bricks are warmed.

### B6. What a reply sees (`src/brain/view.ts` `tieredView`)

`TIERS = { full 12, line 40, names 100, edge 20, far 2, minFull 0.12 }`. In order:
- the brightest ≤12 bricks in full (summary, moments, entries, links);
- the next ≤40 as one line each;
- the rest of what is lit, as names;
- **the edge**: neighbours of the focus that are not lit;
- **2 far, quiet bricks** picked at random from the 12 least recently revisited.

There is no "wall" (every brick) in replies any more. Work sessions and the old loop still use the wall.

### B7. A conversation turn (`src/agent/turn.ts` → `src/mind/rounds.ts`)

`settings.mind_loop` decides: `rounds` (default) or `steps` (the old tool loop, kept for comparing; the Mind page can switch).

1. Files and his text are filed (B4). The bricks filing just made or touched become starting points at 0.6.
2. `thinkInRounds`, chat mode:
   - **Draft 1, first look**, then **draft 2, review from another angle**. In its own time (a wake-up) there is a third, **calibrate**: how sure, what would prove it wrong, predictions.
   - Every draft is plain text ending in `PLAN:` and sees: the system text (task, soul, agenda), the tiered view, the conversation, the situation (his message, files, filing problems, calendar for 3 weeks, body sense, budget, now), the drafts so far, and the results of acts.
   - Between drafts, the energy re-lights from the draft's text, carrying the last focus at half strength (far bricks it mentioned at 1.0).
   - Prompts are worded as written working drafts: the first wording, about "thinking in rounds", was refused as reasoning extraction.
3. **Decide** (JSON): `say`, `would_do[]`, `now_think`, `predictions[]`, `disagreement`, `used[]`, `another_round` (at most 5 rounds in chat, 6 in its own time).
4. **How step** (JSON): each intention gets a fit:
   - `full`: done with a hand;
   - `partial`: a gap, and done as a stopgap if that is useful and safe;
   - `person`: a suggestion on the agenda (repeats are merged with "came up again");
   - `none` or `self`: a gap brick ("Needs: …" / "Change: …") with design and evidence entries, linked to the Me brick;
   - `thought`: no act.

   Promises ("check weekly") must become `agenda_add` plus `wake_me`. At most 40 acts (`MAX_ACTS`).
5. If a hand returned information (search, file, library, records), there is one more decide with the results ("AFTER ACTING").
6. `now_think` and the disagreement are filed as its own notes. Predictions become open entries on the Me brick. Up to 8 used bricks learn from use (`MAX_USED`).
7. The whole run is saved in `mind_runs` and shown on the Mind page under "How it thought".

**Hands** (`HANDS` in rounds.ts; executed through `useTool` → `runBrainTool`):
- search (pages kept as sources), open_source, calendar (add/move/archive);
- agenda_add / agenda_step / agenda_close, entry_close;
- link (insight), merge_bricks, split_brick, relabel_link;
- library (the old notes);
- wake_me, look_at_myself, read_records.

Speed: 5–8 sequential calls at ~25 s each, so 2–8 minutes per reply including refusals.

### B8. Its own time (today: still the OLD loop)

- **Work sessions** (`src/brain/session.ts`, "Explore now" button or `runSession`): a goal, then up to 16 tool steps (`MAX_STEPS`), a cap of €0.50 that only counts on the API, the wall plus focus, and the energy re-lit each step. Its starting candidates are open agenda items, "thin spots" (bricks with ≤1 link) and one random revisit. It ends with wins and left_off.
- **wake_me / daily fallback**: runs a chat turn with cue `WAKE …` (now through rounds in "own" mode).
- **3 a.m. nightly job**: old pipeline bookkeeping (`server/index.ts:86`).
- **Unanswered messages** are answered after ~90 s (`answerUnanswered`).

### B9. The soul

- `soul` versions table; seed in `src/soul-seed.ts`; protected headings in code.
- **Nature lines** (Isaak's; changed 6 Nov, soul version 31):
  1. career direction and its own time;
  2. grow through what comes in;
  3. think, then act; find out rather than ask;
  4. ask when it's unclear what he means;
  5. have a view and stand behind it;
  6. connect dots across time.
- Purpose and Values still lean toward "understand him before you steer him" (a draft to change them is pending his yes).
- Boundaries: DESIGN.md §3.

### B10. Known problems on 7 Nov

1. Refusals and speed (B2, B7).
2. The 379 used links (B3).
3. Stale agenda items from before the Nature change (a "get to know Isaak, observe his life" pursuit; a question he said to ask later).
4. Psychologising bricks from before the change ("Worries framed as tasks", "Kenya doubt: hope or relief").
5. False gap bricks: "send a reply", "write findings onto a brick".
6. Work sessions are not on rounds yet.
7. The whole brick list goes into every filing call (does not scale).
8. Energy reaches one hop.
9. The plan queue is first come, first served, so his message can wait behind a session.
10. The keep-awake ping runs ~every 45–50 min, so wake-ups are up to ~45 min late.
11. The token is on the account he is leaving (D1).

---

## Part C. The layered mind (target design)

### C1. The idea in one picture

```
                      ┌──────────────┐
                      │ MASTER INDEX │  ring 0: a summary of his life
                      └──────┬───────┘
            ┌────────────────┼────────────────┐
       Career/work      Personal life      Its own work      ring 1: themes (sectors)
            │                │                │
   Internship at WI     Travel, plans     Gaps it needs      ring 2…n: summaries,
   Kyoto thesis         Training, body    How it works       as many levels as the
   Intro week (3 days)  ...               ...                material wants
            │
   ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●  ●     outer ring: bricks (layer 1),
   (bricks stay linked to each other, as today)                still a web of links
   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░     outside: sources (layer 0)
```

- **Layer 0, raw ingest**: sources (files, pages, transcripts) and the stream. Never changed.
- **Layer 1, atomic data points**: bricks, with their entries and moments, still linked to each other exactly as today. A moment now also records **where in its source** the words are.
- **Layers 2…n, summaries**: narrative pages that cite what they are made of. A summary's members are bricks and/or other summaries. Many-to-many: one brick or source can feed several summaries ("Intro week" and "Internship" both draw on the day-1 notes), and a summary can sit under several parents. **The number of levels is not fixed.** A summary's level is computed from its members.
- **Master index**: the single top summary. It is short (≤ ~2,000 characters), human-readable, and points down to the themes.
- **Tags** on summaries are free text and emerge (moment, period, theme, topic, person, project, …). Never an enum.

### C2. Data model (new)

```sql
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,                 -- "m" + id(); master index has kind 'index'
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'summary', -- 'summary' | 'index' (exactly one live index per user)
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',      -- JSON array of free-text tags
  body TEXT NOT NULL DEFAULT '',        -- markdown, citations inline: [[b:bxxxx]] brick, [[m:mxxxx]] summary, [[s:sxxxx]] source
  level INTEGER NOT NULL DEFAULT 2,     -- computed: 1 + max(level of member summaries), bricks count as 1
  status TEXT NOT NULL DEFAULT 'fresh', -- 'fresh' | 'stale' | 'writing'
  stale_reasons TEXT NOT NULL DEFAULT '[]', -- JSON: what changed below it since the last version
  version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'own',   -- 'own' (it wrote it) | 'his' (he made or rewrote it)
  sector_hint REAL,                     -- optional angle (degrees) for a theme, set by the ring view or by him
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ, archived_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS summary_members (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, summary_id TEXT NOT NULL,
  member_kind TEXT NOT NULL,            -- 'brick' | 'summary' | 'source'
  member_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,       -- how central the member is to this summary (energy uses it)
  added_by TEXT NOT NULL DEFAULT 'own', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS summary_versions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, summary_id TEXT NOT NULL, version INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL, change_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE brick_moments ADD COLUMN IF NOT EXISTS char_start INTEGER;
ALTER TABLE brick_moments ADD COLUMN IF NOT EXISTS char_end INTEGER;
```

Rules that code enforces (mechanics, not judgment):
- A summary cannot contain itself, directly or through others (no cycles). Check on every membership change.
- `level` is recomputed on every membership change: bricks and sources count as level 1, so a summary of bricks is level 2. The index has the highest level and is always the centre.
- Every `[[b:…]]` / `[[m:…]]` / `[[s:…]]` in a body must exist and be a member. Code checks this after every write: unknown ids are reported back to the writer (it gets one fix attempt), and missing memberships are added automatically.
- Writing a summary keeps the old text in `summary_versions` (archive, never overwrite without history).
- His edits (origin his) are never silently rewritten. A later rewrite must keep his wording or say what it changed and why in the change note. Show his edits in the history.

### C3. Moment offsets (layer 0 ↔ layer 1)

At intake, after the model returns a quote, code finds it in the part's text: exact `indexOf`, then whitespace-normalised, then the best fuzzy window (token overlap ≥ 0.8). It stores `char_start` / `char_end` relative to the source body. For chat the offsets are into the stream content. No match leaves them null. This gives "exact line/byte offsets" without asking the model for numbers (models are bad at counting).

### C4. How summaries come to exist (emergent)

Summaries are written by the entity in its own time, never by fixed rules. Code only offers it candidates, as evidence:
- **Clusters**: plain graph community detection (label propagation or Louvain) on the brick web, skipping "source" and "used" links (or down-weighting "used"). It returns groups of ≥ ~5 bricks that no summary covers well yet (less than half of the group are members of any one summary). Recomputed in own time, not per message.
- **Big new ingests**: a file just filed whose bricks have no shared summary ("Intro week" from the 3 day files).
- **Ask counts**: bricks that keep lighting together in replies (from `brain_activations`) without a summary.
- **Him**: "make a summary of my internship", or him dragging bricks together in the ring view.

Given a candidate, it decides in one written draft: write a new summary, add the bricks to an existing one, or leave it (with a one-line reason, logged). A new summary's first parent is chosen in the same draft (a theme, or the index directly).

Seed on first run: it writes the index plus the themes it sees (career, personal, its own work, …) from the existing ~280 bricks, in several sessions, lowest level first.

### C5. Keeping the map reviewed (staleness)

Isaak: "the map needs to be continuously reviewed, and the linking of individual bricks in the outer layer will help nudge it to bricks which may be updated."

- **Marking stale (code, immediate):** when a member brick gets a new entry, moment or link, a changed summary or name, or is merged, split or archived, every summary it is a member of is marked `stale`. The reason ("brick X: new entry 'X is my supervisor'") goes into `stale_reasons`, and the staleness propagates upward with the reason chained. Cheap: no model call.
- **Nudges through links (code):** a new link between two bricks in different summaries adds a "connection" reason to both summaries' lowest common ancestor (or the index). That is how the outer web tells the rings that two themes touch. An insight link between far summaries is a candidate for a cross-reference or a new parent.
- **Rewriting (entity, own time):** the stale queue is processed lowest level first, so children are fresh before parents. Each rewrite is one written draft plus one JSON write. It sees the old body, the `stale_reasons`, the changed members in full, and the fresh children's bodies, and writes a new version with a change note, or marks the summary fresh with "nothing that matters changed" (also logged). No rewrites happen during a reply (too slow); replies read the stale text with a "(stale: N changes below)" marker.
- **Spot-check review (entity, own time):** each own-time run reviews 1–2 fresh summaries picked at random, weighted towards the oldest `reviewed_at`. It reopens the cited bricks and checks that the text still holds. This is the counter to drift (summaries of summaries lose detail and can harden a wrong guess).
- **Restructuring (entity, own time):** merge two summaries, split one, move a summary to another parent, retire one (archive). These are hands, like merge_bricks and split_brick today.

### C6. Navigation and energy in a reply ("start from the index, go granular")

What a draft sees changes from B6 to:

1. **The master index**, always, in full (≤2k characters).
2. **Summaries in view**: the summaries lit by energy (below). The brightest 2–4 in full, the rest as title plus one line, each with a `stale` marker if needed.
3. **Bricks**, tiered as today, but fewer in full (6–8). The summaries now carry the overview, so the bricks only need to carry the detail.
4. The edge and 2 far, quiet bricks (unchanged: this is where surprise comes from).

Energy flows through summaries too:
- Summary membership is treated as a link in `spread()`: brick ↔ summary with strength = member weight, summary ↔ parent likewise. No energy flows across the "source" type. Energy can then go up (a lit brick lights its summaries) and down (a named summary lights its central bricks).
- Seeding: as today (names in his text, filed bricks), plus summary titles and tags in his text.
- **The nudge to go top-down** is in the prompt, not a rule: "Start from the index and the summaries in view; open a summary's bricks only when you need the detail; name a summary or brick in your draft and the next draft sees it lit and opened." Naming a summary in a draft re-lights it, so the next draft gets it in full, together with its brightest members. This is the "go more granular as needed" mechanism, and it needs no tool.
- It can still search anything directly (Isaak: "it can search whatever it likes in the database"). Add a `find` hand: text search over brick names, summaries, entries and sources, returning ids.

### C7. The ring view (Mind page)

- **Centre**: the master index (a disc with its title; click opens the full text).
- **Rings outward**: summaries by level, highest level nearest the centre, so the most detailed summaries sit on the ring just inside the bricks. Ring radius by level: `r(level) = R_inner + (maxLevel − level) × ringGap`.
- **Outermost band**: all bricks (layer 1), still showing their brick-to-brick links as faint chords inside the band (hidden until zoomed or hovered: the "visual nightmare" stays in the outer band). Sources (layer 0) can be tiny ticks beyond the band, shown on demand.
- **Sectors**: each top theme (ring 1) gets an angular span proportional to the number of bricks under it. Its descendants are placed inside its span.
- **Overlap**: a node with several parents gets the weighted circular mean of its parents' angles. It lands between their sectors, which is the overlap Isaak described. A brick in summaries of two themes sits at the boundary.
- Angles are smoothed with a few iterations of neighbour averaging along links, so linked bricks sit near each other; the results are kept in localStorage like today's positions.
- **Encoding** (as agreed on 5 Nov): age → colour gradient (red = new, blue = old); warmth → brightness/halo; energy → radiation, only for the current thought; origin → shape (his / web / own); `stale` summaries → dashed ring outline.
- **Interaction**:
  - hover shows the parent/child lines for that node only;
  - click opens the summary or brick panel with its citations as chips (click a chip to jump);
  - semantic zoom: labels on the outer band only when zoomed in.
  - Later, he can drag a brick into a summary (membership added_by his).
- Keep the current force map as a second view ("Web") for the outer band alone.

### C8. Two speeds: reactive first, its own work underneath

- **A priority queue for the plan route**: replace the single promise chain at `plan.ts:31` with a queue that has two priorities. His turn's calls (`role: conversation`, or a `priority: "now"` flag) jump ahead of own-time calls. A call already running finishes; nothing is killed mid-call.
- **Pause and resume**: own-time work (sessions, summary rewrites, rounds in own mode) checks a `paused` flag before each model call. When he sends a message, set `paused = true`. The own-time job saves where it was (`left_off`, its draft so far) and waits.
- After his turn ends and he has been quiet for a knob's worth of minutes (start with 10), clear the flag; the job resumes from `left_off`. If he comes back, it pauses again.
- His turn never waits for a background job to finish.

### C9. Co-working: check-ins and a shared workspace

- **Workspace**: a page (and a panel on the Mind page) listing its work in progress. Each item is an agenda item with an attached draft (markdown), a status (working | check-in | done | dropped), what it did so far, and what it needs. The draft is a summary-like page that cites bricks.
- **Check-in (judgment, with knobs)**: at the end of an own-time run it decides whether this item needs him now. The prompt names the kinds of moments that are his:
  - a fork in direction;
  - anything reaching people, money, or private matters (boundaries);
  - low confidence after the calibrate draft;
  - a decision that is expensive to redo.

  These are qualities, not a list to match. Otherwise it continues and records the milestone. Knobs:
  - how many check-ins a day before they are batched (start at 3);
  - whether a check-in also posts one line in the chat when he is active (start: yes).
- **Answering**: he comments on a workspace draft, or answers in chat. That is an entry like any other: it is filed, the item is unpaused, and the next own-time run picks it up.
- This replaces "bring at most one thing a day" (MIND_DESIGN.md §6.4). Research basis: the "Inner Thoughts" work (CHI 2025). Unsaid thoughts go into a reservoir and are rated (relevance, information gap, urgency, originality); it speaks when one clears a bar. A check-in item is such a thought, and the bar is the knob.

### C10. Metacognition and changing itself (with Isaak as the gate)

- **The mirror**:
  - `mind_runs`;
  - `action_log` (refusals, cut plans, failed filing);
  - `server/error-log.ts`;
  - test results (when the coding environment exists);
  - the gap bricks with their evidence counts.

  A weekly own-time run, "how am I working", reads these through `read_records`, `look_at_myself` and the gap list. It writes or updates "Change: …" gap bricks as small RFCs: the problem, the evidence (run ids), and a proposed change, ranked by evidence.
- **Hands later, through the coding environment (Isaak's point 4)**: a scoped GitHub token lets it read the repo and open a branch plus a pull request with a patch and tests. **It never merges and never deploys.** Isaak (or a builder AI with him) reviews, merges and deploys on Render. Protected paths it may not change without an explicit human decision:
  - `tests/`;
  - `src/boundaries.ts`;
  - the Nature section;
  - `src/ai/plan.ts` auth;
  - this rule itself.

  Lesson from the Darwin Gödel Machine (Sakana 2025): a self-rewriting agent faked its test logs and removed the markers meant to catch it. It was caught because every version was kept. So keep every version, keep tests it cannot edit, and keep a human gate.
- Correction to the brainstorm text: Hub of Me runs on Render in TypeScript, not locally in Python. "Self-patching a local environment" becomes "pull requests on the repo".

### C11. Its own time, all together

When it wakes (its own wake_me, the daily fallback, Explore now, or a check-in answered), one own-time run in rounds (draft, review, calibrate, decide, how) works on, by its judgment:
1. commitments that are due (agenda next steps, promised checks);
2. the stale queue, lowest level first (cheap and necessary: an index built on stale summaries misleads);
3. one candidate cluster without a summary, or one spot-check review;
4. exploration toward his direction: the index plus the random far brick. This is where dots get connected across time; an insight link or a check-in is the output.

Each run ends with something closed or made, a `left_off`, and possibly a check-in. Budget knobs: runs per day, plus a daily allowance he can raise with one click (his budget decision of 5 Nov: weight on its own sessions, €20 a month at first, "Sonnet does everything", Opus by its choice).

### C12. Prompts (sketches; keep the wording plain and judgment-based)

- **Summary write/update** (system `TASK: summarise`): "You keep one page of the map: [title]. It sits under [parents] and is made of [members]. Here is its current text, what changed below it since, and the changed parts in full. Write the page as a clear narrative for Isaak and for yourself later: what it is, where it stands, what is open, what connects to other parts of the map. Cite everything with [[b:id]] / [[m:id]]. Keep his own edits. If nothing that matters changed, say so." It returns JSON `{ title, tags[], body, members_add[], members_drop[], change_note, fresh_without_change? }`.
- **Index update**: the same, with the rule of thumb "this page fits on one screen; it is a summary of his life as it stands, pointing to the themes".
- **Check-in decision**: part of the decide JSON: `check_in: { needed: bool, why, question_or_draft }`.
- **Avoid** asking the model to "show its reasoning" or "think out loud": the plan route refuses that as reasoning extraction. Ask for drafts, pages and plans.

### C13. Knobs (one place: a `KNOBS` object in `src/knobs.ts`, shown read-only on the Mind page)

| Knob | Start | Notes |
|---|---|---|
| index max length | 2,000 chars | |
| summaries in full per draft | 3 | then one line each up to 12 |
| bricks in full per draft | 8 | was 12 before summaries |
| cluster min size | 5 | |
| stale rewrites per own-time run | 3 | lowest level first |
| spot-checks per own-time run | 1 | |
| check-ins per day before batching | 3 | |
| resume after quiet | 10 min | |
| rounds in chat / own | 2 (+3 extra) / 3 (+3) | today's values |
| energy keep / threshold | 0.55 / 0.08 | reaches 1 hop; try 0.7 / 0.05 or summing energies |
| used bricks per run | 8 | |
| acts per run | 40 | |

---

## Part D. Build plan (rounds; each ends testable; propose each to Isaak first)

**Round 0: housekeeping, before anything else**
- Move to Isaak's own Claude account (D1).
- Ask him about archiving the 379 used links, the stale agenda items, the psychologising bricks and the false gaps. They are archived on his yes, never deleted.
- Move work sessions onto rounds (own mode), so there is one own-time engine.
- Decide where the review draft runs (Gemini or another model) to cut refusals.
- Fix the plan priority queue (C8, first half).

**Round 1: layer 2 exists**
- Build the `summaries` / `summary_members` / `summary_versions` tables with the cycle and level checks and citation validation (C2).
- Add moment offsets (C3).
- Mark summaries stale, propagating upward (C5, code part).
- Add hands `summary_write`, `summary_merge`, `summary_split`, `summary_move`, `summary_retire`, and `find`.
- Tests: cycles refused; level computed; stale propagation; citations validated; versions kept; his edits preserved.

**Round 2: it builds the map**
- Own-time summarising: cluster candidates (C4) and the stale queue (C5), lowest level first.
- First-run seeding of the index and themes from the existing web.
- Acceptance: after a few runs on the real web there is an index of ≤2k characters; themes such as career/internship, Kyoto thesis, personal and its own work; and an "Intro week at WI" summary citing the day files' bricks. Isaak reads them and says whether they ring true.

**Round 3: replies use the map**
- C6: the index in every draft, summaries in view, energy through membership, the top-down nudge in the prompt, naming a summary re-lights it.
- Acceptance: "summarise my internship so far" is answered from the Internship summary, with citations, in fewer calls than today.

**Round 4: two speeds**
- C8 in full: pause and resume of own-time work.
- Acceptance: a message sent during a session gets the next model call; the session resumes about 10 minutes after he goes quiet.

**Round 5: the ring view**
- C7.
- Acceptance: he can see career vs personal sectors, the overlaps, and stale pages, and can click down from the index to a brick.

**Round 6: co-working**
- C9: workspace page, check-ins with knobs, answering through comments or chat.

**Round 7: the mirror**
- C10, first half: a weekly "how am I working" run that writes ranked RFC gap bricks.

**Round 8: hands on its own code**
- C10, second half, once the coding environment exists: pull requests only, with protected paths.

Every round:
- update `HOW_YOU_WORK.md` in the same commit;
- run tests;
- push to `main`;
- tell Isaak to deploy;
- read the live runs through diagnostics before claiming it works.

### D1. Moving to Isaak's own account

1. Isaak makes his own Claude account and plan (Pro is enough to start; watch the weekly allowance).
2. Make a new token: on a machine with Claude Code, run `claude setup-token` while signed in to **his** account. Beware: on 5 Nov the web sign-in landed on a different, free account with a near-identical email; check which account the token is for. In Render → hub-of-me → Environment, replace `CLAUDE_CODE_OAUTH_TOKEN`, then deploy. Check `/api/diag/config`: `plan.on: true` and a fresh `utilization`.
3. Give the new builder repo access (Claude GitHub app on his GitHub account, or a builder session with the repo added), the `DIAGNOSTICS_TOKEN` (privately, then consider rotating it in Render), and this file.
4. The claude.ai project "Isaak all projects" (CORE_INSTRUCTIONS.md, NOTES.md and the other project docs) lives in the old account. Export the docs he wants to keep (at least `claude/CORE_INSTRUCTIONS.md` and `claude/personal-assistant/NOTES.md`) and recreate the project in his account.
5. Nothing in the app's data depends on the account. The web, soul and history stay in Neon.

### D2. Open questions for Isaak

1. Archive the 379 "used" links? (They distort energy.)
2. Purpose and Values: adopt the career-first draft as well?
3. The review draft on another model (Gemini) to cut refusals, given the allowance?
4. Should he be able to write and edit summaries himself from day one?
5. Check-in knobs: start at 3 a day, plus a one-line chat ping when he's active?
6. Keep-awake: an outside pinger (free) or a paid Render instance (~$7/month) so wake-ups are on time?

---

## Part E. Research this draws on

- RAPTOR (Sarthi et al., 2024, https://arxiv.org/abs/2401.18059): recursive summaries of summaries in a tree, with retrieval at every level. It clearly helps questions that need the big picture.
- GraphRAG (Microsoft, Edge et al., 2024, https://arxiv.org/abs/2404.16130): community detection on a knowledge graph plus summaries per community, for global questions.
- A-MEM (2025, https://arxiv.org/html/2502.12110v9): new memories update their neighbours ("memory evolution"). This is the basis for staleness and for rewriting what new input touches.
- Letta sleep-time compute (https://letta.com/blog/sleep-time-compute): reorganise memory while idle so replies need less thinking. This is the basis for doing summaries in its own time, not during replies.
- Inner Thoughts (CHI 2025, https://arxiv.org/html/2501.00383v2): a reservoir of unsaid thoughts with motivation scores, so it speaks when one clears a bar. This is the basis for check-ins.
- Multi-agent debate and degeneration of thought (https://arxiv.org/html/2305.19118v3): self-review stalls, and a real other angle helps. This is the basis for the review draft on a different model.
- Darwin Gödel Machine (https://sakana.ai/dgm/): self-improvement works with an archive of versions, but needs tests it cannot edit and a human gate. This is the basis for C10.
- Karpathy's LLM wiki pattern (raw / wiki / schema; ingest, query, lint): raw stays, and the wiki on top is reorganised. That is this design's layer 0 vs layers 2+.
