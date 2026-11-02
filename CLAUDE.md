# For AI builders working on this repo (Claude, Grok, Cursor, others)

1. Read `DESIGN.md` first. The philosophy in section 1 comes before any code: judgment, never rules; Isaak's examples are qualities, never features to hard-code.
2. Pull `main` and read the recent commits before you start; builders take turns.
3. **If you change how the entity works** (what it sees each step, the turn loop, memory, tools, models, waking, what persists, what Isaak sees), **update `src/agent/HOW_YOU_WORK.md` in the same commit.** The entity reads that file to understand itself; if it is wrong, it will diagnose itself wrongly.
4. Propose before big changes, and state how you read Isaak's request; he often describes a feeling, not a spec.
5. Archive, never delete. Never send anything on his behalf.
