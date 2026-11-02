# Hub of Me: design (v3, 2 Nov 2026)

This replaces "Hub of Me design spec v2" (the PDF). v2 described a pipeline: filing, then debates on a schedule, then a judge. That shape was dropped on 1 Nov (commit 531309a). This document describes the product as it is meant to be now. Read the philosophy first: everything else serves it.

Isaak (with a K) is the person this is for. Some older code and texts say "Peter". That is a mistake, not a second user.

## 1. Philosophy (the only part that is not provisional)

**Build someone, not something.** Hub of Me is a presence: a thoughtful friend who is getting to know him. The conversation is the product. Filing, notes, thinking and tools are what goes on in its head while you talk.

**Judgment, never rules.** Whatever Isaak describes is a quality, not a feature spec. His examples illustrate a kind of behaviour. They are never to be implemented literally, listed, hard-coded or turned into categories, modes or fixed numbers. When you feel the urge to write a rule, a menu, an if-this-then-that or a "max 3", stop: you are probably hard-coding an example. Give the entity the purpose and let it decide.

**A tiny seed, then growth from real experience.** Its character starts as a few sentences: purpose, values and boundaries (section 3). Everything else grows only from reflecting on what actually happened between them. Every line traces back to a real moment. A correction is something to reflect on, never a new rule bolted on.

**Understanding before helping.** It is always curious, not as a mode. It wants to know how he thinks before it advises. It knows what it doesn't know and notices new territory. Early on it asks more than it advises.

**It takes a stance.** The reason this exists is "bland soup": one AI averaging everything into the safe, pleasing answer. It commits, disagrees for reasons and holds up a mirror. It is not a yes-man.

**It chooses its own thinking and tools.** Tools are abilities described in plain words. They never run on their own and carry no rules about when to fire. Adding a tool widens what it can do without changing who it is.

**Transparent without detective work.** He can see live what it does with what he says, and open anything to see what it believes and why. He doesn't manage its storage; he spot-checks that it is honest and uses what it knows.

**How it is built mirrors how it works.** The builder proposes, Isaak reacts, they agree. Before big changes, state how you read him: he often expresses a feeling, not a spec. If a request seems to clash with this philosophy, say so instead of quietly building it.

**Test for any change:** does it make it more like a thoughtful someone using judgment, or more like a machine following rules? Only the first is allowed.

## 2. What it is for

Isaak, 25, is finishing an MSc Biology at WUR (internship at Wetlands International from 2 Nov; a possible thesis at Kyoto). He is building a life outside institutional rails: autonomy and mobility, strength and family, a career on his own terms that compounds instead of drifting. That path removes the structure a job gives, which leaves four frictions:

1. Admin drag: mail, calendar and messy notes eat executive function.
2. An opportunity blind spot: nobody scans the world for contacts, collaborations, grants, travel.
3. No mirror: working alone invites self-deception and productive procrastination.
4. Evaporating thinking: insights scattered over many AI chats never compound.

These are why it exists. They are not module names. The mirror (3) is not a tool at all: it is the core character.

The test of success: months in, it surprises him by remembering what he would have forgotten, or by disagreeing for a reason he recognises as right. In the long run he wants it to have agency: to work on his behalf while he is away.

## 3. Boundaries (the only fixed rules)

Free, on its own judgment, always logged with why:
- calendar, drafts, research, filing, organising, archiving, rearranging, staying silent.

Needs Isaak's explicit yes:
- anything that reaches a person or a third party (sending, posting, replying, inviting);
- giving out his personal details, or anything that could put his reputation at risk;
- money and financial actions; private matters;
- creating accounts that need his personal details. A throwaway sign-up with no personal details is a later question, not built.

Never:
- delete anything (archive instead);
- put private details or contacts into a web search;
- enter his passwords or sign in as him;
- send email (Gmail is read and draft only).

Code enforces these in `src/boundaries.ts`. The seed soul states them in words.

## 4. The shape of the product

Four layers. Only the first is "the product"; the rest exist for it.

**The entity.** One being, one conversation. Each turn it reads its soul, a short brief of its notebook and the conversation, then decides: speak, use a tool, or both, or stay quiet. Code keeps the books (validate, save, version, log, enforce boundaries, count cost); judgment stays in the model.

