import { App, TAbstractFile, TFile, normalizePath } from 'obsidian';
import { formatTime, parseTime } from './entry-writer';

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
	/** Left off the timeline unless hidden entries are being shown. */
	hidden: boolean;
	/** The phone session it came from, if any. */
	session: string;
}

export function listEntries(app: App, journalFolder: string, options: { includeHidden?: boolean } = {}): EntryInfo[] {
	const prefix = `${normalizePath(journalFolder)}/`;
	const entries: EntryInfo[] = [];
	// A phone session saves one marker note per take: they share one card until the computer has made the entry
	const takes = new Map<string, { entry: EntryInfo; take: number; hidden: boolean }[]>();
	const written = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || typeof fm.date !== 'string' || !('visibility' in fm)) continue;
		const session = text(fm.session);
		const isTake = session !== '' && fm.take !== undefined;
		if (session && !isTake) written.add(session);
		if (!isTake && fm.hidden === true && !options.includeHidden) continue;
		const painting = typeof fm.painting === 'string' ? app.vault.getAbstractFileByPath(normalizePath(`${file.parent?.path ?? ''}/${fm.painting}`)) : null;
		const entry: EntryInfo = {
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
			hidden: fm.hidden === true,
			session,
		};
		if (isTake) takes.set(session, [...(takes.get(session) ?? []), { entry, take: Number(fm.take), hidden: fm.hidden === true }]);
		else entries.push(entry);
	}
	for (const [session, group] of takes) {
		if (written.has(session)) continue;
		const [first, ...rest] = group.sort((a, b) => a.take - b.take);
		if (!first || (first.hidden && !options.includeHidden)) continue;
		for (const { entry } of rest) first.entry.photos.push(...entry.photos);
		first.entry.duration = formatTime(group.reduce((total, { entry }) => total + parseTime(entry.duration), 0));
		entries.push(first.entry);
	}
	return entries.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

/** The entry a note belongs to: its own, or for one take of a waiting phone recording, the card all its takes share. */
export function findEntry(app: App, journalFolder: string, note: TFile): EntryInfo | undefined {
	const session = text(app.metadataCache.getFileCache(note)?.frontmatter?.session);
	return listEntries(app, journalFolder, { includeHidden: true }).find((entry) => entry.file === note || (session !== '' && entry.session === session));
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

	// A waiting phone recording is one card over several take notes: they all go
	const session = app.metadataCache.getFileCache(file)?.frontmatter?.session as unknown;
	const notes = (session && folder ? folder.children : [file]).filter(
		(child): child is TFile => child instanceof TFile && child.extension === 'md' && (child === file || app.metadataCache.getFileCache(child)?.frontmatter?.session === session),
	);
	for (const note of notes) {
		const fm = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
		const names = [fm.recordings, fm.photos, fm.painting].flat().filter((name): name is string => typeof name === 'string');
		for (const name of names) {
			const attached = app.vault.getAbstractFileByPath(normalizePath(`${folder?.path ?? ''}/${name}`));
			if (attached instanceof TFile) await app.fileManager.trashFile(attached);
		}
		await app.fileManager.trashFile(note);
	}
}

function text(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
