# Hub of Me

Isaak's own AI: one entity with a memory of rings (everything kept whole → bricks → pages → one life document), its own time, and a mirror that reviews its work every night. Built from [BUILD_SPEC.md](BUILD_SPEC.md) (the source of truth); the philosophy is [DESIGN.md](DESIGN.md) §1 and §3. Builders start with [CLAUDE.md](CLAUDE.md).

## Run it

```
npm install
npm run dev          # API on 43124, the view on 43123 (AI_PROVIDER=mock needs no key)
npm test             # everything, including the bench
npm run bench        # the stress tests (docs/STRESS_TESTS.md) as cases, with the mock model
npm run build && npm start   # production
```

## Where things are

| Part | Code |
|---|---|
| The data model (BUILD_SPEC §4) | `src/core/schema.ts` |
| One log of every step, live events | `src/core/steps.ts`, `src/core/bus.ts` |
| Models: fast / main / deep / review, plan route first | `src/core/ai.ts`, `src/ai/plan.ts` |
| Run queue, scheduler, heartbeat, pause and resume | `src/core/queue.ts`, `src/core/rhythm.ts` |
| A run: starter, gather, pack, call A, grading, acts | `src/core/engine.ts` |
| Hands (the seed set) and the boundaries check | `src/core/hands.ts`, `src/boundaries.ts`, `src/privacy.ts` |
| Intake (filing) | `src/core/intake.ts` |
| Pages, the life document, citations | `src/core/pages.ts` |
| Upkeep: six stale routes, triage, rewrite, candidates | `src/core/upkeep.ts` |
| Similar meaning (Gemini embeddings + word vectors) | `src/core/embed.ts` |
| Bench, goals, requests, proposals | `src/core/workshop.ts` |
| The mirror: day file, signals, nightly review, deep checks | `src/core/mirror.ts` |
| Health checks (code) | `src/core/health.ts` |
| The fresh start (archive the old web once; undo) | `src/core/fresh.ts`, `scripts/fresh-start.ts` |
| Its self-description (the map), HOW_YOU_WORK.md | `src/self/map.ts`, `src/self/how.ts`, `src/agent/HOW_YOU_WORK.md` (generated) |
| Knobs | `src/knobs.ts` |
| Server, diagnostics | `server/app.ts`, `server/diag.ts` |
| The single view | `client/src/view/` |
| The mock model (plumbing only) | `src/core/mock.ts` |
| Everything before the rebuild (archived, not compiled) | `legacy/` |

## Environment

See `.env.example`. On Render: `CLAUDE_CODE_OAUTH_TOKEN` (the plan), `GEMINI_API_KEY` (embeddings and the fallback), `DATABASE_URL`, `SESSION_SECRET`, `USER_EMAIL`, `USER_PASSWORD`, `DIAGNOSTICS_TOKEN`, `AI_PROVIDER=anthropic`. An outside pinger (cron-job.org, every 10 minutes, `GET /api/healthz`) keeps the free server awake.

## Diagnostics

`GET /api/diag/{runs, runs/:id, signals?days=7, health, requests, brief, stream, errors}` with `Authorization: Bearer $DIAGNOSTICS_TOKEN`. `/api/diag/brief` is a generated builder brief: health checks, a week of signals, open requests and the self-description. Every run can also be exported from the view as one JSON file.
