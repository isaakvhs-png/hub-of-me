# Rule for anyone building this (Isaak, 15 Nov 2026)

> you only do things when I tell you to, and you only use my words as a guide.

IDEA.md holds his words. Build only what they say; anything else, ask him first.

## Keep its self-description true

Every change to what it can do, or how it works, updates its description of itself (src/about.ts, and the action lists in its prompts) in the same change. Isaak, 16 Nov:

> You could at least like suggest it that it needs an update, at which point I would always say yes. Can you imagine any scenario in which I would say no, don't update its description of itself regarding to this? And this is just an example. This goes for more things.

> Right. So from now on, try to keep that perspective, okay? Don't just update things in isolation. If you update one thing, other things are affected. So try to like think about that and inform me, okay?

Before any change: list what else it touches (its self-description, the action lists in its prompts, the placing/tidying/tree prompts, the mock and tests, the client, IDEA.md) and tell Isaak which of those need updating with it.

The overview Isaak reads in the app (BUILT_IN in src/about.ts, "Built in" under "How I work") changes in the same change as any prompt it describes.

## Diagnostics

> this is diagnostic data, so do store it somewhere. Actually, can you do something for me? Can you store automatically all of this diagnostic data? Like after every, you know, reply to me, if I did something new with it, you can like quickly look at the model and see what it did and like store something when it's worth it.

After each reply in which Isaak used the system in a new way, look at what the models actually did (live site: /api/chat with its rounds, /api/web, /api/live) and add what's worth keeping to DIAGNOSTICS.md: what he did, what it did, why, what could change and whether it's fixed or parked.

## Deploys

Every push to the rings branch redeploys and restarts the server, and a restart kills an answer under way. Pushes that only touch docs (DIAGNOSTICS.md, IDEA.md, AGENTS.md) carry `[skip render]` in the commit message. Before a code push, tell Isaak it will restart.
