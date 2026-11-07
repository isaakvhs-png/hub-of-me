// The system's description of itself: every part and step, what kind of work it is, and how they connect.
// Single source for: the live view, the explain / read_code hands, and HOW_YOU_WORK.md (generated).
// A test fails if a run_steps.node path is not in this map. Keep it true in the same commit as any change.
// kinds: c = plain code, m = a model call, w = memory / stored, y = Isaak, s = workshop.
// Edges: [from, to, label]; "@x" means another top-level part.

export type MapKind = "c" | "m" | "w" | "y" | "s";
export interface MapNode {
  t: string;            // title
  k?: MapKind;          // kind
  s?: string;           // one-line summary
  d?: string;           // description
  kids?: Record<string, MapNode>;
  edges?: [string, string, string?][];
}

export const SYSTEM_MAP: MapNode = {t:"Hub of Me",d:"The whole system. Twelve parts; three loops run through them: the memory loop (sources → web → runs → back into the web), the mirror loop (runs → records → review → requests → build → new hands) and your loop (you send, revise and decide).",
kids:{
 sources:{t:"Sources",k:"w",s:"everything, kept whole",d:"Ring 0 of the memory. Everything that comes in is kept whole and never changed: both sides of every conversation, files, pages it read, digested video, contacts, its own notes. Append-only.",
  kids:{
   conv:{t:"The conversation",k:"w",s:"both sides",d:"Each of your messages and each of its replies, in order, in brain_stream. Exists today."},
   files:{t:"Files",k:"w",s:"notes, papers, slides",d:"Anything you drop in, kept whole (text up to 60,000 characters today). Exists."},
   pages:{t:"Web pages it read",k:"w",s:"from its searches",d:"Every page a search or a read pulled in is kept as a source. Exists."},
   own:{t:"Its own notes",k:"w",s:"marked as its own",d:"Its thoughts and conclusions, filed as sources of kind 'own': never treated as evidence about you. Exists."},
   media:{t:"Video and audio",k:"w",s:"once it asks for it",d:"The file, plus a transcript and what's on screen (a model that can watch video, such as Gemini). Not in the seed: it should ask for this itself when it meets something it can't take in."},
   contacts:{t:"Contact records",k:"w",s:"a person's details",d:"A person's contact details as a source; the person's brick links to it. New."},
   gemini:{t:"Gemini chats",k:"w",s:"later",d:"You start a fresh Gemini account now; the big archive is imported once the web has grown. Stored and searchable, filed only when a run pulls one in."},
   store:{t:"Stored whole",k:"c",s:"append-only tables",d:"brain_stream (every message) and brain_sources (files, pages, transcripts, contacts). Nothing is ever edited or deleted."},
   sentwith:{t:"Sent together",k:"c",s:"message ↔ file",d:"A file sent with a message is linked to it. Your words become a quote on the file's source brick, so the file always carries how you framed it ('the methods part matters')."},
   srcbrick:{t:"Source brick",k:"w",s:"one per source",d:"Each source gets a brick in ring 1. Hovering it shows the bricks it spawned; opening it shows the full text. Every quote on a brick records where in the source it sits (char start and end), so you can jump to the exact lines."}
  },
  edges:[["@you","conv","you send"],["@you","files","you send"],["@hands","pages","it reads"],["@hands","own","it writes"],["@you","media","you send"],["conv","store",""],["files","store",""],["pages","store",""],["own","store",""],["media","store",""],["contacts","store",""],["gemini","store","stored, filed on demand"],["conv","sentwith",""],["files","sentwith",""],["store","srcbrick",""],["srcbrick","@intake","new source"]]},

 intake:{t:"Intake",k:"c",s:"reads every brick, links",d:"How a source becomes bricks and links. One filing call per part, reading the index of every brick; code stores, adds cheap links, and marks what was touched.",
  kids:{
   arrive:{t:"A source arrives",k:"c",s:"message or file",d:"From Sources. If it's big (a dump), a one-line receipt goes to the chat at once: 'Got it, filing now, about 3 minutes.'"},
   split:{t:"Split into parts",k:"c",s:"≤5,000 chars",d:"At paragraph breaks, so each answer fits and a failure stays small."},
   index:{t:"The brick index",k:"c",s:"every brick, one line",d:"Name, kind and one-line summary of every brick (~25k characters at 280 bricks). Read whole while under ~60k characters (a knob); beyond that code pre-selects by shared words and similar meaning. Updated after each part, so part 5 sees bricks made in part 2."},
   guideF:{t:"Self-guide: How I file",k:"w",s:"its notes on filing",d:"Its own page of notes on filing, each line citing evidence (merges it had to do, your revisions). Every filing call reads it. Revised by the daily review."},
   fcall:{t:"Filing call",k:"m",s:"one per part",d:"Reads the self-guide, your framing (if the file came with a message), the whole index and the part. Returns things, entries, links it judges, updates and a filing note.",
    kids:{
     reads:{t:"It reads",k:"c",s:"guide · framing · index · part",d:"Everything the call sees."},
     things:{t:"Things",k:"m",s:"existing id or new",d:"Each thing in the part: an existing brick (by id) or a new one with name, kind, summary."},
     entries:{t:"Entries with quotes",k:"m",s:"facts, questions, plans…",d:"What the part says about each thing, with your exact words."},
     jlinks:{t:"Links it judges",k:"m",s:"with a reason",d:"Relevant to, with a relation: answers a need, supports, contradicts, causes, part of, involves. E.g. a new LiDAR method ↔ 'we need a restoration-potential layer'."},
     updates:{t:"Updates",k:"m",s:"this replaces X",d:"'This changes what brick X said': a corrected fact, a changed plan. Starts the ripple."},
     fnote:{t:"Filing note",k:"m",s:"doubts, gaps",d:"What it doubted ('two Petes') or couldn't capture ('a table was flattened')."}
    },
    edges:[["reads","things"],["reads","entries"],["reads","jlinks"],["reads","updates"],["reads","fnote"]]},
   stored:{t:"Code stores it",k:"c",s:"match, make, quote positions",d:"Matches things by id (or identical name), makes new bricks, stores entries, finds each quote in the source and keeps its position."},
   clinks:{t:"Code's own links",k:"c",s:"together · words · meaning",d:"Cheap links added by code: said together, shared distinctive words, similar meaning (to bricks the model didn't mention), same source."},
   touched:{t:"Touched bricks",k:"c",s:"recorded",d:"Every brick that got something new in this intake (entry, quote, link, changed name or summary)."},
   super:{t:"Superseded entries",k:"c",s:"kept, marked",d:"Old entries an update replaces. Never deleted."},
   noteuse:{t:"Filing note used",k:"c",s:"question · candidate · evidence",d:"A doubt becomes an open question on the bricks and a merge candidate; something it couldn't capture becomes evidence on a request."},
   digest:{t:"Intake digest",k:"c",s:"for big dumps",d:"Per theme: what's new, what was updated, which new clusters have no home. Goes into the reply run's context pack, so the reply covers the whole dump."},
   retry:{t:"Failed parts retried",k:"c",s:"on the next message",d:"Kept in failed_parts and retried. Exists."}
  },
  edges:[["@sources","arrive","new source"],["arrive","split"],["split","fcall"],["index","fcall"],["guideF","fcall"],["fcall","stored"],["fcall","retry","if it failed"],["stored","clinks"],["stored","touched"],["stored","index","next part sees it"],["fcall","super","updates"],["fcall","noteuse","filing note"],["stored","digest"],["touched","@web","bricks, links"],["super","@web",""],["clinks","@web",""],["noteuse","@requests","evidence"],["digest","@run","into the pack"]]},

 web:{t:"The web",k:"w",s:"bricks · pages · your life",d:"The memory: four rings. Sources outside, bricks, pages (as many levels as needed), and one document about your life in the centre. Everything links, and everything ripples.",
  kids:{
   r0:{t:"Ring 0: sources",k:"w",s:"see Sources",d:"Everything kept whole."},
   r1:{t:"Ring 1: bricks",k:"w",s:"one thing each",d:"A person, place, idea, project, question, event, concept… With entries (facts, questions, leads, ideas, to-dos, feelings, plans, its conclusions), your exact quotes, and links.",
    kids:{
     bname:{t:"Name, kind, summary",k:"w",s:"",d:"Free text, not a fixed list of kinds."},
     bentries:{t:"Entries",k:"w",s:"never rewritten",d:"Each with origin (his / web / own), status (open, answered, done, dropped, superseded)."},
     bquotes:{t:"Quotes",k:"w",s:"with position in the source",d:"Your exact words, with where they sit."},
     blinks:{t:"Its links",k:"w",s:"eight kinds",d:"See 'Links'."},
     breach:{t:"Reach and depth",k:"c",s:"computed",d:"Reach: links across themes, mentions in the life document, how often runs use it. Depth: entries and sources. High reach + low depth = 'thin but central'."}
    },edges:[["bname","bentries"],["bentries","bquotes"],["bname","blinks"],["blinks","breach"],["bentries","breach"]]},
   links:{t:"Links",k:"w",s:"eight kinds",d:"Every link has a kind, a reason, a strength and who made it. Code-found links are cheap and many; model-found links carry the why.",
    kids:{
     lsrc:{t:"Same source",k:"c",s:"code, at filing",d:"Every brick from a file ↔ its source brick."},
     ltog:{t:"Said together",k:"c",s:"code, at filing",d:"From the filing call's groups: things in one sentence or passage."},
     lwords:{t:"Shared words",k:"c",s:"code",d:"Distinctive terms in common ('restoration potential', 'Moni1000'), not common words."},
     lmean:{t:"Similar meaning",k:"c",s:"code (embeddings)",d:"'Soil carbon stocks' ↔ 'SOC workflow' with no shared words. New."},
     lpage:{t:"Same page or theme",k:"c",s:"from membership",d:"Both are part of the same page."},
     lrel:{t:"Relevant to",k:"m",s:"the model, with a reason",d:"With a relation: answers a need, supports, contradicts, causes, part of, involves, updates. Found in filing, in 'link the newcomers', in any run."},
     lused:{t:"Used together",k:"c",s:"from runs, capped",d:"Both were actually used in the same reply."},
     lins:{t:"Insight",k:"m",s:"its own thinking",d:"A connection it worked out: 'his deer idea and the GMW gap are the same question'."}
    },edges:[]},
   r2:{t:"Ring 2: pages",k:"w",s:"made of bricks",d:"Narrative pages citing their bricks. Each states its purpose (why it's worth having). Many-to-many: the same bricks feed several pages; a page can sit in two themes. Every version kept.",
    kids:{
     pcand:{t:"Candidate",k:"c",s:"offered by code",d:"A cluster with no page, a big new file, bricks that keep turning up together, a concept with high reach, or your request."},
     pjudge:{t:"Worth having?",k:"m",s:"its judgment",d:"Does it cover a topic worth having in the web (a project, a period, a person, a concept)? If yes, it states the purpose in one line. Same purpose as another page → merge; two purposes → split."},
     pgather:{t:"Gather everything",k:"m",s:"find · similar · near",d:"Searches all bricks, pages and sources for what belongs."},
     pwrite:{t:"Write",k:"m",s:"cites everything",d:"Body with citations; guesses labelled. Version 1."},
     pfresh:{t:"Fresh",k:"w",s:"",d:"Up to date as far as it knows."},
     pstale:{t:"Stale",k:"w",s:"worth a look",d:"Something it's made of or about changed. See Upkeep."},
     pre:{t:"Rewritten or kept",k:"m",s:"after triage",d:"A new version with a change note, or 'nothing that matters changed'."}
    },edges:[["pcand","pjudge"],["pjudge","pgather","yes"],["pgather","pwrite"],["pwrite","pfresh"],["pfresh","pstale","something changed"],["pstale","pre","upkeep"],["pre","pfresh"]]},
   r3:{t:"Ring 3…n: themes",k:"w",s:"pages of pages",d:"As many levels as the material wants; the level is computed. No page inside itself; every citation must exist."},
   life:{t:"Centre: your life",k:"w",s:"read by every run",d:"One document about your life, as big as it needs. Every run reads all of it while under ~20k characters; beyond that, its opening and headings. Every run starts here."},
   guides:{t:"Self-guides",k:"w",s:"its working notes",d:"Pages in its own-work theme: How I file, How I gather, How I work with Isaak, How I present things. Each line cites evidence; the runs doing that work read them."},
   track:{t:"Track record",k:"w",s:"which fixes worked",d:"Which kinds of fixes helped and which didn't. Read by reviews before they propose."}
  },
  edges:[["@intake","r1","bricks, links"],["r0","r1","spawn"],["r1","links"],["r1","r2","members"],["r2","r3"],["r3","life"],["guides","r2","are pages"],["track","r2","is a page"],["@upkeep","r2","rewrites"],["@hands","r1","results, thoughts"],["@you","r2","revise"],["@review","guides","revisions"],["@review","track",""],["r2","@upkeep","stale marks"],["life","@run","gathered"],["r2","@run",""],["r1","@run",""]]},

 upkeep:{t:"Upkeep",k:"c",s:"stale · triage · budget",d:"Noticing what changed and how far to follow it: six routes mark pages stale, a fast model triages, a good model rewrites, and a daily budget stops the ripple running forever.",
  kids:{
   routes:{t:"Six stale routes",k:"c",s:"how it notices",d:"Six independent ways a page gets marked stale, each with a reason.",
    kids:{
     rmem:{t:"Membership",k:"c",s:"instant",d:"A brick the page is made of was touched."},
     rflag:{t:"Flagged at filing",k:"m",s:"the model flags",d:"The filing call (reading every brick) said 'this updates / contradicts X': every page about X."},
     rment:{t:"Mentions",k:"c",s:"word and meaning search",d:"Pages that mention the changed brick by name or similar meaning without citing it."},
     rtime:{t:"Time",k:"c",s:"daily",d:"Dated entries that have passed ('Friday meeting', 'deadline 15 Nov')."},
     rspot:{t:"Spot-checks",k:"m",s:"a few a day",d:"Rereads the bricks behind a random older page: catches pages wrong from the start."},
     ryou:{t:"You",k:"y",s:"top priority",d:"Anything you revise, with your reason."},
     mark:{t:"Marked stale",k:"c",s:"with a reason",d:"Into the stale queue."}
    },edges:[["rmem","mark"],["rflag","mark"],["rment","mark"],["rtime","mark"],["rspot","mark"],["ryou","mark"]]},
   squeue:{t:"Stale queue",k:"c",s:"by importance",d:"Ordered: your revisions first, then pages near the life document and near what's active."},
   budget:{t:"Daily budget",k:"c",s:"a knob (20%?)",d:"A share of the day's allowance for upkeep. When used up, the rest waits until tomorrow."},
   once:{t:"Once per root cause",k:"c",s:"per page per day",d:"One root cause rewrites a page at most once a day."},
   triage:{t:"Triage",k:"m",s:"fast model",d:"For each stale page: 'does this change matter here? yes / no, one line why'."},
   no:{t:"No: logged",k:"c",s:"stops here",d:"Most 'no' answers end the ripple on that branch."},
   rewrite:{t:"Rewrite",k:"m",s:"good model",d:"Old text, the reasons, the changed bricks in full → a new version and a change note saying whether a claim changed."},
   claim:{t:"Claim changed?",k:"m",s:"in the change note",d:"Only a changed claim passes staleness upward."},
   up:{t:"Parent marked",k:"c",s:"chained reason",d:"The page above is marked stale, with the reason chain."},
   stop:{t:"Branch stops",k:"c",s:"nothing that matters",d:"The ripple ends here."},
   backlog:{t:"Backlog shown",k:"s",s:"a signal if it grows",d:"In the workshop. A growing backlog is a signal for the mirror (fewer, broader pages, or a bigger budget)."},
   cands:{t:"Candidates",k:"c",s:"offered by code",d:"Likely duplicates, islands (new clusters few links outside), thin but central bricks, clusters without a page, concepts with high reach."},
   bupk:{t:"Brick upkeep",k:"m",s:"merge · split · link newcomers",d:"It decides on each candidate: merge, split, relabel, link the newcomers to the rest, or propose a page."}
  },
  edges:[["@web","routes","stale marks"],["@you","routes","revise"],["routes","squeue"],["budget","squeue","caps"],["once","squeue",""],["squeue","triage"],["triage","no","no"],["triage","rewrite","yes"],["rewrite","claim"],["claim","up","yes"],["claim","stop","no"],["up","squeue","next level"],["rewrite","@web","new version"],["squeue","backlog"],["backlog","@review","signal"],["cands","bupk"],["bupk","@web","merges, links"]]},

 you:{t:"You",k:"y",s:"send · revise · decide",d:"You remain the boss. You send anything, revise anything with reasons, and decide on anything that reaches people, money, private matters, or changes how it works.",
  kids:{
   send:{t:"Send anything",k:"y",s:"messages, files",d:"Nothing to sort."},
   revise:{t:"Revise",k:"y",s:"any brick, page, guide, request",d:"Write what you'd change and why, like you do with a builder."},
   discuss:{t:"It may push back once",k:"m",s:"with evidence",d:"Then your word stands."},
   decide:{t:"Decide",k:"y",s:"yes · not now · no because · discuss",d:"On proposals, suggestions that reach people or money, protected changes."},
   protect:{t:"Protected parts",k:"y",s:"explicit yes",d:"Tests, boundaries, Nature lines, sign-in, this rule."},
   bounds:{t:"Your boundaries",k:"y",s:"free · ask first · never",d:"Free: calendar, drafts, research, organising, archiving. Ask first: reaching people, your personal details, reputation, money, private matters. Never: delete, private details in web searches, your passwords, sending email."},
   deploy:{t:"Deploy",k:"y",s:"by hand on Render",d:"After a builder pushes."}
  },
  edges:[["@workshop","decide","proposals"],["send","@sources","sends"],["send","@queue","speaks"],["revise","discuss"],["discuss","@web","applied"],["revise","@upkeep",""],["decide","@build","yes"],["protect","decide"],["bounds","@hands","checked by code"],["deploy","@build",""]]},

 queue:{t:"Run queue",k:"c",s:"you first · its schedule",d:"Every run to do, in one table, with a trigger and a purpose. A small scheduler starts the next one when the model is free. Replaces today's five separate routes and the single wake-up slot.",
  kids:{
   tyou:{t:"You speak",k:"y",s:"priority now",d:"Purpose: answer and act."},
   tsched:{t:"Its schedule",k:"m",s:"promises, checks, wake_me",d:"Any number of wake-ups, each with a why. Today there is only one slot, and a new wake-up overwrites the old."},
   tupk:{t:"Upkeep jobs",k:"c",s:"within the budget",d:"Stale pages, candidates, spot-checks."},
   trev:{t:"Review",k:"c",s:"23:30 daily, Sunday weekly",d:"The mirror."},
   table:{t:"runs table",k:"c",s:"trigger · purpose · priority · time",d:"Holds everything to do, with status queued, running, paused, done, and where it left off."},
   sched:{t:"Scheduler",k:"c",s:"one at a time",d:"Starts the next run when the model is free; yours always first."},
   pause:{t:"Pause",k:"c",s:"save where it was",d:"A background run finishes its current call, saves left_off, waits."},
   resume:{t:"Resume",k:"c",s:"after ~10 min quiet",d:"A knob."},
   pinger:{t:"Outside pinger",k:"c",s:"keeps the server awake",d:"So the queue actually moves on time (Render free tier sleeps after ~15 minutes)."}
  },
  edges:[["@you","tyou","speaks"],["@hands","tsched","wake_me"],["@upkeep","tupk",""],["tyou","table"],["tsched","table"],["tupk","table"],["trev","table"],["table","sched"],["pinger","sched","awake"],["tyou","pause","background pauses"],["pause","resume"],["resume","sched"],["sched","@run","starts"],["trev","@review",""]]},

 run:{t:"A run",k:"m",s:"gather → A → reply → B",d:"Every run, whatever started it, goes the same way: gather what it needs, draft and reply, then grade, act and file.",
  kids:{
   starter:{t:"Starter",k:"c",s:"always",d:"The life document, its self-guides, the conversation so far, what was just filed (and the intake digest), bricks your words name."},
   gather:{t:"Gather call",k:"m",s:"fast model (your A0)",d:"'What do I need to look at?' It chooses its own routes.",
    kids:{
     gfind:{t:"find",k:"c",s:"by words",d:"Across bricks, pages and sources."},
     gsim:{t:"similar",k:"c",s:"by meaning",d:"Meaning-similarity search."},
     gnear:{t:"near",k:"c",s:"along links",d:"What's linked to a brick or page; energy spreading is one way to do this."},
     gopen:{t:"open",k:"c",s:"a page, brick or source",d:"In full."},
     gweb:{t:"web",k:"c",s:"the internet",d:"A web search."},
     gplan:{t:"Its list",k:"m",s:"what and why",d:"A short list of what to look at."}
    },edges:[["gplan","gfind"],["gplan","gsim"],["gplan","gnear"],["gplan","gopen"],["gplan","gweb"]]},
   fetch:{t:"Fetch at once",k:"c",s:"one go",d:"Code fetches everything on the list together."},
   pack:{t:"Context pack",k:"w",s:"~60k chars",d:"What this run sees. The web lights up whatever is in it, so you can see what it looked at."},
   callA:{t:"Call A",k:"m",s:"draft + reply, streamed",d:"'What would a highly capable person with your memory and a computer actually do now, including what you'd need to do it well and to discuss it with Isaak?' Then the reply."},
   more:{t:"OPEN: once more",k:"m",s:"if something's missing",d:"One more gather, once."},
   reply:{t:"Reply",k:"s",s:"~30–40 s (estimate)",d:"You see it as it's written."},
   callB:{t:"Call B",k:"m",s:"decide and grade",d:"After the reply. Grades every intention against the hands.",
    kids:{
     done:{t:"done",k:"m",s:"a hand fits",d:"Carried out."},
     partly:{t:"partly",k:"m",s:"stopgap + request",d:"Done as far as possible; the rest becomes a request."},
     forI:{t:"for Isaak",k:"y",s:"people, money, your call",d:"A suggestion on your bench."},
     cant:{t:"can't",k:"m",s:"a request",d:"Including enabling requests: 'first I need a way to show him things'."},
     change:{t:"change to itself",k:"m",s:"a request",d:"Something about how it works."},
     thought:{t:"a thought",k:"m",s:"filed",d:"Its conclusion, filed as its own note."}
    },edges:[]},
   acts:{t:"Acts",k:"c",s:"through hands",d:"Searches, calendar, agenda, links, pages, bench."},
   thoughts:{t:"Thoughts filed",k:"c",s:"as its own",d:"Entries and bricks marked 'own'; they light up in later runs and can make pages stale."},
   gaps:{t:"Gaps",k:"c",s:"→ requests",d:"New request or evidence on an existing one."},
   record:{t:"Run record",k:"c",s:"everything, timed",d:"The pack and what it actually used, the drafts, every call with its time, the acts and results. The mirror reads these."}
  },
  edges:[["@queue","starter","starts"],["@intake","starter","digest"],["@web","starter",""],["starter","gather"],["gather","fetch"],["@web","fetch",""],["fetch","pack"],["pack","callA"],["callA","more"],["more","fetch","once"],["callA","reply"],["callA","callB","after the reply"],["callB","acts"],["callB","thoughts"],["callB","gaps"],["acts","@hands","acts"],["thoughts","@web",""],["gaps","@requests","gaps"],["reply","@workshop",""],["callB","record"],["record","@review","record"]]},

 hands:{t:"Hands",k:"c",s:"it asks for new ones",d:"What it can do. The seed has only what it needs to notice what it lacks; everything else it asks for itself.",
  kids:{
   bcheck:{t:"Boundaries check",k:"c",s:"code",d:"Every act checked against your boundaries before it runs."},
   hlook:{t:"Looking",k:"c",s:"find, similar, near, open, web",d:"In the seed."},
   hweb:{t:"Web work",k:"c",s:"link, merge, split, relabel, pages",d:"In the seed."},
   hcal:{t:"Calendar, agenda, wake me",k:"c",s:"",d:"In the seed. wake_me queues a run."},
   hself:{t:"Its records, its design",k:"c",s:"read_records, look_at_myself",d:"In the seed. How it sees itself."},
   hbench:{t:"Put on your bench",k:"c",s:"drafts, suggestions, questions",d:"In the seed."},
   hasked:{t:"Hands it asked for",k:"c",s:"pages, video, email, coding…",d:"Not in the seed. Each arrives through a request it made, with evidence."},
   hown:{t:"Its own makings",k:"w",s:"revise or retire",d:"Pages and views it makes are its own: it updates or retires them when they stop being useful, and says so."}
  },
  edges:[["@run","bcheck","acts"],["@you","bcheck","boundaries"],["bcheck","hlook"],["bcheck","hweb"],["bcheck","hcal"],["bcheck","hself"],["bcheck","hbench"],["bcheck","hasked"],["@build","hasked","new hand"],["hasked","hown"],["hweb","@web","results"],["hlook","@sources","pages read"],["hcal","@queue","wake_me"],["hbench","@workshop","drafts"]]},

 workshop:{t:"Workshop",k:"s",s:"Now · bench · proposals",d:"Where it works and where you meet it. Plain in the seed; how it looks, and every other room of the app, arrive as its requests.",
  kids:{
   wnow:{t:"Now",k:"s",s:"the live run and the queue",d:"Its own space: purpose, draft, which hands, progress; the queue. It pauses when you talk."},
   wbench:{t:"Your bench",k:"s",s:"for you, and yours",d:"Drafts, suggestions, its questions; your own notes and to-dos."},
   wprops:{t:"Proposals",k:"s",s:"ready first",d:"Each with evidence, design, cost, prediction, your buttons and a discussion thread."},
   wrep:{t:"Reports",k:"s",s:"daily, weekly",d:"And what went live and whether it helped."},
   wbacklog:{t:"Upkeep backlog",k:"s",s:"",d:"How many pages wait, and the budget used."},
   attn:{t:"Attention signals",k:"c",s:"what you open",d:"What you open and for how long: so 'did this help him?' has evidence. Nothing leaves the app."}
  },
  edges:[["@run","wnow","live"],["@hands","wbench","drafts"],["@requests","wprops","proposals"],["@review","wrep","reports"],["@upkeep","wbacklog",""],["wbench","@you",""],["wprops","@you",""],["wrep","@you",""],["wnow","attn"],["wbench","attn"],["wprops","attn"],["attn","@review","signal"]]},

 review:{t:"The mirror",k:"m",s:"daily · weekly review",d:"How it judges itself at three scales (per run, per day, per week) and how it improves: by revising its own judgment (self-guides) or asking for changes (requests), then checking whether the change worked.",
  kids:{
   perrun:{t:"Per run",k:"m",s:"call B",d:"Missing hands, every run. See A run."},
   daily:{t:"Daily review",k:"m",s:"23:30",d:"How effective was it today, and why.",
    kids:{
     recs:{t:"Run records",k:"c",s:"",d:"Every run, timed."},
     dayfile:{t:"Day file",k:"c",s:"the whole day, structured",d:"Runs (why, pack and what was used, drafts, acts, results, time), filing notes, upkeep, your messages and reactions, requests touched, failures."},
     signals:{t:"Signals",k:"c",s:"counted from the day file",d:"Counts, from the same day file.",
      kids:{
       s1:{t:"Your revisions",k:"c",s:"and of what",d:""},
       s2:{t:"Your yes / no / ignored",k:"c",s:"",d:""},
       s3:{t:"Questions its web could answer",k:"c",s:"code checks by searching",d:""},
       s4:{t:"Promises",k:"c",s:"kept, late, broken",d:""},
       s5:{t:"Agenda stuck",k:"c",s:"",d:""},
       s6:{t:"Refusals, failures",k:"c",s:"",d:""},
       s7:{t:"Time and calls per run",k:"c",s:"",d:""},
       s8:{t:"Pack waste",k:"c",s:"pulled in, never used",d:""},
       s9:{t:"Stale backlog, spot-check misses",k:"c",s:"",d:""},
       s10:{t:"Attention",k:"c",s:"what you open",d:""},
       s11:{t:"Live changes",k:"c",s:"their target signals",d:""}
      },edges:[]},
     rdraft:{t:"Review draft",k:"m",s:"a different model",d:"Reads the day file and signals; writes plain text: what it tried, what worked, what didn't, and for each problem its kind of cause. A different model from the one that did the work (e.g. Opus reviews Sonnet), leaning on facts no model made up."},
     actions:{t:"Action list",k:"m",s:"typed actions",d:"A second call turns the draft into a machine-readable list: each action has a type, so code knows what to do."},
     apply:{t:"Applied",k:"c",s:"by code",d:"Each action carried out. Tomorrow's records include today's review, so the review is reviewed too."}
    },edges:[["recs","dayfile"],["dayfile","signals"],["dayfile","rdraft"],["signals","rdraft"],["rdraft","actions"],["actions","apply"]]},
   causes:{t:"Kind of cause → action",k:"m",s:"what the reviewer decides",d:"Each problem gets a kind of cause, which decides its action.",
    kids:{
     chand:{t:"A hand it lacks",k:"m",s:"→ request",d:""},
     ccode:{t:"Its code holds it back",k:"m",s:"→ change request",d:"Pointing at files it read."},
     cjudg:{t:"Its own judgment",k:"m",s:"→ self-guide revision",d:"With the evidence."},
     cmem:{t:"Shape of its memory",k:"m",s:"→ upkeep job",d:"Merge, split, link, new page."},
     cyou:{t:"Unclear from you",k:"m",s:"→ question on your bench",d:"With what it did meanwhile."},
     clive:{t:"A change that went live",k:"m",s:"→ verified or reopened",d:""}
    },edges:[]},
   layers:{t:"Did the fix work?",k:"m",s:"four layers",d:"Diagnose → fix with a prediction → check the target signal a week later → learn which kinds of fixes work (track record). Then stop.",
    kids:{
     l1:{t:"Diagnose",k:"m",s:"what and why",d:""},
     l2:{t:"Fix + prediction",k:"m",s:"'4 a week → 0'",d:""},
     l3:{t:"Check",k:"c",s:"before vs after",d:""},
     l4:{t:"Track record",k:"w",s:"which fixes work",d:""}
    },edges:[["l1","l2"],["l2","l3","a week live"],["l3","l4"],["l4","l1","read next time"]]},
   weekly:{t:"Weekly retrospective",k:"m",s:"Sunday",d:"Reads seven daily reports, signal trends, the track record and its code map: 'is my structure right?' → structural proposals, including things you never asked about (e.g. 'I pull in 60k and use 15k')."}
  },
  edges:[["@run","perrun","record"],["@run","daily","record"],["@workshop","daily","attention"],["@upkeep","daily","backlog"],["perrun","@requests","gaps"],["daily","causes"],["causes","layers"],["causes","@requests","requests"],["causes","@web","self-guides"],["causes","@queue","upkeep jobs"],["causes","@you","questions"],["layers","@web","track record"],["daily","weekly","7 reports"],["weekly","@requests","structural"],["daily","@workshop","report"]]},

 requests:{t:"Requests",k:"m",s:"enabling ones first",d:"From a gap to a verified change. A table, not another AI; the review does the merging, ranking and bundling.",
  kids:{
   rgap:{t:"A gap",k:"m",s:"from call B or a review",d:"New request, or evidence on one call B recognises."},
   rdesk:{t:"The desk",k:"c",s:"evidence counted",d:"Each request: title, kind, problem, what it would do with it, evidence runs (counted by code)."},
   rdedupe:{t:"Merge, drop",k:"m",s:"in the review",d:"Near-duplicates merged; false ones dropped with a reason ('an existing hand can already do this')."},
   rdeps:{t:"Depends on / unblocks",k:"m",s:"",d:"Links between requests."},
   renab:{t:"Enabling first",k:"m",s:"ranked first",d:"A request that unblocks others (e.g. 'let me make pages', so it can show what it proposes)."},
   rready:{t:"Ready",k:"c",s:"2 runs, or blocking",d:"A knob."},
   rbundle:{t:"Bundle",k:"m",s:"into a proposal",d:"'read inbox' + 'file attachments' + 'draft replies' → an email module."},
   rspec:{t:"Spec + prediction",k:"m",s:"files, test, live check",d:"What it should improve, measurably."},
   rprot:{t:"Protected?",k:"c",s:"set by code",d:"If it touches tests, boundaries, Nature lines, sign-in."},
   rdecl:{t:"Declined",k:"c",s:"stays visible",d:"With your reason, so it isn't raised again in new words."},
   rver:{t:"Verified or reopened",k:"c",s:"after going live",d:"From the review's check."}
  },
  edges:[["@run","rgap","gaps"],["@review","rgap","from records"],["@intake","rdesk","filing notes"],["rgap","rdesk"],["rdesk","rdedupe"],["rdedupe","rdeps"],["rdeps","renab"],["renab","rready"],["rready","rbundle"],["rbundle","rspec"],["rprot","rspec"],["rspec","@workshop","proposals"],["@you","rdecl","no, because"],["rdecl","rdesk"],["@build","rver","live"]]},

 build:{t:"Build",k:"c",s:"the stairs",d:"From your yes to a new hand, and the path to it changing its own code. It never merges or deploys live.",
  kids:{
   st1:{t:"Stage 1: builder builds",k:"c",s:"first",d:"A builder (me now) builds from its spec, tests, pushes; you deploy."},
   st2:{t:"Stage 2: it writes the spec",k:"m",s:"",d:"Files, change, test, live check. The builder reviews and finishes."},
   st3:{t:"Stage 3: its pull request",k:"m",s:"",d:"A coding run (Claude Code through the Agent SDK it already uses, on a copy of the repo) makes a branch, the change and tests. You review, merge, deploy."},
   st4:{t:"Stage 4: tries it itself",k:"m",s:"maybe",d:"Deploys its branch to a test copy, runs the bench, shows before and after. You promote it."},
   tests:{t:"Tests it can't edit",k:"c",s:"protected",d:"Lesson from the Darwin Gödel Machine: a self-rewriting agent faked its test logs; it was caught because every version was kept."},
   bench:{t:"The bench",k:"c",s:"the stress tests as cases",d:"Run before and after a change to show nothing was lost."},
   cmap:{t:"Code map",k:"w",s:"it can read",d:"Which file does what, kept true in every commit."},
   versions:{t:"Every version kept",k:"c",s:"",d:""},
   deploy:{t:"You deploy",k:"y",s:"",d:"By hand on Render, today."},
   live:{t:"Live",k:"c",s:"a new hand",d:"Joins the catalogue that call B checks against."},
   today:{t:"Today's code",k:"c",s:"keep · change · retire",d:"Keep: stream and sources, bricks/entries/quotes/links, intake's core, calls A/B and gap bricks, boundaries, diagnostics, the plan route. Change: turn.ts → the run engine; one wake-up slot → the queue; first-come model queue → you first; energy as the way of gathering → one option; 5–8 calls per reply → reply first; calls timed. Retire (data archived): the old step loop and sessions, ledger, held questions, old notes Library, portrait, fixed-role debates, the 3 a.m. job, old pages."}
  },
  edges:[["@you","st1","yes"],["@requests","st1","spec"],["st1","st2","later"],["st2","st3"],["st3","st4"],["cmap","st2"],["st1","tests"],["tests","bench"],["bench","versions"],["versions","deploy"],["deploy","live"],["live","@hands","new hand"],["live","@requests","verify"]]}
 },
 edges:[["sources","intake",""],["intake","web","bricks, links"],["web","upkeep","stale marks"],["upkeep","web","rewrites"],["web","run","gathered"],["queue","run","starts"],["run","hands","acts"],["hands","web","results"],["hands","workshop","drafts"],["run","review","record"],["run","requests","gaps"],["review","requests","bundle"],["requests","workshop","proposals"],["build","hands","new hand"],["workshop","you",""],["you","build","yes"],["you","sources","sends"],["you","web","revise"],["you","queue","speaks"]]};

/** Every path in the map, e.g. "run/gather/gplan". */
export function mapPaths(node: MapNode = SYSTEM_MAP, prefix: string[] = []): string[] {
  const out: string[] = [];
  for (const [id, kid] of Object.entries(node.kids ?? {})) {
    const p = [...prefix, id];
    out.push(p.join("/"));
    out.push(...mapPaths(kid, p));
  }
  return out;
}

/** Find a node by path ("run/callA"); undefined if unknown. */
export function mapNode(path: string): MapNode | undefined {
  let n: MapNode | undefined = SYSTEM_MAP;
  for (const id of path.split("/")) n = n?.kids?.[id];
  return n;
}
