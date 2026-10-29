import { App, TAbstractFile, TFile, normalizePath } from 'obsidian';

// Finds the journal's entries using Obsidian's metadata cache, so nothing has to be read
// from disk. An entry is a note in the journal folder whose frontmatter has a date and a
// visibility (transcripts and other notes don't). Hidden entries (hidden: true) stay in the vault
// but are left off the timeline.

export interface EntryInfo {
	file: TFile;
	title: string;
	date: string; // YYYY-MM-DD
	time: string; // HH:mm, or '' if unknown
	duration: string;
	summary: string;
	/** recorded (waiting to be written up), transcribed, or written */
	status: string;
	/** The entry's photos, in order; the first is the main photo. */
	photos: TFile[];
	/** A picture Jeong painted for an entry without photos (frontmatter: painting). */
	painting: TFile | null;
}

export function listEntries(app: App, journalFolder: string): EntryInfo[] {
	const prefix = `${normalizePath(journalFolder)}/`;
	const entries: EntryInfo[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || typeof fm.date !== 'string' || !('visibility' in fm) || fm.hidden === true) continue;
		const painting = typeof fm.painting === 'string' ? app.vault.getAbstractFileByPath(normalizePath(`${file.parent?.path ?? ''}/${fm.painting}`)) : null;
		entries.push({
			file,
			title: text(fm.title) || file.basename,
			date: fm.date,
			time: text(fm.time),
			duration: text(fm.duration),
			summary: text(fm.summary),
			status: text(fm.status),
			photos: (Array.isArray(fm.photos) ? fm.photos.map(String) : [])
				.map((name) => app.vault.getAbstractFileByPath(normalizePath(`${file.parent?.path ?? ''}/${name}`)))
				.filter((photo): photo is TFile => photo instanceof TFile),
			painting: painting instanceof TFile ? painting : null,
		});
	}
	return entries.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

/** Hides the entry from the timeline, or shows it again; the note and its files are untouched. */
export async function setHidden(app: App, file: TFile, hidden: boolean): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (hidden) fm.hidden = true;
		else delete fm.hidden;
	});
}

/**
 * Moves the entry to the trash (Obsidian's or the system's, as set in Obsidian): its whole folder when the folder
 * is the entry's own (named for its day, holding only its files), otherwise (Loose pages) the note and the
 * recordings, photos, and painting it names.
 */
export async function deleteEntry(app: App, file: TFile, date: string): Promise<void> {
	const folder = file.parent;
	const otherEntry = (child: TAbstractFile) => {
		if (!(child instanceof TFile) || child === file || child.extension !== 'md') return false;
		const fm = app.metadataCache.getFileCache(child)?.frontmatter;
		return typeof fm?.date === 'string' && 'visibility' in fm;
	};
	if (folder && folder.name.startsWith(date) && folder.children.every((child) => child instanceof TFile && !otherEntry(child))) {
		return app.fileManager.trashFile(folder);
	}

	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const names = [fm.recordings, fm.photos, fm.painting].flat().filter((name): name is string => typeof name === 'string');
	for (const name of names) {
		const attached = app.vault.getAbstractFileByPath(normalizePath(`${folder?.path ?? ''}/${name}`));
		if (attached instanceof TFile) await app.fileManager.trashFile(attached);
	}
	await app.fileManager.trashFile(file);
}

function text(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
