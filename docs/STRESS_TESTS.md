# Stress tests (the bench)

Scenarios Isaak and the builder ran through the design on 7 Nov. Each becomes a bench case (`tests/bench/`): run with the mock model for the plumbing, and a few against the real model before go-live. Lanes: you / code / model / web.


## 1. You ask for visual insight into how it works (verdict on paper: pass)

- **you**: "I can't see how you work; make it visual so I can diagnose you."
- **model**: Call A sees it can't even sketch a proposal; call B files an enabling request (make pages) and the run-view request that depends on it.
- **shop**: It replies with today's runs as text and explains why it asks for pages first.
- **you**: You say yes; it's built (stage 1). It immediately sketches the run view as a page.
- **model**: Verified by your attention; later it updates or retires its own page.

*Relies on / forced:* Enabling requests and dependencies; call A asks what it needs to discuss well. The full timeline is on the Requests page.


## 2. A big dump: many topics, some new (verdict on paper: pass)

- **code**: A one-line receipt at once; kept whole; 6 parts.
- **model**: Each filing call reads every brick, including those made earlier in the same dump, so new topics aren't doubled.
- **web**: 40 new bricks; new topics flagged as islands; pages marked stale by six routes.
- **code**: An intake digest goes into the reply run's pack: the reply covers the whole dump.
- **model**: Upkeep links the newcomers (by meaning and relevance) and triages the stale pages within budget, most important first.

*Relies on / forced:* Receipt, digest, newcomer linking, triage and budget.


## 3. Instagram reels: it can't open them (verdict on paper: pass)

- **you**: You send three reel links: "mine them for anything that could improve you".
- **model**: Call A: "A capable person would watch them. I can't open Instagram. Ways to take them in: he saves the videos and drops the files; a model that can watch video (Gemini can) gives transcript and what's on screen; or he pastes captions. Cheapest that works: the files plus video intake."
- **model**: Call B: an enabling request "take in video and audio", with that reasoning; meanwhile it asks for the captions.
- **shop**: Its reply explains the options and which it recommends, in plain words.

*Relies on / forced:* Video intake is now its request, reasoned by itself, not something we build in.


## 4. A file sent with a message (verdict on paper: pass)

- **code**: Message in the stream, file in sources, linked "sent together"; your words become a quote on the file's source brick.
- **model**: Filing reads your framing with the file and every brick; makes and grows bricks; flags updates and contradictions with existing ones.
- **web**: Old entries marked superseded; pages marked stale by the six routes; triage and rewrites follow.

*Relies on / forced:* Documented on the Sources and Intake pages.


## 5. After the reels: it knows how to look better (verdict on paper: pass)

- **web**: The ideas sit in its own-work theme, labelled "an idea from outside, not evidence", linked (relevant to) to the open requests they could help.
- **model**: What it can change by judgment (how it lays out its own pages), it puts in its self-guide "How I present things" and uses at once.
- **model**: What needs code enriches existing proposals as design references, citing the reel.
- **code**: Attention signals later tell whether the new look helps you.

*Relies on / forced:* Self-guides for presentation; outside ideas as labelled references, never as evidence.


## 6. A conceptual dictation about how you function (verdict on paper: pass)

- **model**: Filing makes a concept brick with your words and links it widely (relevant to, similar meaning) across themes.
- **code**: It shows up as a page candidate because it's linked across several themes, or you keep returning to it, or runs keep using it.
- **model**: In its own time it judges the concept worth a page, gathers with find, similar and near across all bricks, pages and sources, and writes a page that cites everything.
- **model**: It describes what you said and connects your own statements; guesses are labelled; no diagnosing you.
- **shop**: A one-line check-in: "I wrote a page on X from 9 things you said. Does it ring true?"

*Relies on / forced:* Concept pages, with the line we drew on 6 Nov against psychologising.


## 7. Thin but central: your internship (verdict on paper: pass)

- **code**: A new signal per brick and page: reach (links across themes, mentions in the life document, how often runs use it) against depth (entries, sources). "Internship": high reach, little depth.
- **model**: Upkeep sees it on the "thin but central" list; its own time: gather what exists, research what's public (the organisation, the programme), write a page with its gaps marked.
- **shop**: Targeted questions on your bench ("three things I'd like to know"), or a suggestion to dictate ten minutes. Nothing invented.

