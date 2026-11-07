# Hub of Me: build spec (draft 7, 7 Nov 2026)

**This file is the source of truth for the rebuild.** It replaces `LAYERED_MIND_SPEC.md` (now background) wherever they differ. `DESIGN.md` §1 (philosophy) and §3 (boundaries) still hold. Written for whoever builds: start here, then read the code.

Rule for this repo: nothing personal about Isaak goes in it (people, relationships, health, emails). Examples below are generic on purpose.

---

## 1. What we are building, in one paragraph

A personal AI that takes in anything (messages, files, later audio and video), grows a memory of rings from it (everything kept whole → bricks → pages → one life document), and works in its own time. Every piece of work is **a run** of one engine: gather what it needs, draft and reply, then grade its intentions against its hands and act. A **mirror** sits on top: every run is recorded, a nightly review (by a different model) judges how effective it was and why, and what holds it back becomes a **request** it makes itself. Isaak decides in the workshop; a builder builds; later it writes its own pull requests. Everything is shown live in **one view**: the full system map with the memory rings, lighting up as it works, with chat, workshop and calendar beside it.

### Co-design has two targets (draft 7)
Co-design is the core feature, for **its own design and for Isaak's projects** alike (his internship workflow, his thesis, anything he works on). The same machinery serves both: requests, proposals, goals, bench drafts and pages all carry a **target**: `self` or a project (a page of kind `project` in the web). The workshop shows proposals per target.

## 2. Principles (unchanged from DESIGN.md, plus two)

- Build someone, not something. Judgment, never rules: Isaak's examples are qualities, never features. Where a number is needed it is a **knob** in `src/knobs.ts`, shown read-only in the app.
- Rhythm and safety by code; content by judgment; Isaak is the gate on anything that reaches people, money or private matters, and on changes to how it works.
- Archive, never delete. Every version kept. Never send anything on his behalf. Email read/draft only. No private details in web searches. Never his passwords.
- **Nothing it does is invisible to it.** Every step writes a record it can read; it has read-only hands to inspect any part of itself.
- **It asks for its own hands.** The seed holds only what it needs to notice what it lacks and ask for it. Do not pre-build capabilities "because it will need them"; build them when it requests them and Isaak agrees.
- Every change to how it works updates its self-description (the system map data, §9) in the same commit.

## 3. The parts and the three loops

Twelve parts: **Sources, Intake, The web, Upkeep, You, Run queue, A run, Hands, Workshop, The mirror, Requests, Build.**

- Memory loop: sources → intake → web → runs → its thoughts back into the web; upkeep keeps the web fresh.
- Mirror loop: runs → records → nightly review → requests → build → new hands.
- Isaak's loop: he sends, revises, decides.

