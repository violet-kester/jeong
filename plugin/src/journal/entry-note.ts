// The layout of the notes in an entry folder, known here and nowhere else.
//
// An entry note is: frontmatter, the recording players, the links line, any callouts, the story, the photos.
// A transcript note is: frontmatter, callouts, then players and phrases ("**[0:12]** words") in order.

export interface EntryNote {
	/** With its closing newline, or '' if the note has none. */
	frontmatter: string;
	/** Embeds on their own line that aren't photos: the recording players. */
	players: string[];
	/** The small line of links under the players, or ''. */
	links: string;
	/** Callouts Jeong wrote (e.g. a loose page's "waiting" note); never part of the story. */
	notes: string[];
	story: string;
	/** The photo embeds, in order. */
	photos: string[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/;
const OWN_EMBED = /^!\[\[[^\]]+\]\]$/;
const LINKS_LINE = /^\*\[\[.*\]\]\*$/;
const PHOTO_EMBED = /(?:\[\[|[ /])photo \d+(?: \d+)?\.[a-z0-9]+\]\]$/i;
const TIMESTAMP = /^\*\*\[\d+(?::\d+)+\]\*\*\s*/;

function frontmatterOf(content: string): string {
	return FRONTMATTER.exec(content)?.[0] ?? '';
}

export function parseEntryNote(content: string): EntryNote {
	const frontmatter = frontmatterOf(content);
	const note: EntryNote = { frontmatter, players: [], links: '', notes: [], story: '', photos: [] };
	const story: string[] = [];
	let inCallout = false;
	for (const line of content.slice(frontmatter.length).split(/\r?\n/)) {
		const trimmed = line.trim();
		// A callout is Jeong's; a plain blockquote is the person's own words, and stays in the story
		if (/^>\s*\[!/.test(trimmed) || (inCallout && trimmed.startsWith('>'))) {
			if (inCallout) note.notes[note.notes.length - 1] += `\n${trimmed}`;
			else note.notes.push(trimmed);
			inCallout = true;
			continue;
		}
		inCallout = false;
		if (OWN_EMBED.test(trimmed)) (PHOTO_EMBED.test(trimmed) ? note.photos : note.players).push(trimmed);
		else if (LINKS_LINE.test(trimmed)) note.links = trimmed;
		else story.push(line);
	}
	note.story = story.join('\n').trim();
	return note;
}

export function serializeEntryNote(note: EntryNote): string {
	const head = [note.players.join('\n'), note.links, ...note.notes].filter(Boolean).join('\n\n');
	return (
		`${note.frontmatter ? `${note.frontmatter.trimEnd()}\n\n` : ''}${[head, note.story].filter(Boolean).join('\n\n')}\n` +
		(note.photos.length ? `\n${note.photos.join('\n')}\n` : '')
	);
}

/** An entry's words: without frontmatter, players, the links line, callouts, or photos. */
export function storyText(content: string): string {
	return parseEntryNote(content).story;
}

/** The file name a photo embed points at. */
export function embeddedName(line: string): string {
	return line.replace(/^!\[\[|\]\]$/g, '').split('/').pop() ?? '';
}

/** What a story is, whatever its spacing, so a saved story can be recognized later. */
export function storyFingerprint(story: string): string {
	let hash = 5381;
	for (const char of story.replace(/\s+/g, ' ').trim()) hash = (hash * 33 + (char.codePointAt(0) ?? 0)) % 2147483647;
	return `s${hash.toString(36)}`;
}

/** Has a person changed this story since a machine wrote it, in Jeong (edited) or in the note itself (it no longer matches)? */
export function storyIsEdited(content: string): boolean {
	const note = parseEntryNote(content);
	const written = /^storyPrint:\s*"?(\w+)"?\s*$/m.exec(note.frontmatter)?.[1];
	return /^edited:\s*true\s*$/m.test(note.frontmatter) || (!!written && written !== storyFingerprint(note.story));
}

function transcriptBlocks(content: string): { frontmatter: string; blocks: string[] } {
	const frontmatter = frontmatterOf(content);
	return {
		frontmatter,
		blocks: content
			.slice(frontmatter.length)
			.split(/\r?\n\s*\r?\n/)
			.map((block) => block.trim())
			.filter(Boolean),
	};
}

const isPhrase = (block: string) => !block.startsWith('>') && !OWN_EMBED.test(block);

/** The spoken words from a transcript note, a paragraph per phrase. */
export function transcriptParagraphs(content: string): string[] {
	return transcriptBlocks(content).blocks.filter(isPhrase).map((block) => block.replace(TIMESTAMP, '').trim());
}

/** The spoken words on one line, as the story writer takes them. */
export function transcriptText(content: string): string {
	return transcriptParagraphs(content).join(' ');
}

/**
 * The transcript note with its words replaced. Each paragraph keeps its phrase's time when the number of
 * paragraphs is unchanged; if paragraphs were added or removed the times no longer line up, so they're dropped.
 */
export function withTranscript(content: string, text: string): string {
	const { frontmatter, blocks } = transcriptBlocks(content);
	const paragraphs = text.split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
	const sameCount = paragraphs.length === blocks.filter(isPhrase).length;
	let next = 0;
	const kept = blocks.flatMap((block) => {
		if (!isPhrase(block)) return [block];
		if (!sameCount) return [];
		const time = TIMESTAMP.exec(block)?.[0] ?? '';
		return [`${time}${paragraphs[next++] ?? ''}`];
	});
	return `${frontmatter ? `${frontmatter.trimEnd()}\n\n` : ''}${(sameCount ? kept : [...kept, ...paragraphs]).join('\n\n')}\n`;
}