*Relies on / forced:* Reach-versus-depth signal.


## 8. Linking it to its own coding environment (verdict on paper: partly)

- **model**: Asked to code on itself, it would request in steps: read access to its own repository (it already reads its design), then a coding run that makes a branch, changes and tests, then pull requests (stage 3).
- **shop**: It proposes showing its pull requests and test runs in the workshop, so you review there.
- **model**: Limit: until the coding environment exists, the best it can do is stage 2 (the full spec).

*Relies on / forced:* Nothing new needed; the stairs already lead there. "Partly" until the coding environment exists.


## 9. Co-working on your internship code (verdict on paper: partly)

- **model**: It would propose a project space: your internship repository and method documents as sources, a living "workflow" page, hands to read notebooks and code, explain them, and draft changes as pull requests on your project, never merged by it.
- **model**: It would flag the boundary first: the code and data belong to Wetlands International, so what it may read is your supervisors' call.
- **shop**: A check-in: "Before I suggest how to link in: what am I allowed to see?"

*Relies on / forced:* "Partly" because it depends on WI's rules, not on the design.


## 10. "Your replies take too long" (verdict on paper: pass)

- **model**: It reads its records and finds it can't tell which step is slow: calls aren't timed today. First an enabling request: time every call.
- **model**: With timings: it reads its own code and design, finds where the time goes, and writes a proposal with before/after estimates.
- **code**: To show nothing is lost: the stress tests run as a bench before and after.
- **model**: Unasked: the weekly retrospective sees "72% of the pack goes unused" and proposes leaner gathering itself.

*Relies on / forced:* Every call timed; pack waste as a signal; the stress tests as a bench.


## 11. "The system is too complicated; show me like this page does" (verdict on paper: pass)

- **model**: Same chain as test 1: without a page hand it asks for one first; with it, it proposes a living explainer of itself: a map like this one, built from its code map, its design and its live runs.
- **model**: It keeps it true: when its code map changes, it updates the explainer, or retires it if you stop using it.

*Relies on / forced:* Its own explainer, kept current by itself.


## Later scenarios (7 Nov evening), and what they settled

12. **Asking it how it works.** Questions about itself are stored, filed only in its own corner (a signal of what confuses Isaak), never mixed into his life. It answers with references to map nodes; the view walks through them; a focus mode dims the rest. Co-design works from day one; building still needs a builder (stage 1).
13. **Feeding all files, then nothing.** Receipt, filing, a short reply per upload; then on its own: first pages, then the life document, within the background share; first nightly review that evening. It must not answer "what do you want me to do with them?".
14. **Self-reflection from the start.** Grading from the first run; nightly review from the first evening (thin at first); Sunday look-back after a week.
15. **Isaak gives short/mid/long-term goals.** Goal bricks with high reach, top of the life document, its ongoing goals. It does not by itself conclude "first: the workspace"; Isaak will tell it (his first message, see 17).
16. **Everyday use.** Can: text and files, memory and life document, answers with sources, web research, calendar, drafts on the bench, promises with scheduled runs, dots across time, explain itself, propose improvements. Cannot yet (until it asks): email/Drive/WhatsApp, audio/video/images, sending, phone notifications, alarms/lights, coding on his projects.
17. **The birth message** ("you've just been born… co-design of my projects and yourself… our first task is a good foundation"): central brick, top of the life document as current focus, a goal; it takes stock of itself, lists what the foundation needs, asks a few priority questions, files its first enabling requests. Risk: becoming self-absorbed; the background share and everyday use keep it grounded.
18. **Isaak asks for something and is wrong.** It pushes back once with reasons (Nature line 5), then does it his way unless a boundary. If filing (which runs after the reply) finds a contradiction with earlier points, one follow-up line in the chat.
19. **A question about something already in his web.** Own memory always first (it's in the pack); the gather call decides whether the internet is needed; the reply says which part came from where and flags disagreements.
20. **The week-one tests file.** One brick per test in its own corner + a goal; nightly results accumulate as dated entries; one versioned page "Week one: how I'm doing" summarises (BUILD_SPEC §11b).
