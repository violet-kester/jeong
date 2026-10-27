import { App, TFile, normalizePath } from 'obsidian';

// Finds the journal's entries using Obsidian's metadata cache, so nothing has to be read
// from disk. An entry is a note in the journal folder whose frontmatter has a date and a
// visibility (transcripts and other notes don't).

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
		if (!fm || typeof fm.date !== 'string' || !('visibility' in fm)) continue;
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

function text(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
