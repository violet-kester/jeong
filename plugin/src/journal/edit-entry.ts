import { App, TFile } from 'obsidian';
import { renameToTitle, findTranscript } from './apply-story';
import { parseEntryNote, serializeEntryNote, withTranscript } from './entry-note';
import { addPhotos, setPhotos, type EntryPhoto } from './entry-writer';

export interface EntryEdits {
	title?: string;
	story?: string;
	transcript?: string;
	/** The saved photos to keep, in order; any others go to the trash. */
	photos?: string[];
	newPhotos?: EntryPhoto[];
}

/** Saves what a person changed by hand. A changed story is marked edited, so a machine won't write over it. */
export async function saveEntryEdits(app: App, note: TFile, edits: EntryEdits): Promise<void> {
	const folder = note.parent;
	if (!folder) throw new Error('The entry has no folder');

	if (edits.story !== undefined) {
		const story = edits.story.trim();
		let changed = false;
		await app.vault.process(note, (content) => {
			const parsed = parseEntryNote(content);
			if (parsed.story === story) return content;
			changed = true;
			return serializeEntryNote({ ...parsed, story });
		});
		if (changed) {
			await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				fm.edited = true;
			});
		}
	}

	if (edits.transcript !== undefined) {
		const transcript = findTranscript(app, note);
		const words = edits.transcript;
		if (transcript) await app.vault.process(transcript, (content) => withTranscript(content, words));
	}

	if (edits.photos) await setPhotos(app, note, edits.photos);
	if (edits.newPhotos?.length) await addPhotos(app, note, edits.newPhotos);

	// Last: renaming moves the folder
	const title = edits.title?.trim();
	if (title && title !== app.metadataCache.getFileCache(note)?.frontmatter?.title) {
		await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
			fm.title = title;
		});
		await renameToTitle(app, note, folder, title);
	}
}
