import type { ChatResult, Ollama } from './ollama';

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

export async function composeEntry(
	ollama: Ollama,
	transcript: string,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<ComposedEntry> {
	// Room for the transcript, the story (about as long), and the instructions
	const words = transcript.split(/\s+/).length;
	const contextTokens = Math.min(65_536, Math.max(8192, Math.ceil(words * 1.6 * 2.2) + 2048));

	onStep('story');
	const draft = await ollama.chat(
		[
			{ role: 'system', content: STORY_RULES },
			{ role: 'user', content: `TRANSCRIPT:\n${transcript}` },
		],
		{ contextTokens },
	);
	onStep('story', draft);
	let story = draft.content;

	onStep('check');
	let flagged = await check(ollama, transcript, story, contextTokens, onStep);
	if (flagged.length) {
		onStep('rewrite');
		const rewrite = await ollama.chat(
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
		flagged = await check(ollama, transcript, story, contextTokens, onStep);
	}

	onStep('summary');
	const summaryResult = await ollama.chat(
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
		const firstPerson = await ollama.chat(
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
	const summaryFlags = await check(ollama, transcript, summary ?? '', contextTokens, onStep);
	if (summaryFlags.length) {
		onStep('summary');
		const retry = await ollama.chat(
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
		flagged.push(...(await check(ollama, transcript, summary ?? '', contextTokens, onStep)));
	}

	return {
		story,
		aiDraft: draft.content,
		title: (title ?? '').replace(/^["“']|["”']$/g, '').trim(),
		summary: (summary ?? '').trim(),
		flagged,
	};
}

async function check(
	ollama: Ollama,
	transcript: string,
	story: string,
	contextTokens: number,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<string[]> {
	const result = await ollama.chat(
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
