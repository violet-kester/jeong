// A story is the person's own words with the slips taken out, and this file is what makes that true.
//
// A model can suggest a tidier version, but the story is never its text. The suggestion is compared word by word with
// what was said, and the only things taken from it are small removals of slips and paragraph breaks. Anything else it
// did (new words, replaced words, a question answered, a sentence recast) simply has no way into the story.

/** A longer stretch than this isn't a slip. */
const MAX_FALSE_START = 3;
const MAX_REPEAT = 4;
/** Taking out more than this share of what was said isn't tidying, so none of it is used. */
const MAX_REMOVED_SHARE = 0.15;
/** In a very short sentence one doubled word is already a big share, and still a slip. */
const ALWAYS_ALLOWED_REMOVALS = 2;
/** Comparing word by word grows with the square of the length; past this, the person's words stand as they are. */
const MAX_WORDS = 6000;

const PROTECTED = new Set(
	'not no never nothing nobody none nor cannot what why how when where who which one two three four five six seven eight nine ten'.split(' '),
);

interface Token {
	text: string;
	key: string;
	/** The first word of a paragraph, in a suggestion. */
	startsParagraph: boolean;
}

function tokens(text: string): Token[] {
	return text
		.split(/\r?\n\s*\r?\n/)
		.flatMap((paragraph) =>
			paragraph
				.split(/\s+/)
				.filter(Boolean)
				.map((word, index) => ({
					text: word,
					key: word.replace(/[’‘]/g, "'").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''),
					startsParagraph: index === 0,
				})),
		);
}

const endsSentence = (token: Token | undefined) => !token || /[.!?]["”')\]]*$/.test(token.text);

/** Negations, numbers, question words and names change what was meant, so they can't go as a "false start". */
function isProtected(said: Token[], index: number): boolean {
	const { key, text } = said[index]!;
	const midSentenceCapital = /^\p{Lu}/u.test(text) && !endsSentence(said[index - 1]) && !/^i(?:'|$)/.test(key);
	return PROTECTED.has(key) || key.endsWith("n't") || /\d/.test(key) || midSentenceCapital;
}

function inQuestion(said: Token[], start: number): boolean {
	let end = start;
	while (end < said.length - 1 && !endsSentence(said[end])) end++;
	return said[end]!.text.includes('?');
}

const sameWords = (said: Token[], a: number, b: number, size: number) =>
	a >= 0 && b + size <= said.length && Array.from({ length: size }).every((_, offset) => said[a + offset]!.key === said[b + offset]!.key);

/** A word or few said twice by accident, or a sentence begun and restarted at once with the same word. */
function isSlip(said: Token[], start: number, end: number): boolean {
	const size = end - start;
	if (size <= MAX_REPEAT && (sameWords(said, start, end, size) || sameWords(said, start - size, start, size))) return true;
	if (size > MAX_FALSE_START || said[end]?.key !== said[start]!.key || inQuestion(said, start)) return false;
	for (let index = start; index < end; index++) if (isProtected(said, index)) return false;
	return true;
}

/** What word by word is the same in both, as stretches of said words left out and places a paragraph starts. */
function compare(said: Token[], suggested: Token[]): { removed: [number, number][]; paragraphs: Set<number> } {
	const width = suggested.length + 1;
	const table = new Uint16Array((said.length + 1) * width);
	for (let i = said.length - 1; i >= 0; i--) {
		for (let j = suggested.length - 1; j >= 0; j--) {
			table[i * width + j] =
				said[i]!.key === suggested[j]!.key ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
		}
	}

	const removed: [number, number][] = [];
	const paragraphs = new Set<number>();
	let i = 0;
	let j = 0;
	let start = -1;
	let added = false;
	const close = () => {
		// A stretch with new words in it was a rewrite, and what was said stands
		if (start >= 0 && !added && i > start) {
			// "so I so we" can drop either "so"; the earliest place is the one a restart is recognized at
			let from = start;
			let to = i;
			while (from > 0 && said[from - 1]!.key === said[to - 1]!.key) {
				from--;
				to--;
			}
			removed.push([from, to]);
		}
		start = -1;
		added = false;
	};
	while (i < said.length || j < suggested.length) {
		if (i < said.length && j < suggested.length && said[i]!.key === suggested[j]!.key) {
			close();
			if (suggested[j]!.startsParagraph && j > 0 && endsSentence(said[i - 1])) paragraphs.add(i);
			i++;
			j++;
			continue;
		}
		if (start < 0) start = i;
		if (j >= suggested.length || (i < said.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
			i++;
		} else {
			added = true;
			j++;
		}
	}
	close();
	return { removed, paragraphs };
}

/** What was said, without filler sounds (um, uh, erm, hmm). */
export function ownWords(transcript: string): string {
	return transcript
		.replace(/\b(?:u+m+|u+h+|e+r+m+|h+m+)\b[,.]?\s*/gi, '')
		.replace(/[ \t]{2,}/g, ' ')
		.trim()
		// a sentence that started with one of them starts with a capital again
		.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, before: string, c: string) => before + c.toUpperCase());
}

/**
 * The story: what was said, with only the suggestion's removals of slips, and its paragraph breaks.
 * Every word comes from the transcript, in the order it was said, whatever the suggestion contains.
 */
export function lightEdit(transcript: string, suggestion: string): string {
	const base = ownWords(transcript);
	const said = tokens(base);
	const suggested = tokens(suggestion);
	if (!suggested.length || said.length > MAX_WORDS || suggested.length > said.length * 1.5 + 30) return base;

	const { removed, paragraphs } = compare(said, suggested);
	const slips = removed.filter(([start, end]) => isSlip(said, start, end));
	if (slips.reduce((total, [start, end]) => total + end - start, 0) > Math.max(ALWAYS_ALLOWED_REMOVALS, said.length * MAX_REMOVED_SHARE)) return base;

	const gone = new Set(slips.flatMap(([start, end]) => Array.from({ length: end - start }, (_, offset) => start + offset)));
	const capitalize = new Set(slips.filter(([start]) => endsSentence(said[start - 1])).map(([, end]) => end));
	let story = '';
	said.forEach((token, index) => {
		if (gone.has(index)) return;
		const text = capitalize.has(index) ? token.text.replace(/\p{Ll}/u, (c) => c.toUpperCase()) : token.text;
		story += story ? `${paragraphs.has(index) ? '\n\n' : ' '}${text}` : text;
	});
	return story;
}
