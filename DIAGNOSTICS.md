# Diagnostics

What the system actually did when Isaak used it: observed behaviour, why it happened, and what could change. Kept by the builder (Isaak, 16 Nov: "this is diagnostic data, so do store it somewhere… after every reply to me, if I did something new with it, look at the model and see what it did and store something when it's worth it"). Newest first. Not read by the app.

---

## 2026-11-16 20:18 · "It's making a mess of things": the to-do document he asked for

**What he did:** while going through the inbox (19:02 UTC, overwhelmed) he asked more than once for one core document to keep track of everything he still has to do. He has since used and revised "Open questions and to-dos to bring to Ragani" as that list.
**What it did:** at 19:03 the chat said it had started "Open questions and to-dos from the email dump". In the tree that summary is now called "Open questions and to-dos to bring to Ragani": the summary writer renames a summary to "the lasting topic" each time it rewrites it, and most items were for Ragani. Alongside it, three other summaries hold the same kind of content: "Dealing with the internship inbox" (39 sources, under Career and Open threads), "Onboarding at Wetlands International" (33) and "Open threads and waiting proposals" (29).
**Why it looks like a mess:**
- The title he asked for is not stable: rewriting can rename it, so his document gets lost.
- Nothing ties "the one document he asked for" together; each to-do also lands wherever else it fits (redundancy), so it shows in four places.
- The same summary often sits both under a summary and under that summary's parent (e.g. "Own angles…" and "Learning Python and GIS…" under "Internship as career exploration" and under Career). The tree looks doubled. Career has 12 children.
- An empty leftover: "Conversations before the method arrives" has no inputs since its proposal was moved out of How I work (builder's one-time move).
- There's no button on screen to merge summaries; only the chat or the tree button can do it.
- The chat told him "I won't add new proposals while the ten open ones wait", a rule nobody gave it. Ten proposals are open.
**Numbers:** 31 summaries (7 of them How I work), 104 sources, 32 emails, nothing waiting.
**Parked by Isaak:** "let's talk about that later".

## 2026-11-16 18:34 · His message got no answer; a deploy killed it

**What he did:** asked the chat (17:34:50 UTC) whether Kuto, Ragani and Thursday's meeting are all, "look expansively, cover the whole of Wetlands".
**What it did:** nothing. The chat showed not busy, round 0, while the corner said "Updating an outdated summary" (own time, unrelated and normal).
**Why:** the server restarted at 17:35:51 UTC, one minute after his message. That was the builder's push of DIAGNOSTICS.md, which Render auto-deployed. The answer was running in memory on the old instance and died with it. Nothing on boot picks up a message of his that never got a reply. Errors in an answer are also swallowed silently (`.catch(() => undefined)`), so a failed answer would look the same.
**Could change:** (1) on boot, answer any message of his that has no reply after it; (2) pushes that only touch docs skip the deploy (`[skip render]` in the commit message); (3) a failed answer says so in the chat instead of vanishing.
**Done:** (2) is the builder's habit now. (3) turned out to exist already: a failed answer posts "(Something went wrong while answering: …)". Only a restart killed it silently. Isaak chose a restart screen over (1): on a restart the screen shows a big spinning circle ("don't touch"), new chat messages are refused, and an answer already under way gets up to 25 seconds to finish before the server goes.

## 2026-11-16 18:27 · Chat said "I don't know" where a source existed

**What he did:** asked the chat where Ragani's request for his emergency contacts came from.
**What it did:** answered that the line was "my own note from earlier" and it couldn't point to the email.
**What was actually there:** the email "Contact Info" from Ragani van Heyningen (9 Nov, in Dutch) with three blank emergency-contact fields. It was placed in "Onboarding at Wetlands International" and "Dealing with the internship inbox", and the onboarding summary states it with a marker to that email.
**Why:** in its rounds it opened the tag "Ragani x Isaak meeting" (the calendar invite) and the Kuto emails, never the onboarding summary or the tag "from Ragani van Heyningen". It then judged it had "enough to answer". The only trace it had in front of it was its own earlier chat message, so it called the claim its own note.
**Could change (parked by Isaak):** a word search as a chat round option ("emergency" would have found it at once); and/or Isaak telling it in his words how to handle "where did this come from".

## 2026-11-16 17:38 · The first email batch (29 emails)

- **Good:** all placed, no errors. His three piles became summaries under Career (Onboarding, General Wetlands International mail: COP31, internship plans), plus "The Wetlands International team and its people" and "East Africa mangrove restoration and possible contacts". Facts got richer from the emails (full names, study, dates). Its own-work message picked out action items: Kuto's call offer, Ragani's emergency contacts, and the project spelling "To Plant Or Not To Plant".
- **Its proposals filed into How I work ▸ For its own time:** two proposals plus a summary made from one. Tidying didn't catch the earlier misfile; it got worse. The filer read "its own time" as "where its proposals go". **Fixed:** a line saying How I work holds only his own words, and the misfiled items moved out once.
- **Same opening in every internship summary:** Onboarding, the inbox summary and Career each start with the same rundown. Isaak: that's redundancy, leave it.
- **Life facts only from the internship angle:** "second-year Master's biology at Wageningen, Nov 2026 to Mar 2027" landed only in Career/Onboarding. There's no summary about his studies or where he is in life, and the My life summary itself mostly describes the system. Isaak waits to see if it builds that; otherwise he tells it (tree button for the existing tree, plus his words go into How I work).
- **Calendar invites unreadable:** the reader didn't treat .ics as text. **Fixed:** invites read as text, and the four existing ones re-read and placed. A signature logo (image001.png) came in as a file: noise, not acted on.

## 2026-11-16 15:00 to 15:40 · Moving his instructions into How I work

- **First move:** of the 13 instruction messages, only ~5 landed in How I work; the rest went into My life only (e.g. a new "What Isaak pushes back on: stock phrases…" summary). The instruction rule sat third of four points in the filer's prompt. **Fixed:** the rule moved to the top ("first, pay special attention to instructions"), the first move wiped, and the 13 put through again: chat 5, placing 2, core 7.
- **How I work was empty:** filed but not written, because summaries are only written when touched or at the lowest priority. Every model read "(nothing yet)". **Fixed:** How I work is rewritten right after something is filed into it.
- **Side effect:** tidying's notes during the move were written into an old own-work message that the undo then removed.

## 2026-11-16 14:00 · His inbox prep message, first time

- **Placed into:** Career, "Dealing with my inbox", "Internship at Wetlands International: the facts". His request for an inbox summary was honoured.
- **The chat promised things placing does:** "sorted by the three piles". Placing is separate.
- **Gap found:** the filer and tidying never read his instructions summary; only the chat did. This led to How I work.
- **Tags noisy:** 32 on his message. Generic tags were everywhere ("in English", "2026-11", "memory web"), and spelling duplicates came back after merges. Parked by Isaak until the emails are in.

## 2026-11-16 · Earlier

- **The chat didn't know its new abilities:** its self-description (HOW_I_WORK) was stale. Rule added: every change updates its self-description in the same change.
- **Tidying after deploy did nothing at first:** the first message was handled by the old version (deploy not live yet), and tidying only runs after a placement. A one-time whole-tree pass then regrouped My life into him and the system.
