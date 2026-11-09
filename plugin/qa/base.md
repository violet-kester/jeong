# QA base: grading what Jeong made

Read by every `/qa-<thing>` command. One copy, so the method can't drift between commands.

**One home per fact:**

| Here (how to grade, for everything) | The command (`.claude/commands/qa-<slug>.md`) | The rubric (`plugin/qa/<slug>.md`) |
|---|---|---|
| the shape of a grade, previous records, scoring, the report, the record, the cost, the next step, proposing a change to this QA | the slug and name, what its gather script takes, the record's key, anything particular to grading this thing | what the feature does, the rows, the bands, what looks like a bug but isn't |

The rubric ships with the code it grades, so a change to the feature and to its rubric land in the same diff. A fact two
rubrics share moves here.

## The shape of a grade

**Previous record → gather (one call) → read the rubric → score → report → record → next step → improve.**

Code gathers and the model judges. `plugin/qa/gather-<slug>.mjs` returns everything the rubric scores in one digest. Grade
from that, and don't read product code or re-read files for something it shows.

**The grade is read-only.** Never change a journal entry, re-run a model on one, or edit the rubric during a grade.

**A journal is private.** Quote it only in the report and the record. Never post, upload or copy it anywhere else, and never
save a record outside the journal. No Slack post, no shared vault.

## 1. Previous record

`journalDir` is in `plugin/local.json`. Run `ls "<journalDir>/.jeong/qa/<slug>/" | tail -3` and read the newest. The report says
which findings came back. A fix counts only if the thing graded was made by a version that has it, so check the version in the
digest before calling a fix failed.

## 2. Scoring

Each row has a weight and a "when graded": ✅ always, or C conditional.

- A C row counts only when its condition held. Otherwise it leaves the score, with no deduction.
- **Score = points earned ÷ points for the rows that applied, and say how many applied.**
- Check the rubric's "Looks like a bug but isn't" list before docking anything. Grading by-design behaviour as a bug is the worst
  mistake a QA can make.
- **Reason first, render last.** Argue each row in prose, reach the verdict, then fill the table. Quote the words that lose points.
- Text after the arguments that isn't a target is a focus: grade only those rows and mark the score partial.

## 3. The report

Plain English, no internal labels. These sections in this order, none deleted (an empty one says so in a line). A command may add a
section of its own where it says to.

```markdown
## QA: <what was graded>, <when>

**Grade: N/100, M of K rows applied** · <the one thing to act on>

| # | What we checked | Wt | Result | Why |     ← every row, "—" with why when it didn't apply

**Not in the score:** <what a full pass still needs>
**Since the last record:** <which findings came back, which held>
**How it performed** <1-2 paragraphs, the finding, not the method>
**Signal and noise** <unscored: what it could have kept or dropped>
**Issues hit** <numbered: the finding, the quoted evidence, a likely fix>
**Fixes recommended** <at most six rows: Fix | Where it lands>
**What it cost** <§5>

## 🔁 Making this command better next time <§7>
```

## 4. The record

Save the report verbatim to `<journalDir>/.jeong/qa/<slug>/<yyyy-mm-dd>-<key-kebab>.md`, with the key the command names, under this
frontmatter, followed by a `## Discovery & bugfixes` log that grows as fixes land, with their commit hashes. Same day, same key:
update it in place with a dated re-QA note.

```yaml
---
target: <what was graded>
score: <N/100, M of K rows applied>
version: <the plugin version that made it>
graded: <yyyy-mm-dd>
status: graded | fixes-committed <hash>
---
```

## 5. What it cost

Two lines, in this form, and with `(last: …)` when there's a previous record:

```markdown
- The run: <tokens> tokens / <model seconds> model time
- This grade: <tokens> tokens / — credits / $<dollars>
```

The grade's line is the `grade cost:` line printed by `python3 $GOFIG_DIR/plugins/testing/scripts/session-tokens.py`. Run it last,
and say so beside it when the session did more than grade.

## 6. Next step

Findings point at the code, not at this one output. End the findings with the root-cause run as the next step, not an option:
"Next: root-cause these with `/dev:greenfield-refactor` (it reads the code behind each finding)." It's one invocation with every
finding in it, and it's the one step that reads product code. A clean run offers nothing. Fix on a yes, and ask before committing.
A rubric change lands with the code change it follows.

## 7. Making this command better next time

Read `$GOFIG_DIR/instructions/_meta/self-improve.md` and end the report with the section it describes. **The default is "Nothing this
run", at most one item, and you propose without applying.** This QA's own files are the command, this base, the rubric and the
gather script. An item takes one of these shapes:

- **A defect no row owns** → a new row in the rubric (weight, when graded, pass criteria).
- **A false positive you nearly logged** → a "looks like a bug but isn't" entry.
- **A band or weight that misgraded, or a row grading behaviour the feature no longer has** → the new number with its evidence, or
  the row retired. Re-run the gather script's `all` view before moving a band.
- **A fact two rubrics now share** → move it here.
- **Evidence the digest lacked** → a change to the gather script. That's how a grade's reads change, never a new step in a command.
- **A log or metric whose absence sent the grade the long way round** → name it and what it would save. Offer it only when most later
  grades would use it.
