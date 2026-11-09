// Gathers everything /qa-entry grades, in one call, so the grader judges instead of hunting.
//
//   node qa/gather-entry.mjs                  the newest written entry
//   node qa/gather-entry.mjs "scrolling"      the newest entry whose folder name has those words
//   node qa/gather-entry.mjs last 5           the newest five
//   node qa/gather-entry.mjs all              one line of numbers per entry, no words (for setting the rubric's bands)
//
// Prints the entry's own words. Read it locally; never post it anywhere.
// The journal folder is "journalDir" in local.json.

import esbuild from 'esbuild';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

// The note layout is known in one place, so it's imported rather than copied
const bundled = await esbuild.build({ entryPoints: [join(here, '../src/journal/entry-note.ts')], bundle: true, format: 'esm', write: false });
const { parseEntryNote, storyIsEdited, transcriptParagraphs } = await import(
	`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const { journalDir } = JSON.parse(readFileSync(join(here, '../local.json'), 'utf8'));
if (!journalDir || !existsSync(journalDir)) throw new Error('Set "journalDir" in plugin/local.json to the journal folder');

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'hmm', 'hm', 'mm', 'ah']);
const PHANTOMS = /thanks? (you )?for watching|please subscribe|like and subscribe|subtitles by|transcribed by|\[(music|silence|blank_audio)\]/i;
/** Later than this after the entry's last AI write, a metrics run isn't that entry's. */
const MATCH_WINDOW_MS = 30_000;
/** A pause this long between model calls means a new piece of work. */
const RUN_GAP_MS = 120_000;
const CLEAN_CHECK_TOKENS = 8;

const words = (text) =>
	text
		.replace(/[’‘]/g, "'")
		.toLowerCase()
		.split(/[^\p{L}\p{N}']+/u)
		.map((word) => word.replace(/^'+|'+$/g, ''))
		.filter(Boolean);
const shown = (text) => text.split(/\s+/).filter(Boolean);
const field = (frontmatter, name) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(frontmatter)?.[1]?.replace(/^"|"$/g, '').trim() ?? '';
const seconds = (clock) => clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);

function loadEntries() {
	const entries = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(' (transcript).md') || name === 'transcript.md') entries.push(loadEntry(dir, name));
		}
	};
	walk(join(journalDir));
	return entries.filter(Boolean).sort((a, b) => a.when.localeCompare(b.when));
}

function loadEntry(dir, transcriptName) {
	const files = readdirSync(dir);
	const draftName = files.find((name) => name.endsWith(' (AI draft).md'));
	const noteName = files.find((name) => name.endsWith('.md') && name !== transcriptName && name !== draftName);
	if (!noteName || /Loose pages/.test(dir)) return null;
	const content = readFileSync(join(dir, noteName), 'utf8');
	const note = parseEntryNote(content);
	if (field(note.frontmatter, 'status') !== 'written') return null;
	const edited = storyIsEdited(content);
	const draft = draftName ? parseEntryNote(readFileSync(join(dir, draftName), 'utf8')).story : '';
	return {
		dir,
		folder: dir.split('/').pop(),
		frontmatter: note.frontmatter,
		when: `${field(note.frontmatter, 'date')} ${field(note.frontmatter, 'time') || '00:00'}`,
		title: field(note.frontmatter, 'title'),
		summary: field(note.frontmatter, 'summary'),
		duration: seconds(field(note.frontmatter, 'duration') || '0'),
		review: /^review:/m.test(note.frontmatter),
		edited,
		story: note.story,
		draft,
		// What the machine wrote: once the person has changed the story, their edits aren't the machine's to be graded on
		graded: edited ? draft : note.story,
		transcriptRaw: readFileSync(join(dir, transcriptName), 'utf8'),
		transcript: transcriptParagraphs(readFileSync(join(dir, transcriptName), 'utf8')),
		wroteAt: draftName ? statSync(join(dir, draftName)).mtimeMs : 0,
	};
}

/** Word-for-word alignment (longest common subsequence), as stretches of what changed between matching words. */
function align(fromText, toText) {
	const from = words(fromText);
	const to = words(toText);
	const width = to.length + 1;
	const table = new Uint16Array((from.length + 1) * width);
	for (let i = from.length - 1; i >= 0; i--) {
		for (let j = to.length - 1; j >= 0; j--) {
			table[i * width + j] = from[i] === to[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const hunks = [];
	let open = null;
	let i = 0;
	let j = 0;
	const flush = () => {
		if (open) hunks.push({ ...open, kind: kindOf(open, from, i) });
		open = null;
	};
	while (i < from.length || j < to.length) {
		if (i < from.length && j < to.length && from[i] === to[j]) {
			flush();
			i++;
			j++;
		} else {
			open ??= { at: i, removed: [], added: [] };
			if (j >= to.length || (i < from.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) open.removed.push(from[i++]);
			else open.added.push(to[j++]);
		}
	}
	flush();
	for (const hunk of hunks) hunk.before = from.slice(Math.max(0, hunk.at - 5), hunk.at).join(' ');
	return { saidWords: from.length, writtenWords: to.length, hunks };
}

function kindOf(hunk, from, end) {
	if (hunk.added.length) return hunk.removed.length ? 'swapped' : 'added';
	if (hunk.removed.every((word) => FILLERS.has(word))) return 'filler';
	// Said twice: the words removed are the very words that come next, or the ones just before
	const size = hunk.removed.length;
	const next = from.slice(end, end + size).join(' ');
	const last = from.slice(Math.max(0, hunk.at - size), hunk.at).join(' ');
	if (hunk.removed.join(' ') === next || hunk.removed.join(' ') === last) return 'repeat';
	return 'cut';
}

function editNumbers(alignment) {
	const count = (kinds, side) => alignment.hunks.filter((h) => kinds.includes(h.kind)).reduce((total, h) => total + h[side].length, 0);
	const tidied = count(['filler', 'repeat'], 'removed');
	const changedSaid = count(['cut', 'swapped'], 'removed');
	const added = count(['added', 'swapped'], 'added');
	const said = Math.max(1, alignment.saidWords);
	return {
		tidied,
		changedSaid,
		added,
		// The share of what was said that was changed for any reason but tidying filler and repeats, and what was put in
		touch: (changedSaid + added) / said,
		// How much of the written version is words they actually said
		ownWords: 1 - added / Math.max(1, alignment.writtenWords),
	};
}

function loadRuns() {
	const dir = join(journalDir, '.jeong/metrics');
	const records = readdirSync(dir)
		.filter((name) => name.endsWith('.jsonl'))
		.sort()
		.flatMap((name) =>
			readFileSync(join(dir, name), 'utf8')
				.split('\n')
				.filter((line) => line.trim())
				.flatMap((line) => {
					try {
						return [JSON.parse(line)];
					} catch {
						return [];
					}
				}),
		)
		.filter((record) => record.event === 'llm' || (record.event === 'transcribe' && record.kind === 'final'))
		.map((record) => ({ ...record, at: Date.parse(record.ts) }));

	const runs = [];
	let run = null;
	for (const record of records) {
		const startsNew =
			!run ||
			record.session !== run.session ||
			record.at - run.end > RUN_GAP_MS ||
			record.event === 'transcribe' ||
			(record.task === 'story' && run.llm.length > 0) ||
			startsNextShortEntry(record, run);
		if (startsNew) {
			run = { session: record.session, version: record.version, transcribe: null, llm: [], end: record.at, start: record.at - (record.ms ?? 0) };
			runs.push(run);
		}
		if (record.event === 'transcribe') run.transcribe = record;
		else run.llm.push(record);
		run.end = record.at;
	}
	return runs.filter((candidate) => candidate.llm.length);
}

/**
 * In a batch of retries a short entry has no story step to mark its start. A summary after a clean check, in a run
 * that already has its summary, is the next entry. (A check that finds nothing is exactly 8 tokens of empty JSON.)
 */
function startsNextShortEntry(record, run) {
	const last = run.llm[run.llm.length - 1];
	return record.task === 'summary' && last?.task === 'check' && last.outputTokens <= CLEAN_CHECK_TOKENS && run.llm.some((call) => call.task === 'summary');
}

/** Metrics carry no entry id, so a run is matched by when the AI draft was saved, and confirmed by the audio length when there is one. */
function nearestRun(entry, runs) {
	if (!entry.wroteAt) return null;
	let best = null;
	for (const run of runs) {
		const distance = Math.abs(entry.wroteAt - run.end);
		if (distance < MATCH_WINDOW_MS && (!best || distance < best.distance)) best = { run, distance };
	}
	return best;
}

function matchRun(entry, runs, entries) {
	const best = nearestRun(entry, runs);
	if (!best) return null;
	// Two entries landing on one run can't be told apart, and a wrong cost is worse than none
	if (entries.some((other) => other !== entry && nearestRun(other, runs)?.run === best.run)) return null;
	const { transcribe } = best.run;
	if (transcribe && Math.abs(transcribe.audioMs / 1000 - entry.duration) > 2) return null;
	return { ...best.run, confidence: transcribe ? 'time and audio length agree' : 'time only (story written later, no transcription beside it)' };
}

function runNumbers(run, saidWords) {
	const prompt = run.llm.reduce((total, call) => total + call.promptTokens, 0);
	const output = run.llm.reduce((total, call) => total + call.outputTokens, 0);
	const llmMs = run.llm.reduce((total, call) => total + call.ms, 0);
	return {
		calls: run.llm.length,
		prompt,
		output,
		total: prompt + output,
		perWord: (prompt + output) / Math.max(1, saidWords),
		llmMs,
		perWordMs: llmMs / Math.max(1, saidWords),
		speed: run.transcribe?.speed,
		transcribeMs: run.transcribe?.ms,
		slowest: run.llm.reduce((worst, call) => (call.ms > worst.ms ? call : worst)),
	};
}

function transcriptSignals(entry, said) {
	const stamps = [...entry.transcriptRaw.matchAll(/^\*\*\[(\d+(?::\d+)+)\]\*\*/gm)].map((match) => seconds(match[1]));
	const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
	const tokens = words(said);
	const threes = new Map();
	for (let i = 0; i + 2 < tokens.length; i++) {
		const three = tokens.slice(i, i + 3).join(' ');
		threes.set(three, (threes.get(three) ?? 0) + 1);
	}
	const repeated = [...threes].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
	return {
		phrases: entry.transcript.length,
		wordsPerMinute: entry.duration ? Math.round((tokens.length / entry.duration) * 60) : null,
		longestGap: gaps.length ? Math.max(...gaps) : 0,
		repeated,
		phantom: PHANTOMS.exec(said)?.[0] ?? null,
	};
}

const pct = (value) => `${Math.round(value * 100)}%`;

function table(entries, runs) {
	console.log(['when', 'said', 'written', 'touch', 'own', 'tidied', 'sumWords', 'calls', 'tokens', 'tok/word', 'llmMs', 'ms/word', 'x-real', 'wpm', 'edited'].join('\t'));
	for (const entry of entries) {
		const said = entry.transcript.join(' ');
		if (!entry.graded) continue;
		const numbers = editNumbers(align(said, entry.graded));
		const run = matchRun(entry, runs, entries);
		const used = run && runNumbers(run, words(said).length);
		const signals = transcriptSignals(entry, said);
		console.log(
			[
				entry.when,
				words(said).length,
				words(entry.graded).length,
				pct(numbers.touch),
				pct(numbers.ownWords),
				numbers.tidied,
				words(entry.summary).length,
				used?.calls ?? '-',
				used?.total ?? '-',
				used?.perWord.toFixed(1) ?? '-',
				used ? Math.round(used.llmMs) : '-',
				used?.perWordMs.toFixed(1) ?? '-',
				used?.speed ?? '-',
				signals.wordsPerMinute ?? '-',
				entry.edited ? 'yes' : '',
			].join('\t'),
		);
	}
}

function digest(entry, runs, entries) {
	const said = entry.transcript.join(' ');
	const alignment = align(said, entry.graded);
	const numbers = editNumbers(alignment);
	const signals = transcriptSignals(entry, said);
	const run = matchRun(entry, runs, entries);

	console.log(`# ${entry.title || entry.folder}`);
	console.log(`Folder: ${entry.dir}`);
	console.log(`Recorded ${entry.when}, ${entry.duration}s · engine: ${field(entry.frontmatter, 'engine')} · source: ${field(entry.frontmatter, 'source')}`);
	console.log(`Graded text: ${entry.edited ? (entry.draft ? 'the AI draft (the person has edited the story since)' : 'NONE: edited, and no AI draft kept') : 'the story as saved'}`);
	console.log(`Flagged for review by the app's own check: ${entry.review ? 'yes' : 'no'}`);

	console.log('\n## Transcript');
	entry.transcript.forEach((phrase) => console.log(`- ${phrase}`));
	console.log(`\nSignals: ${signals.phrases} phrases · ${signals.wordsPerMinute ?? '?'} words a minute · longest gap between phrase starts ${signals.longestGap}s`);
	console.log(`Phantom phrase: ${signals.phantom ?? 'none'} · three-word runs said 3+ times: ${signals.repeated.map(([text, count]) => `"${text}" ×${count}`).join(', ') || 'none'}`);

	console.log('\n## Graded text');
	console.log(entry.graded || '(none)');
	if (!entry.edited && entry.draft && words(entry.draft).join(' ') !== words(entry.story).join(' ')) {
		console.log('\n## First AI draft (before the check rewrote it)');
		console.log(entry.draft);
	}

	console.log('\n## Word-for-word comparison, transcript to graded text');
	console.log(`Said ${alignment.saidWords} words, written ${alignment.writtenWords}.`);
	console.log(`Touch (changed or added, tidying aside): ${pct(numbers.touch)} · own words: ${pct(numbers.ownWords)} · tidied filler and repeats: ${numbers.tidied} words`);
	const changes = alignment.hunks.filter((hunk) => hunk.kind !== 'filler');
	if (!changes.length) console.log('No changes beyond filler.');
	for (const hunk of changes) {
		console.log(`- [${hunk.kind}] …${hunk.before} ⟦${hunk.removed.join(' ') || '∅'} → ${hunk.added.join(' ') || '∅'}⟧`);
	}

	console.log('\n## Title and summary');
	console.log(`Title: ${entry.title}`);
	console.log(`Summary (${words(entry.summary).length} words, the entry is ${words(entry.graded).length}): ${entry.summary}`);

	console.log('\n## Cost and speed');
	if (!run) {
		console.log('No metrics run matched this entry. Rows 8 and 9 do not apply.');
		return;
	}
	const used = runNumbers(run, alignment.saidWords);
	console.log(`Matched by: ${run.confidence} · plugin ${run.version}`);
	console.log(`Model calls: ${used.calls} (${run.llm.map((call) => call.task).join(', ')})`);
	console.log(`Tokens: ${used.total} (${used.prompt} in, ${used.output} out) · ${used.perWord.toFixed(1)} per word said`);
	console.log(`Model time: ${(used.llmMs / 1000).toFixed(1)}s · ${used.perWordMs.toFixed(1)}ms per word said · slowest: ${used.slowest.task} ${(used.slowest.ms / 1000).toFixed(1)}s at ${used.slowest.tokensPerSecond} tokens/s`);
	console.log(used.speed ? `Transcription: ${(used.transcribeMs / 1000).toFixed(1)}s, ${used.speed}× real time · ${run.transcribe.model}` : 'Transcription: not in this run');
}

const args = process.argv.slice(2);
const entries = loadEntries();
const runs = loadRuns();
if (args[0] === 'all') {
	table(entries, runs);
} else {
	const count = args[0] === 'last' ? Number(args[1] ?? 1) : 1;
	const needle = args[0] === 'last' ? '' : args.join(' ').toLowerCase();
	const chosen = entries.filter((entry) => entry.folder.toLowerCase().includes(needle) && entry.graded).slice(-count).reverse();
	if (!chosen.length) console.log(`No written entry matches "${needle}".`);
	chosen.forEach((entry) => digest(entry, runs, entries));
}
