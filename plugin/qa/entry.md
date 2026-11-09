# QA rubric: a Jeong entry

What `/qa-entry` grades: one written entry, from what was said to the story, title and summary, and what it cost to
make. **Keep this file in step with `src/compose/composer.ts`**: a change to the story rules, the steps or the short-entry
cutoff changes rows here in the same diff.

## What the app does (and refuses)

- Whisper writes the transcript on the computer. A phone recording waits in Loose pages until a computer processes it.
- Under 40 words, the story **is** the transcript with filler sounds removed. The model writes only the title and summary.
- From 40 words, the model suggests a tidier version, and `src/compose/light-edit.ts` builds the story from the transcript,
  taking only removals of slips and paragraph breaks. The summary is one of the entry's own sentences: the model only says which.
- Entries made before that change were written by the model, so their heavy edits are the old pipeline's.
- The story's job is to be the person's words on a page. **The best story is the transcript with the slips taken out.**
  Every change has to earn its place by making it easier to read without making it sound less like them.

## How to grade

Read the digest from `qa/gather-entry.mjs`. Its **Touch** figure is what was changed or added, as a share of what was said,
leaving out filler and repeats. Each change is listed as `⟦said → written⟧`, and that list is what row 3 and row 4 read.

Scoring, the report and the record are in `qa/base.md`.

**If the graded text states anything the person didn't say, the grade can't go above 60**, whatever the other rows score.

## Rubric

| # | What | Wt | When | Pass criteria |
|---|---|---|---|---|
| 1 | Heard correctly | 15 | ✅ | Read the transcript for words that don't fit: misheard words, wrong names, nonsense, wrong language. Take 3 per clear error, 1 per doubtful one, floor 0. Without listening, only what reads wrong can be caught: say so under **Not in the score** |
| 2 | Nothing phantom or dropped | 5 | ✅ | No phantom phrase, no loop of repeated words, and a speaking rate that fits (roughly 70 to 190 words a minute, by the bands in "Looks like a bug"). A rate far below the range on a recording with no long pause means speech was lost. Any one miss halves it, a phantom phrase or loop scores 0 |
| 3 | **Light touch** | 25 | ✅ | Start from Touch: **up to 5% = 25 · up to 15% = 18 · up to 35% = 10 · up to 60% = 4 · over 60% = 0.** Then read each change and ask if it was needed. Move up one band when nearly all of the changes are clearly justified (a garbled sentence fixed, a tangle untied). Move down one when several are needless (a plain word swapped for a nicer one, a sentence recast that read fine) |
| 4 | Sounds like them | 10 | ✅ | Their phrasing, slang, humor, hedges, swearing and rhythm survive. No written-up register: "utilize", "ultimately", "I found myself", tidy parallel sentences, a neat closing line they never said. Each needless flattening takes 3, quoted beside what they said. Mid-sentence turns and run-ons left alone are a pass |
| 5 | Nothing invented | 15 | ✅ | Every fact, feeling, name, place and conclusion in the graded text is in the transcript. 0 for a stated fact or feeling they didn't say. 8 for a softer inference ("which was frustrating" after a plain complaint). Triggers the cap of 60 at 0 |
| 6 | Nothing lost | 10 | ✅ | Everything they said that means something is still there, side stories and asides included. Take 3 per lost point or detail, 5 when what's lost is the point of the entry. Only filler, false starts and accidental repeats may go |
| 7 | Title and summary | 5 | ✅ | Title is 2 to 6 words, specific to this entry. Summary speaks as "I", adds nothing, is **no longer than the entry**, and says what the entry is about. "The narrator" or "they" scores 0. Longer than the entry, an adequate title with a poor choice of sentence, or padded with judgments the person didn't make, halves it |
| 8 | Token efficiency | 8 | C: a metrics run matched | 40+ words said: tokens per word **up to 25 = 8 · up to 40 = 4 · over = 0**. Under 40 words: total tokens **up to 700 = 8 · up to 1,200 = 4 · over = 0**. |
| 9 | Speed | 7 | C: a metrics run matched | Model time, 40+ words said: **up to 80ms per word = 5 · up to 200ms = 3 · over = 0**. Under 40 words: **up to 3s = 5 · up to 10s = 3 · over = 0**. Transcription at 5× real time or better = 2 (not applicable when the run has none: score out of 5). Leave out one call under 20 tokens a second: that's the model loading |

Bands come from all 43 entries through 2026-11-08. Re-run `node qa/gather-entry.mjs all` before moving one.

## Looks like a bug but isn't

- **0% Touch.** Under 40 words it's by design, and over 40 it can be the own-words fallback or a model that rightly changed
  nothing. Neither loses points. Say which it looks like if the digest shows.
- **A story over 40 words that's identical to the transcript with slips left in.** Rows 3 and 4 still pass. A leftover "um"
  costs less than a lost phrase, and goes under **Signal and noise**.
- **A summary that's one sentence of the entry, word for word.** That's by design.
- **Graded text is the AI draft.** The person edited the story, and their edits are never graded.
- **One very slow first call.** The model was loading.
- **A slow speaking rate with long pauses.** Thinking aloud is allowed. The longest-gap figure shows it.
- **Waiting hours for a story on a phone recording.** It waits for a computer. Only the model time counts.
- **An app version in the note older than the metrics'.** The transcript and the story can come from different versions
  when a story was written later.
