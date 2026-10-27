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
}

export function listEntries(app: App, journalFolder: string): EntryInfo[] {
	const prefix = `${normalizePath(journalFolder)}/`;
	const entries: EntryInfo[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || typeof fm.date !== 'string' || !('visibility' in fm)) continue;
		entries.push({
			file,
			title: text(fm.title) || file.basename,
			date: fm.date,
			time: text(fm.time),
			duration: text(fm.duration),
			summary: text(fm.summary),
			status: text(fm.status),
		});
	}
	return entries.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

function text(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
