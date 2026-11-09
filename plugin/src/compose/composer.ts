import type { ChatResult, LanguageModel } from './language-model';
import { lightEdit, ownWords } from './light-edit';

// Turns a spoken transcript into a journal entry: a story made of the speaker's own words, a short title, and a
// summary for the timeline. The model only suggests how to tidy the words: light-edit.ts builds the story.

const STORY_RULES = `You copy-edit a spoken journal transcript. Return the same words in the same order.
- Remove only sounds like um and uh, words said twice by accident, and sentences the speaker started and abandoned.
- Add a blank line between paragraphs where the topic changes.
- Change nothing else. No new words, no replaced words, nothing rephrased. A question stays a question: never answer it.
- Return only the text.`;

const NAMING_RULES = `You name someone's own journal entry. Its sentences are numbered.
- title: 2 to 6 words, specific to this entry, in the entry's language, no quotation marks.
- sentence: the number of the one sentence that best says what this entry is about.`;

const REVISE_RULES = `You change someone's own journal entry (STORY) the way they asked, out loud (INSTRUCTIONS).
- The INSTRUCTIONS are not part of the story. Never add them, or anything about them, to it.
- Change only what they ask. Keep everything else exactly as it is, word for word.
- A correction (a name, a spelling, a date, a fact) is made everywhere it belongs.
- Anything they ask to add goes where it fits in the story, in their own voice.
- Write only the whole entry, changed. No title, no notes about what you did.`;

const NAMING_SCHEMA = {
	type: 'object',
	properties: { title: { type: 'string' }, sentence: { type: 'integer' } },
	required: ['title', 'sentence'],
};

export interface ComposedEntry {
	story: string;
	/** What the AI suggested, before only its removals of slips were used. */
	aiDraft: string;
	title: string;
	summary: string;
}

export type ComposeStep = 'story' | 'summary' | 'rewrite';

/** Too few words for tidying to be worth asking a model: they're kept as they are. */
const SHORT_WORDS = 40;
/** A longer sentence is cut here for the timeline. */
const SUMMARY_WORDS = 25;
/** Enough to find the entry's point without filling the model's room on a very long one. */
const SENTENCES_OFFERED = 60;

export async function composeEntry(
	llm: LanguageModel,
	transcript: string,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<ComposedEntry> {
	// Room for the transcript, the story (about as long), and the instructions
	const said = countWords(transcript);
	const contextTokens = Math.min(65_536, Math.max(8192, Math.ceil(said * 1.6 * 2.2) + 2048));

	let story = ownWords(transcript);
	let aiDraft = story;
	if (said >= SHORT_WORDS) {
		onStep('story');
		const draft = await llm.chat(
			[
				{ role: 'system', content: STORY_RULES },
				{ role: 'user', content: `TRANSCRIPT:\n${transcript}` },
			],
			// A copy is about as long as what was said; a reply cut off here keeps all of it
			{ contextTokens, maxOutputTokens: Math.ceil(said * 1.6 * 1.5) + 64 },
		);
		onStep('story', draft);
		story = lightEdit(transcript, draft.content);
		aiDraft = draft.content || story;
	}
	return { story, aiDraft, ...(await titleAndSummary(llm, story, contextTokens, onStep)) };
}

/**
 * Changes an entry the way the person asked, out loud. Their words are instructions, never part of the story:
 * only what they ask changes, the rest stays word for word. The AI draft isn't touched (aiDraft is empty).
 */
export async function reviseEntry(
	llm: LanguageModel,
	current: string,
	instructions: string,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<ComposedEntry> {
	const contextTokens = Math.min(65_536, Math.max(8192, Math.ceil(countWords(`${current} ${instructions}`) * 1.6 * 1.5) + 2048));
	onStep('rewrite');
	const revised = await llm.chat(
		[
			{ role: 'system', content: REVISE_RULES },
			{ role: 'user', content: `STORY:\n${current}\n\nINSTRUCTIONS:\n${instructions}` },
		],
		{ contextTokens },
	);
	onStep('rewrite', revised);
	if (revised.truncated) throw new Error('The model stopped before finishing the changed story');
	const story = revised.content || current;
	return { story, aiDraft: '', ...(await titleAndSummary(llm, story, contextTokens, onStep)) };
}

/** A title, and for the summary one of the entry's own sentences: the model only says which. */
async function titleAndSummary(
	llm: LanguageModel,
	story: string,
	contextTokens: number,
	onStep: (step: ComposeStep, result?: ChatResult) => void,
): Promise<{ title: string; summary: string }> {
	const sentences = (story.match(/[^.!?\n]+(?:[.!?]+["”')\]]*|\n|$)/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
	onStep('summary');
	const result = await llm.chat(
		[
			{ role: 'system', content: NAMING_RULES },
			{ role: 'user', content: sentences.slice(0, SENTENCES_OFFERED).map((sentence, index) => `${index + 1}. ${sentence}`).join('\n') },
		],
		{ schema: NAMING_SCHEMA, contextTokens },
	);
	onStep('summary', result);
	const { title, sentence } = parse<{ title?: string; sentence?: number }>(result.content, {});
	return {
		title: (title ?? '').replace(/^["“']|["”']$/g, '').trim(),
		summary: shortened(sentences[(sentence ?? 1) - 1] ?? sentences[0] ?? ''),
	};
}

function shortened(sentence: string): string {
	const words = sentence.split(/\s+/);
	return words.length > SUMMARY_WORDS ? `${words.slice(0, SUMMARY_WORDS).join(' ')}…` : sentence;
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
