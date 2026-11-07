# For AI builders working on this repo (Claude, Grok, Cursor, others)

0. **`BUILD_SPEC.md` is the source of truth** and wins wherever it disagrees with anything else. The rebuild was built on branch `rebuild` (7 Nov); its "Build status" section says what exists and what differs from the text. `LAYERED_MIND_SPEC.md` and `MIND_DESIGN.md` are background; everything before the rebuild is archived under `legacy/` (not compiled, not tested, never deleted).
1. Read `DESIGN.md` §1 (philosophy) and §3 (boundaries). Judgment, never rules; Isaak's examples are qualities, never features to hard-code. A number that is needed is a knob in `src/knobs.ts`.
2. Pull and read the recent commits before you start; builders take turns.
3. **If you change how the entity works** (what it sees, the run engine, memory, hands, models, the queue, what Isaak sees), **change its self-description in the same commit**: `src/self/map.ts` (the map the view draws and it reads), then `npm run how-you-work` to regenerate `src/agent/HOW_YOU_WORK.md`. A test fails if they differ, or if code writes a `run_steps` node that is not in the map.
4. **Run the bench before you push** (`npm test`; the stress tests are `tests/bench/`). It tests plumbing with the mock model; judgment needs the real model. Never edit tests to make a change pass: `tests/`, `src/boundaries.ts`, the Nature lines and `src/ai/plan.ts` sign-in are protected.
5. Propose before big changes, and state how you read Isaak's request; he often describes a feeling, not a spec.
6. Archive, never delete. Never send anything on his behalf. Nothing personal about Isaak goes in this repo.