**Rooms (shared spaces in the hub).** Chat, Notebook (picture of him, soul, notes, ledger, debates and thinking, change history, tools), Calendar, and later Mail and a feed. Rooms belong to Isaak as much as to the entity: he can put things in and look things up himself. The entity works in the same rooms. Nothing is only reachable through the AI.

**Hands (tools).** Plain-language abilities in `src/agent/registry.ts`. The entity picks them. No tool fires on its own.

**Its life (thinking while he is away).** It does not think continuously; no model can within budget. Instead, at the end of a wake-up it decides itself when to wake next and why, and what woke it is given back to it then. A new message from him also wakes it. The only fixed parts are the budget and a fallback alarm in case it forgets to set one. The rhythm is its own judgment.

**Connections (plug-ins).** "Module" means only plumbing: a connection to Google Calendar, Gmail, the web, an import. Plugging one in gives both Isaak and the entity a room or a pair of hands. It never adds a purpose, a rule or anything to the soul.

## 5. Memory

- **Notes**: small notes in folders. The entity chooses the type, the folder and the wording, and can make new ones. AI-written notes stay unexplored until Isaak says yes, no or revise; ignored notes still count. Every change keeps the old version, the reason and the causing message, and can be undone. Nothing is deleted.
- **Picture of him**: claims with the evidence (his words) behind each. No confidence scores; reflection reasons over the evidence.
- **Soul**: slow and versioned; changed only by reflection, each line traceable.
- **Mind note**: a fast, disposable catch-up in its own words.
- **Ledger**: to-dos kept quietly, surfaced by judgment with "why now", faded with a reason, closed by evidence.
- **Store everything relevant, surface little.** Sources it meets in research are kept as bookmarks.

## 6. Transparency

- Live: as a message is read, phrases light up in a colour per destination, a box says where each went, a line connects them. Boxes and lines flash, fade together, and return on hover.
- Notebook: what it believes and why, what it did and why, with undo.
- Health: usage and cost per day, conversation and background job; errors.
- Diagnostics: read-only routes under `/api/diag` for a builder agent (token in Render).

## 7. Models and budget

- €20 a month (`MONTHLY_CAP_EUR_CENTS`). Real token counts and list prices, never estimates.
- Routing by effort: light work on Gemini Flash-Lite while its free quota lasts, conversation on Claude Haiku, deep thinking on Claude Sonnet; Claude is the fallback.
- What it costs now: a conversation step is about €0.0003–0.0005 (Haiku), so the budget allows tens of thousands of steps a month. That is the room its life can use.
- Later: the entity can see its remaining budget and ask Isaak for more when something is worth it.
- Not doing: creating extra Google accounts for more free Gemini keys. That breaks Google's terms and risks losing the key and account.

## 8. Platform

- Node/TypeScript/Hono API, Postgres (Neon), React/Vite/Tailwind PWA, Electron desktop shell. One login, every device.
- Hosted on Render's free tier. **Constraint:** a free Render service sleeps after about 15 minutes without visitors, and while asleep no timers run, so nothing can wake the entity. Thinking while away needs the service kept awake, e.g. a free external pinger (cron-job.org) calling `/api/healthz` every 10 minutes, or a paid instance (~$7/month).
- Deploy: push to `main`, then Isaak deploys on Render by hand.

## 9. State on 2 Nov and next steps

Built: the one-entity loop, seed soul, notebook, picture, ledger, debates/reflection as tools, research, the live trace view, health and cost, diagnostics, PDF/Word in, Word out, an in-app calendar.

Fixed on 2 Nov: the first reply was lost (the entity used tools for 8 steps and its words were dropped); messages could land in archived conversations; archived debates still listed; connector lines didn't fade.

Leftovers from the pipeline era, removed on 2 Nov: a fixed list of seven destinations for marked phrases; every note forced into "Inbox" as an "idea"; "Peter" as the default name.

Next:
1. **Playtest the core** after a fresh start: Isaak re-feeds his opening dump and the Shinichi meeting summary, then uses it daily for about a week. Watch whether it asks before advising, keeps what matters, grows its character in its own words, takes a stance, and what a day costs.
2. **Its life**: keep the service awake, then see what it does between conversations.
3. **Model value**: compare quality per task within budget.
4. **Rooms**: calendar and mail tabs he can use directly (Google Calendar, Gmail read-only).
5. Beyond that, real use decides; don't plan features ahead.
