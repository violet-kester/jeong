---
description: Grade a Jeong journal entry (raw transcript, how lightly the story was touched, voice, nothing invented or lost, summary, tokens, speed), read-only
argument-hint: "[words from the entry's folder name | last N] [optional focus]"
allowed-tools: Bash, Read, Write
---

# QA: a Jeong entry

Grade what Jeong made from one recording. **Follow `plugin/qa/base.md`** for everything not below.

| | |
|---|---|
| Slug and name | `entry`, "Jeong entry" |
| Rubric | `plugin/qa/entry.md` |
| Gather, from `plugin/` | `node qa/gather-entry.mjs $ARGUMENTS` |
| Record key | the entry's title, dated by the entry |

No arguments is the newest written entry, words pick by folder name, and `last N` grades several, with a one-table roll-up at the end.

**Then read the entry as the person who said it would, and ask: does this still sound like me?** Be strictest on needless changes: a
change that made the entry no easier to read has cost their voice for nothing.

**One extra report section, right after the score table: Heavy-handed edits.** Every needless change, as "said → written", and what it
cost. "None" is a good answer.
