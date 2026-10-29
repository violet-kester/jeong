import type { ChatResult, LanguageModel } from './language-model';

// Turns a spoken transcript into a journal entry: a story in the speaker's own voice,
// a short title, and a one-paragraph summary for the timeline. Then it checks the story
// against the transcript, so nothing invented slips in.

const STORY_RULES = `You turn a spoken journal recording into a written journal entry for the person who recorded it.

Rules:
- Write in the first person, as the speaker, in the same language as the transcript. If they mix languages, keep that.
- Keep their voice: their own words, phrases, humor, slang, and rhythm. Prefer their exact wording.
- Never add facts, feelings, names, places, or conclusions that are not in the transcript.
- Remove filler words (um, uh, like), false starts, and words said twice by accident.
- Put events in an order that's easy to follow. Keep natural side stories that show their personality.
- Use paragraphs. Match the length to how much they said: a long ramble becomes a long entry, not a few sentences.
- Write only the entry itself. No title, no introduction, no notes about what you did.`;

const SUMMARY_RULES = `You write a title and a summary for someone's own journal entry, in the same language as the entry.
- Title: 2 to 6 words, specific to this entry, no quotation marks.
- Summary: 1 to 3 sentences, written as the person themselves ("I", "my"). Never say "the narrator", "the speaker", "the author", or "they".
- Use only what's in the entry. Don't describe the day as quiet, busy, happy, or anything else unless the entry says so.`;

const REVISE_RULES = `You change someone's own journal entry (STORY) the way they asked, out loud (INSTRUCTIONS).
- The INSTRUCTIONS are not part of the story. Never add them, or anything about them, to it.
- Change only what they ask. Keep everything else exactly as it is, word for word.
- A correction (a name, a spelling, a date, a fact) is made everywhere it belongs.
- Anything they ask to add goes where it fits in the story, in their own voice.
- Write only the whole entry, changed. No title, no notes about what you did.`;

const CHECK_RULES = `You compare a written journal entry (STORY) with what the person actually said (TRANSCRIPT).
List every sentence from the STORY that states something not supported by the TRANSCRIPT: invented facts, names, feelings, or events.
Rewording is fine. Only list sentences whose meaning isn't in the transcript. If everything is supported, return an empty list.`;

const SUMMARY_SCHEMA = {
	type: 'object',
	properties: { title: { type: 'string' }, summary: { type: 'string' } },
	required: ['title', 'summary'],
};

const CHECK_SCHEMA = {
	type: 'object',
	properties: { unsupported: { type: 'array', items: { type: 'string' } } },
	required: ['unsupported'],
};

export interface ComposedEntry {
	story: string;
	/** What the AI wrote first, before the check step or anyone's edits. */
	aiDraft: string;
	title: string;
	summary: string;
	/** Sentences that may not be supported by the transcript, for the person to review. */
	flagged: string[];
}

export type ComposeStep = 'story' | 'summary' | 'check' | 'rewrite';

/**
 * Recordings shorter than this, in words, are kept in the person's own words: there's too little to shape, and a
 * model given almost nothing tends to make up the rest (a one-line test once came back as five paragraphs about
 * the gym and calling home).
 */
const SHORT_WORDS = 40;
/** A story longer than this, for what was said, has things in it that weren't: it falls back to their own words. */
const maxStoryWords = (said: number) => Math.round(said * 1.5) + 30;

