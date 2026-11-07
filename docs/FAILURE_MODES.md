# What can go wrong, and how it can see it (48 failure modes)

The rule: nothing it does is invisible to it. Routine = checked every night; deep check = rotating, one area a night; on demand = when Isaak asks or something looks off. Inspection hands: `inspect`, `audit_file`, `trace_run`, `read_code` (BUILD_SPEC §5.7).

| Part | What can go wrong | Evidence it has | How it diagnoses it |
|---|---|---|---|
| Sources | A file is cut off (over 60k characters) | Original size and stored size | Routine: health check flags truncation |
| Sources | A file is unreadable (scanned PDF, image) and stored as noise | The stored text; coverage near zero | Routine: coverage check; becomes evidence for an "image/scan intake" request |
| Sources | A message never arrives or is stored twice | Message ids sent by the app and acknowledged by the server | Routine: health check counts gaps and duplicates |
| Intake | A part fails (refusal, timeout) | Failed parts with the error; retries | Routine: signal; retried on the next message |
| Intake | Something in the file was skipped | The file and every brick and quote from it | Routine: coverage (share of the file quoted). Deep check / on demand: audit_file reads both and lists what's missing |
| Intake | The same thing became two bricks | Similar names, shared quotes, similar meaning | Routine: duplicate candidates; later merges counted as a filing signal |
| Intake | Two different things were merged (two Petes) | Contradicting entries on one brick; filing notes | Deep check: bricks with contradictions; your revisions |
| Intake | Weak or wrong links | Every link's kind, reason and maker | Deep check: a sample of links judged; links-per-brick distribution |
| Intake | Its own notes filed as facts about you | Origin on every entry (his / web / own) | Deep check: inspect for own-origin entries on bricks about you |
| Intake | Questions about itself mixed into your life | Which corner each brick sits in | Deep check: its own-work corner vs your themes |
| The web | A page cites bricks that don't exist | Citations in every page | Code refuses it at writing time |
| The web | A page is wrong but reads well | Versions, the bricks it cites, the sources behind them | Spot-checks (routine, a few a day); your revisions |
| The web | Themes are badly cut | Pages with members spread over many themes | Weekly retrospective |
| The web | Islands: clusters linked to nothing else | Connected parts of the web, counted by code | Routine: island count; "link the newcomers" job |
| The web | The life document drifts or bloats | Its size and versions; claims vs cited pages | Routine size check; deep check of its claims; you |
| Upkeep | A change was never noticed (none of the six routes caught it) | Spot-check that finds a page wrong records which route should have caught it | Routine signal: "missed staleness" by route |
| Upkeep | Triage wrongly said "doesn't matter" | Every triage answer with its why | Deep check: a sample of "no" answers re-judged by the good model |
| Upkeep | A rewrite lost something | Every version and its change note | Deep check: compare versions against their bricks |
| Upkeep | The ripple eats the budget; the backlog grows | Budget used per day; backlog over time | Routine signals; weekly retrospective |
| Run queue | A wake-up came late or never | Due time vs start time for every run | Routine: lateness signal |
| Run queue | The server was asleep | Gaps in its own heartbeat | Routine: gap detection ("asleep 06:00–09:40") |
| Run queue | Your message waited behind background work | Queue wait time per run | Routine signal |
| Run queue | A run stuck as paused or running | Status and age of every run | Routine: health check |
| A run | Gathering missed something relevant | The pack, the gather call's list and why, what was available | On demand / deep check: trace_run with hindsight, especially on runs you corrected; signal "questions my web could answer" |
| A run | Pulled in far more than it used | Pack contents vs what the drafts actually used | Routine: pack waste |
| A run | Energy only spreads one step | How far energy reached, per run | Routine: reach recorded; a flat "1 hop" shows up at once |
| A run | Refused calls | Every refusal and the fallback | Routine signal |
| A run | A step is slow | Every call's time | Routine: time per step |
| A run | The reply was wrong or invented | The reply, the pack, your reaction | Your corrections; deep check: reply claims against the pack |
| A run | Call B graded wrongly (a false gap) | Each grade with the intention and the hand list | Routine: "can an existing hand do this?" |
| A run | A promise with nothing behind it ("I'll check weekly") | The reply text and queued wake-ups | Routine: promises in replies without a matching queued run |
| Hands | A hand failed (calendar error) | Every act's result | Routine signal |
| Hands | A boundary was nearly crossed | Blocked acts, logged | Routine; shown to you |
| Hands | A hand exists but is never used | Use counts per hand | Weekly retrospective |
| Workshop | Something important went unseen by you | Attention signals (what you opened) | Routine signal; it can raise it again, once |
| Workshop | The map shows the wrong thing | The events it sent | Partly outside its view: it can check its event log is right, not your screen. You or a builder |
| The mirror | The review missed a problem | Everything above | Weekly retrospective; the outside check; you |
| The mirror | The review invented a problem, or a fix that doesn't help | Each fix's prediction vs its target signal | Routine: verified or reopened; the track record |
| The mirror | A self-guide hardened into a rule | Evidence next to every line; versions | Deep check of the guides |
| The mirror | The review itself failed | It's a run like any other | Tomorrow's day file includes it |
| Requests | Duplicates, false requests | Merges and drops with reasons | Routine |
| Requests | Requests nobody decides on | Age of ready requests | Routine: raised once more in the report |
| Build | A change broke something | The bench before and after; errors after deploy | Builder runs the bench; routine error signal after deploy |
| Build | Pushed but not deployed | The commit the server runs vs the latest commit | Routine: "running an old version" |
| Build | The code map is out of date | The map vs the files | A test that fails the build |
| Outside the app | Render, the database or Anthropic is down | Errors and gaps | Routine: it sees that, not why |
| Outside the app | Plan allowance running out | The plan's utilisation on every call | Routine: background work slows before you hit the limit |
| Outside the app | The sign-in token expires (after a year) | The token's creation date | A reminder a month ahead |

**Outside its view:** Isaak's screen and experience; quality only he can judge (his revisions are ground truth); why outside services fail (it sees that they did); blind spots its reviewer shares with it (hence the optional outside check and Isaak).