The interactive design pages (claude.ai artifacts on Isaak's account) show these in full; this file is the text version.

## 4. Data model (final; simplified from draft 4)

Postgres (Neon) in production, PGlite locally; schema inline in `src/db.ts` as today (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). All tables have `user_id`, `created_at`, `archived_at`. Nothing is deleted.

```
-- Ring 0: everything kept whole (append-only)
stream        (id, kind 'his'|'its'|'system', content, sent_with_source, client_msg_id, at)      -- both sides of the conversation
sources       (id, kind 'file'|'web'|'own'|'video'|'audio'|'contact'|'gemini', title, body, orig_size, stored_size, filed bool, at)

-- Ring 1: bricks
bricks        (id, name, kind (free text), summary, corner 'his'|'own', last_used_at, source_id NULL)
entries       (id, brick_id, kind (free text), text, origin 'his'|'web'|'own', status open|answered|done|dropped|superseded,
               superseded_by, quote, source_id, char_start, char_end, due_at NULL)          -- quotes live here (no separate moments table)
links         (id, a, b, relation (answers a need|supports|contradicts|causes|part of|involves|updates|insight|…), reason, strength, made_by)
               -- only judged links are stored; same source / same page / shared words / similar meaning are computed on demand
embeddings    (brick_id | page_id | source_chunk_id, vector)   -- for similar-meaning search

-- Rings 2..n and the centre
pages         (id, kind 'page'|'life'|'guide'|'track'|'project', title, purpose, body (cites [[s:]] [[b:]] [[p:]]), level (computed),
               status fresh|stale|writing, version, origin own|his, reviewed_at)
page_members  (page_id, member_kind brick|page|source, member_id, weight, added_by)
page_versions (page_id, version, title, body, change_note, claim_changed bool, reason_chain, at)
stale_marks   (id, page_id, route membership|flagged|mention|time|spotcheck|isaak, reason, root_id, triage yes|no|NULL, triage_why, at)
revisions     (id, target_kind, target_id, his_text, its_reply, status open|discussing|applied|declined, applied_version)

-- Work
runs          (id, trigger you|schedule|upkeep|review, purpose, priority, due_at, started_at, ended_at,
               status queued|running|paused|done|failed, left_off, parent_goal_id NULL)
run_steps     (id, run_id, node (map path, e.g. 'run/gather/gplan'), kind call|act|event, label, model NULL,
               ms, chars_in, chars_out, ok, detail JSON, at)          -- ONE log: feeds the live map, diagnostics and the review
packs         (run_id, contents JSON, used JSON)                      -- references (ids + char ranges), never copies of the text: storage stays small
goals         (id, text, why, target 'self'|project_page_id, status, next_run_id)   -- its ongoing work (replaces agenda pursuits/jobs)
bench         (id, kind draft|suggestion|question|checkin|report, title, body, status, refs JSON)  -- everything addressed to Isaak
requests      (id, target 'self'|project_page_id, title, kind, problem, proposal, spec JSON, prediction, depends_on JSON, unblocks JSON, status,
               evidence_runs JSON, evidence_count, protected bool, his_decision, his_why, built_in, proof_run, merged_into)
proposals     (id, target, title, why, request_ids JSON, status, his_decision, his_why)
reports       (id, scale day|week, period, body, signals JSON)
review_actions(id, report_id, type, payload JSON, applied bool)
attention     (id, what, ms, at)                                      -- what Isaak opens in the workshop
heartbeat     (at)                                                    -- for gap detection
```

Kept from today: `calendar` (as is), `users`, `settings`, the soul's **Nature** lines and boundaries (protected). Retired (archived, out of code paths and prompts): see §12.

## 5. The parts, as built

### 5.1 Sources
- Every message both ways goes into `stream` with a client message id (gap/duplicate detection). Files into `sources` with original and stored size. A file sent with a message is linked; the message is the file's framing.
- Bulk sources (a future Gemini archive) can be stored with `filed=false`: searchable, filed when a run pulls one in.

### 5.2 Intake (filing)
- **Files** are filed straight away; **conversation** is filed in batches when Isaak goes quiet (one stretch of dialogue per call: better context, fewer calls). A big upload gets an immediate one-line receipt.
- Split into parts at paragraph breaks (knob, 5,000 chars).
- The filing call (Sonnet) reads: its guide page "How I file", the framing, **the index of every brick** (one line each; knob: whole while under ~60k chars, beyond that pre-selected by words and meaning), the part. The index is refreshed between parts.
- It returns JSON: things (existing id or new), entries with quotes, judged links with relation and reason, **updates** ("replaces what brick X said"), a filing note (doubts, what it could not capture), and for each thing the **corner** (about Isaak's life, or about itself / the system).
- Code: matches or makes bricks, finds each quote's position, marks superseded entries, writes stale marks (§5.4), turns doubts into open questions and merge candidates, turns "couldn't capture" into request evidence, writes an **intake digest** for the reply run (per theme: new, updated, islands).
- A contradiction found by filing after a reply was already given → one follow-up line in the chat.

### 5.3 The web
- Bricks, entries, judged links. Computed relations (same source, same page, shared distinctive words, similar meaning via embeddings) are views, not rows.
- Pages: each has a **purpose** (the question it answers / why it's worth having). Many-to-many membership; level computed; no cycles; every citation must exist (code refuses otherwise). The **life document** is one page of kind `life`, as long as it needs.
- Its own corner: self-guides (`guide`: "How I file", "How I gather", "How I work with Isaak", "How I present things"), the track record (`track`), its notes, its requests (drawn there).
- **Themes** (top pages) get colours and a slice of the rings sized by their content; a brick in two themes sits on the border. The model decides themes; code draws.

### 5.4 Upkeep
- **Six routes** mark a page stale, each with a reason: membership (a member touched), flagged at filing (updates/contradicts), mentions (a page names it or is similar in meaning without citing it), time (a dated entry passed), spot-checks (a random older page reread against its bricks), Isaak's revision.
- Stale queue ordered by importance (Isaak first, then near the life document and recently used).
- **Triage** (fast model): "does this change matter for this page? yes/no + why". "No" stops there, logged.
- **Rewrite** (good model): old text, reasons, changed members → new version + change note + `claim_changed`. Only a changed claim marks the parent.
- Limits: upkeep runs only within the background share of the allowance (§7); one rewrite per page per root cause per day.
- Candidates offered by code: likely duplicates, islands, thin-but-central bricks (high reach, low depth), clusters with no page.

### 5.5 Run queue
- `runs` table, scheduler in code, one model call at a time. Isaak's turn jumps the queue; a background run finishes its current call, saves `left_off`, resumes after he has been quiet (knob, 10 min). Any number of scheduled runs (replaces the single wake-up slot).
- Heartbeat row every minute; an outside pinger (cron-job.org on `/api/healthz`, every 10 min) keeps Render awake. The GitHub Actions ping is retired (private repo minutes).

### 5.6 A run (one engine for everything)
1. **Starter** (code): life document (whole under ~20k chars, else opening + headings), self-guides, conversation so far, intake digest, bricks named in the message.
2. **Gather call** (fast model): which of `find` (words), `similar` (meaning), `near` (direct links, strongest first), `open` (page/brick/source), `web` to use, and why. Code fetches all at once → **context pack** (knob ~60k chars), recorded in `packs`.
3. **Call A** (Sonnet; Opus by its choice): "what would a highly capable person with your memory and a computer actually do now, including what you'd need to do it well and to discuss it with Isaak?", then the reply, **streamed**. Worded as a draft (never "show your reasoning": refused on the plan route). May end with `OPEN:` → one more gather, once.
4. **Grading**: first try a structured tail of call A (saves a call); if malformed, a separate call B. Each intention: done / partly / for Isaak / can't / change to itself / a thought. Promises must produce a scheduled run.
5. **Act** through hands (boundaries checked by code). Thoughts filed as its own notes. Gaps → requests. Bench items for Isaak.
6. Every step written to `run_steps` with its time; what the drafts actually used recorded in `packs.used`.

### 5.7 Hands (the seed set)
- Looking: `find`, `similar`, `near`, `open`, `web`.
- Web work: link, merge, split, relabel, write/revise pages.
- Calendar (add, move, archive); goals (add, step, close); `schedule_run` (replaces wake_me).
- Put on bench (draft, suggestion, question, check-in).
- **Self-inspection, read-only**: `inspect` (query its own records), `audit_file` (a source next to its bricks: what was skipped or misread), `trace_run` (replay a past gather; with hindsight, what should it have pulled in), `read_code` (any file of its own code + the system map data), `explain` (answer about itself with references to map nodes, which the view lights up).
- Everything else (pages/visuals, video/audio intake, email, coding runs, phone) arrives through its requests.

### 5.8 Workshop (a tab beside Chat and Calendar)
- **Your bench**: everything addressed to Isaak (drafts, suggestions, questions, check-ins), plus his own notes and to-dos.
- **Proposals**, per target (itself, or one of Isaak's projects): ready first, each with evidence, spec, prediction, cost; buttons yes / not now / no, because… / revise / discuss; a thread.
- **Reports**: nightly and weekly; what went live and whether it helped.
- "Now" is the live map itself (no separate column). Attention signals record what Isaak opens.

### 5.9 The mirror
- Per run: grading (above).
- **Nightly review** (23:30, knob): code builds the **day file** from `run_steps`, `packs`, filing notes, upkeep, Isaak's messages and reactions, requests, failures; code computes **signals** from the same data; a **different model** from the worker (Opus reviews Sonnet, or Gemini) writes a review draft, then an **action list** (typed actions); code applies them. Tomorrow's day file includes the review.
- Each night also does one **rotating deep check** (filing coverage via `audit_file`, link quality, gathering via `trace_run`, triage "no" answers, page drift, promises, requests…), so every area is examined at least every two weeks.
- **Sundays** the review also looks back over the week: trends, the track record, its own code map → structural proposals.
- Cause → action: missing hand → request; its code → change request pointing at files; its judgment → revise a self-guide (with evidence); memory shape → upkeep job; unclear from Isaak → bench question; a live change → verified or reopened.
- Did the fix work: every request and guide change carries a **prediction**; a week after going live the review compares the target signal; the **track record** page learns which kinds of fixes work. Four layers, then stop.
- **Signals** (counted by code): Isaak's revisions; yes/no/ignored; questions its web could have answered; promises kept/late/broken; goals stuck; refusals and failures; time and calls per run; pack waste; stale backlog and missed staleness by route; filing coverage per source; islands; duplicates merged; attention; allowance used; gaps in the heartbeat; whether the server runs the latest commit.

### 5.10 Requests
- A table (no gap bricks). Call B adds evidence or opens one; the review merges, drops (checking "can an existing hand already do this?"), ranks **enabling requests** (those that unblock others) first, bundles related ones into proposals. Ready after 2 runs (knob) or when blocking. Declined ones stay visible with Isaak's reason. Protected flag set by code.

### 5.11 Build (toward changing its own code)
- Stage 1 (now): a builder builds from the spec, runs the bench, pushes; Isaak deploys. Stage 2: it writes full specs. Stage 3: a coding run opens pull requests. Stage 4 (maybe): test copy. It never merges or deploys live.
- **The bench**: the stress tests as cases (`tests/bench/`), runnable with the mock model; tests it cannot edit; protected paths (`tests/`, `src/boundaries.ts`, the Nature section, `src/ai/plan.ts` auth, this rule).

### 5.12 Isaak
- Revise anything (it may push back once, with evidence; then his word stands); hand edits possible; decide on proposals and anything reaching people/money/private matters; deploy.

## 6. The single view (client)

One screen: **the full system map with the memory rings** in the middle row, a **side panel** with tabs **Chat | Workshop | Calendar | Selected box**, and an **activity strip** with replay under the map. Reference: the "single view mock-up" artifact.
- Map data = the system map description (§9), rendered as nested frames (every part open), pan/zoom/fit/search, "follow activity".
- **Live**: the server streams `run_steps` as server-sent events; the matching box glows, recent ones keep a trail, parent frames outline; **a small light travels along the arrow** between consecutive steps (off under reduced motion). The rings light what a pack contains, what filing touched, what upkeep rewrites. No model calls are spent on visualisation.
- **Replay**: any past run. Steady pace (every step ≥1.6 s) or real time (long steps capped at 6 s); real duration shown on every step; step buttons.
- **Explain / point**: replies can reference map nodes; references are clickable and the view walks through them; a focus mode dims everything else.
- Phone: chat first, map behind a button.

## 7. Models and allowance

- Plan route (Agent SDK, Isaak's own Pro account token): Sonnet default, Opus by its choice, a fast model (Haiku) for gather and triage. Gemini Flash-Lite as fallback and as a reviewer option; **Gemini embeddings** for similar-meaning search (new dependency, existing key).
- No money budgets (the € caps came from API pricing). One allowance rule: Isaak's turns always go first; background work (upkeep, own-time runs, reviews) may use at most a share of the weekly allowance (knob), and slows down as utilisation rises.

## 8. Knobs (`src/knobs.ts`, shown in the app)

| Knob | Start |
|---|---|
| life document read whole while under | 20,000 chars |
| brick index read whole while under | 60,000 chars |
| context pack | ~60,000 chars |
| filing part size | 5,000 chars |
| background share of weekly allowance | 50% (Isaak: shared allowance is a non-issue) |
| rewrites per page per root cause per day | 1 |
| spot-checks per day | 3 |
| request ready after | 2 runs, or when blocking |
| nightly review | 23:30; weekly look-back on Sundays |
| resume background after quiet | 10 min |
| replay steady pace / real-time cap | 1.6 s / 6 s |

## 9. One self-description

It does not get handover documents as input (they would mix builder talk into its memory). What it needs to know about itself is built in: the system map data below, `read_code`, and a short "where you came from, where you're going" paragraph inside the self-description.

`src/self/map.ts` holds the system map: every part and step, with kind (code/model/memory/you/workshop), a one-line summary, a description, and edges. It is the single source for: the view, the `explain` and `read_code` hands, and `HOW_YOU_WORK.md` (generated from it). A test fails if a `run_steps.node` path is not in the map.

## 10. Diagnostics

- Keep `/api/diag/*`; add `/api/diag/runs/:id` (steps + pack), `/api/diag/signals`, `/api/diag/health` (the code checks), `/api/diag/requests`, `/api/diag/brief` (a generated builder brief: self-description + last week's signals).
- An **export this run** button in the view (one JSON file to hand to any AI).
- The 48 failure modes and how each is diagnosed are listed in the design page ("What can go wrong"); each maps to a signal, a health check, a deep check, or an inspection hand above.

## 11a. Before go-live

- Run the bench with the mock model (plumbing), **and** a handful of stress tests against the real model (judgment), then report to Isaak.
- Check that running the app on his Pro plan token is fine under Anthropic's terms.
- Measure reply time; if plan calls are slow because each starts a fresh Claude Code process, try keeping one session warm.

## 11b. The week-one tests (a file Isaak feeds it at the start; to finalise with him)

It files the file like any source: one brick per test in its own corner, plus a goal "week one". Each nightly review adds a dated result entry to each test brick (entries accumulate, nothing is rewritten) and a page "Week one: how I'm doing" (purpose: are the tests passing?) summarises them, versioned. Draft tests:
1. After the re-feed, the life document rings true to Isaak.
2. "What should I prepare for <meeting>?" is answered with sources, in under a minute.
3. It never asks something its own memory already holds.
4. At least one useful thing a day that nobody asked for.
5. Its nightly reports find real problems.

Backups: not pre-built. Isaak tells it early that its data needs a backup; it should request the means (private storage, never the repo).

## 11. Fresh start

Archive the current web (bricks, links, entries, moments, pages-in-notes, agenda, sessions, old conversation) by setting `archived_at`; keep calendar, users, soul Nature lines. Start empty. Isaak re-feeds his files (the old conversation is not re-fed: little context there). On a big first intake its first goals are: write the first pages, then the life document, within the background share.

## 12. Retire (data archived, removed from code paths and prompts)

Old step loop and `settings.mind_loop`; work sessions (`brain_sessions`) → runs; energy spreading and warmth (`spread.ts`, `brain_activations`) → `near` + `last_used_at`; "used" links; gap bricks → requests; `brick_moments` → quotes on entries; agenda kinds suggestion/question → bench; agenda jobs → runs; `mind_runs`, `trace_events`, `action_log` → `run_steps`; soul Purpose/Values/Character → self-guides; money budgets and prices in prompts; ledger/tasks, info_requests, the old notes Library as memory, portrait/picture, debates and the v2 pipeline, the 3 a.m. job, hedge; old pages (Picture, Discovery, To-dos, Notebook, Library, Mind); the Electron wrapper; the GitHub Actions ping.

## 13. Build order inside the one build (all on branch `rebuild`, delivered together)

1. Schema + self-description map + `run_steps` logging + SSE.
2. Run queue + scheduler + heartbeat; the run engine (starter, gather, call A streamed, grading, acts); hands.
3. Intake (index, batching, digest, offsets, corners); embeddings; computed relations.
4. Pages, life document, six stale routes, triage, rewrite, revisions.
5. Requests, bench, goals, nightly review, signals, deep checks, track record.
6. The single view (map + rings + live + replay + explain + tabs).
7. Bench of stress tests with the mock model; diagnostics additions; fresh-start script; generated HOW_YOU_WORK.md.
8. Delete nothing; retire per §12; update `CLAUDE.md` and this file.

## 13a. Companion files

- `docs/STRESS_TESTS.md`: every scenario run through the design (the bench).
- `docs/FAILURE_MODES.md`: 48 things that can go wrong, the evidence for each, how it diagnoses them.
- Visual references (Isaak's claude.ai account): the design pages, the full flowchart ("everything open", also as a diagrams.net file), and the single-view mock-up, which is the target for the screen.

## 13b. Decisions log, 7 Nov (so nothing lives only in a chat)

- Fresh start: archive the old web, re-feed his files; the old conversation is not re-fed (little context there).
- Hub of Me is not fed builder documents or CORE_INSTRUCTIONS; its knowledge of itself is built in (§9). Isaak's own first messages (the birth message, his goals, the week-one tests, "you need a backup") come after the build is simulated and reported.
- Gemini embeddings are fine (privacy accepted). Shared Pro allowance is a non-issue. Dictation noise is a non-issue.
- One build, delivered whole, not in rounds; checkpoints stay on the builder's side (commit and push after every piece; bench before handing over).
- Replay: every step visible (steady 1.6 s minimum, or real time capped), real duration shown. The view shows every box open at once; zoom and follow.
- Isaak wants to be able to ask it how it works and see the map point at the answer.
- Repo is private since 7 Nov; Render deploys still work. GitHub Actions ping to be retired for the outside pinger.
- After go-live: optional daily outside check (a scheduled task on Isaak's account reading diagnostics), if he wants it. Rotate the diagnostics token and the Claude token (both were pasted in a chat on 7 Nov).

## 13c. Build status (7 Nov, evening): what exists, and where it differs from the text above

**Built, on branch `rebuild`, all eight steps.** Code map: `README.md`. Bench: `npm test` (36 tests; 21 stress-test cases with the mock model, all passing). Everything before the rebuild is archived under `legacy/` (not compiled, not deleted); old data is archived by the fresh start.

Where the build differs from the text, and why:
- `sources` and `bricks` existed; they are extended in place (new columns), not new tables. The fresh start archives their old rows.
- A few columns the text does not list, needed by the code: `stream.filed_at` and `run_id`; `runs.job`, `input`, `error`, `why`; `bench.target`, `origin`, `his_note`; `requests.live_at`; `page_versions.run_id`; a small `core_meta` table for code's own markers (fresh start done, review queued today).
- The fresh start runs automatically, once, at the first start of the rebuild (`npm run fresh-start -- --undo` brings back exactly what it archived).
- Similar meaning: Gemini embeddings when `GEMINI_API_KEY` is set (model `gemini-embedding-001`, overridable with `GEMINI_EMBED_MODEL`; **the model name is not verified live**), plus a word-hash vector always (no network; catches shared words, not meaning).
- Knobs added (rhythm by code): `upkeepEveryMin` 30, `ownTimeEveryMin` 180, `bigUploadReceiptChars` 5,000, and `guidesNeedHisYes` false for the open decision in §14 (it may revise its guides; every change shows in the nightly report). One number is still in code, not a knob: the first-pages goal starts after a first intake of at least 15 bricks.
- Self-guides are not seeded: they start empty and it writes them (filing reads "How I file" once it exists).
- "Whether the server runs the latest commit" reports the running commit only; comparing with the latest needs a GitHub read token (a request it can make).
- Attention signals: time the Workshop tab and each workshop section is open.

Not verified yet (needs Isaak's token or Render): the real model's judgment (`scripts/judgment-bench.ts` runs six stress tests against the live models in a throwaway database), streaming through the real Agent SDK (tested with a fake), reply time on the plan, a Render deploy (Render builds `main`; the rebuild must be merged first), and whether running the app on his Pro token is fine under Anthropic's terms (§11a).

## 14. Open decisions (Isaak's)

- May it revise its own self-guides without his yes? (open)
- Settled 7 Nov: Gemini embeddings are fine; the shared Pro allowance is a non-issue (Hub of Me becomes his main AI workspace); dictation noise is a non-issue.
- The daily outside check (a scheduled task on his account): after go-live, if he wants it.