export async function composeEntry(
	llm: LanguageModel,
	transcript: string,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<ComposedEntry> {
	// Room for the transcript, the story (about as long), and the instructions
	const words = countWords(transcript);
	const contextTokens = Math.min(65_536, Math.max(8192, Math.ceil(words * 1.6 * 2.2) + 2048));

	if (words < SHORT_WORDS) {
		const story = ownWords(transcript);
		const named = await titleAndSummary(llm, transcript, story, contextTokens, onStep);
		return { story, aiDraft: story, title: named.title, summary: named.summary, flagged: named.flagged };
	}

	onStep('story');
	const draft = await llm.chat(
		[
			{ role: 'system', content: STORY_RULES },
			{ role: 'user', content: `TRANSCRIPT:\n${transcript}` },
		],
		{ contextTokens },
	);
	onStep('story', draft);
	let story = draft.content;

	onStep('check');
	let flagged = await check(llm, transcript, story, contextTokens, onStep);
	if (flagged.length) {
		onStep('rewrite');
		const rewrite = await llm.chat(
			[
				{ role: 'system', content: STORY_RULES },
				{ role: 'user', content: `TRANSCRIPT:\n${transcript}` },
				{ role: 'assistant', content: story },
				{
					role: 'user',
					content: `These sentences are not supported by the transcript. Rewrite the entry without them, changing nothing else:\n${flagged.map((s) => `- ${s}`).join('\n')}`,
				},
			],
			{ contextTokens },
		);
		onStep('rewrite', rewrite);
		story = rewrite.content || story;
		flagged = await check(llm, transcript, story, contextTokens, onStep);
	}
	// Far longer than what was said, even after the check: something was made up that the check missed
	if (countWords(story) > maxStoryWords(words)) {
		story = ownWords(transcript);
		flagged = [];
	}

	const named = await titleAndSummary(llm, transcript, story, contextTokens, onStep);
	return { story, aiDraft: draft.content, title: named.title, summary: named.summary, flagged: [...flagged, ...named.flagged] };
}

/**
 * Changes an entry the way the person asked, out loud. Their words are instructions, never part of the story:
 * only what they ask changes, the rest stays word for word. The title and summary follow the changed story,
 * and both are checked against the transcript and the instructions together, since a correction is a fact too.
 * The AI draft isn't touched (aiDraft is empty).
 */
export async function reviseEntry(
	llm: LanguageModel,
	transcript: string,
	current: string,
	instructions: string,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<ComposedEntry> {
	const words = `${transcript} ${current} ${instructions}`.split(/\s+/).length;
	const contextTokens = Math.min(65_536, Math.max(8192, Math.ceil(words * 1.6 * 1.5) + 2048));
	onStep('rewrite');
	const revised = await llm.chat(
		[
			{ role: 'system', content: REVISE_RULES },
			{ role: 'user', content: `STORY:\n${current}\n\nINSTRUCTIONS:\n${instructions}` },
		],
		{ contextTokens },
	);
	onStep('rewrite', revised);
	const story = revised.content || current;
	const sources = `${transcript}\n\nCORRECTIONS AND ADDITIONS THE PERSON ASKED FOR:\n${instructions}`;
	onStep('check');
	const flagged = await check(llm, sources, story, contextTokens, onStep);
	const named = await titleAndSummary(llm, sources, story, contextTokens, onStep);
	return { story, aiDraft: '', title: named.title, summary: named.summary, flagged: [...flagged, ...named.flagged] };
}

/** A title and summary for the story, in the person's own voice, checked against what they said. */
async function titleAndSummary(
	llm: LanguageModel,
	transcript: string,
	story: string,
	contextTokens: number,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<{ title: string; summary: string; flagged: string[] }> {
	const flagged: string[] = [];
	onStep('summary');
	const summaryResult = await llm.chat(
		[
			{ role: 'system', content: SUMMARY_RULES },
			{ role: 'user', content: story },
		],
		{ schema: SUMMARY_SCHEMA, contextTokens },
	);
	onStep('summary', summaryResult);
	let { title, summary } = parse<{ title?: string; summary?: string }>(summaryResult.content, {});

	// Small models sometimes describe the person from outside ("the narrator", "they"); ask once more for "I"
	if (summary && /\b(the (narrator|speaker|author|user|person)|they|their|them)\b/i.test(summary)) {
		onStep('summary');
		const firstPerson = await llm.chat(
			[
				{ role: 'system', content: SUMMARY_RULES },
				{ role: 'user', content: story },
				{ role: 'assistant', content: summaryResult.content },
				{ role: 'user', content: 'Rewrite the summary as the person themselves, using "I" and "my". Keep the same title and the same facts.' },
			],
			{ schema: SUMMARY_SCHEMA, contextTokens },
		);
		onStep('summary', firstPerson);
		const fixed = parse<{ title?: string; summary?: string }>(firstPerson.content, {});
		summary = fixed.summary || summary;
		title = fixed.title || title;
	}

	// The summary is checked too: if it adds anything, it's rewritten once, then flagged
	const summaryFlags = await check(llm, transcript, summary ?? '', contextTokens, onStep);
	if (summaryFlags.length) {
		onStep('summary');
		const retry = await llm.chat(
			[
				{ role: 'system', content: SUMMARY_RULES },
				{ role: 'user', content: story },
				{ role: 'assistant', content: summaryResult.content },
				{
					role: 'user',
					content: `These sentences say things the entry doesn't. Rewrite the summary without them:\n${summaryFlags.map((s) => `- ${s}`).join('\n')}`,
				},
			],
			{ schema: SUMMARY_SCHEMA, contextTokens },
		);
		onStep('summary', retry);
		const fixed = parse<{ title?: string; summary?: string }>(retry.content, {});
		title = fixed.title || title;
		summary = fixed.summary || summary;
		flagged.push(...(await check(llm, transcript, summary ?? '', contextTokens, onStep)));
	}

	return { title: (title ?? '').replace(/^["“']|["”']$/g, '').trim(), summary: (summary ?? '').trim(), flagged };
}

async function check(
	llm: LanguageModel,
	transcript: string,
	story: string,
	contextTokens: number,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<string[]> {
	const result = await llm.chat(
		[
			{ role: 'system', content: CHECK_RULES },
			{ role: 'user', content: `TRANSCRIPT:\n${transcript}\n\nSTORY:\n${story}` },
		],
		{ schema: CHECK_SCHEMA, contextTokens },
	);
	onStep('check', result);
	const { unsupported } = parse<{ unsupported?: unknown }>(result.content, {});
	// Only keep sentences that really appear in the story, so a confused check can't flag made-up text
	return Array.isArray(unsupported)
		? unsupported.filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && story.includes(s.trim()))
		: [];
}

function parse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}

function countWords(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

/** The transcript as the story, in the person's own words: just without filler sounds (um, uh, erm, hmm). */
function ownWords(transcript: string): string {
	return transcript
		.replace(/\b(?:u+m+|u+h+|e+r+m+|h+m+)\b[,.]?\s*/gi, '')
		.replace(/[ \t]{2,}/g, ' ')
		.trim()
		// a sentence that started with one of them starts with a capital again
		.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, before: string, c: string) => before + c.toUpperCase());
}
