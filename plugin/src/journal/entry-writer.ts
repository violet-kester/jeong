import { App, TFile, TFolder, moment, normalizePath, stringifyYaml } from 'obsidian';
import type { Segment } from '../transcribe/messages';
import { extensionFor } from '../storage/temp-file';
import { photoExtension } from '../ui/photo-tray';
import { parseEntryNote, serializeEntryNote } from './entry-note';
import { t } from '../i18n';

// Writes a finished recording into the journal as an entry folder:
//
//   <journal>/2026/10 October/2026-10-27 Title/
//     Title.md                 the entry: the story (the transcript until the story is written)
//     Title (transcript).md    word for word, with timestamps
//     Title (AI draft).md      what the AI wrote, untouched, added once the story is written
//     2026-10-27 0915 recording.webm    what was said
//     2026-10-27 0915 photo 1.jpg       photos, the first is the main one
//
// Folder and file names sort by date, read well in a file explorer, and are safe on
// Windows, macOS, and USB drives. Month names follow Obsidian's display language.

export interface EntryPhoto {
	name: string;
	type: string;
	data: Blob;
}

export interface NewEntry {
	recording: Blob;
	mimeType: string;
	durationMs: number;
	startedAt: Date;
	transcript: string;
	segments: Segment[];
	engine: string;
	language: string;
	/** Where it was recorded, if known (phone recordings bring their own); otherwise this computer's. */
	timezone?: string;
	/** Photos added to the entry, in order; the first is the main photo. Saved as the original files. */
	photos?: EntryPhoto[];
}

/** Saves the entry and returns its main note. */
export async function writeEntry(app: App, journalFolder: string, entry: NewEntry): Promise<TFile> {
	const when = moment(entry.startedAt);
	const title = titleFrom(entry.transcript) || when.format('LT');
	const day = when.format('YYYY-MM-DD');

	const monthFolder = normalizePath(`${journalFolder}/${when.format('YYYY')}/${when.format('MM MMMM')}`);
	await ensureFolder(app, monthFolder);
	// Add the time only when there's already an entry that day, so names stay short
	const month = app.vault.getAbstractFileByPath(monthFolder);
	const sameDay = month instanceof TFolder && month.children.some((child) => child.name.startsWith(day));
	const folderName = safeName(`${day}${sameDay ? ` ${when.format('HHmm')}` : ''} ${title}`);
	const folder = uniqueFolder(app, `${monthFolder}/${folderName}`);
	await ensureFolder(app, folder);

	// Names unique across the whole vault (date and time first), so links can never point at another entry's file
	const stamp = when.format('YYYY-MM-DD HHmm');
	const recordingName = `${stamp} recording.${extensionFor(entry.mimeType)}`;
	await app.vault.createBinary(`${folder}/${recordingName}`, await entry.recording.arrayBuffer());

	const photoNames = await savePhotos(app, folder, stamp, entry.photos ?? []);

	const duration = formatTime(entry.durationMs / 1000);
	const name = safeName(title);
	await app.vault.create(
		`${folder}/${name} (transcript).md`,
		frontmatter({ kind: 'transcript', entry: `[[${name}]]`, date: day, recording: recordingName, engine: entry.engine }) +
			`> [!quote] ${t('files.transcript')}\n> ${t('files.transcriptAbout')} [[${name}|${t('files.yourStory')}]].\n\n` +
			`${embed(folder, recordingName)}\n\n` +
			(entry.segments.length
				? entry.segments.map((s) => `**[${formatTime(s.start)}]** ${s.text}`).join('\n\n')
				: entry.transcript) +
			'\n',
	);

	const main = await app.vault.create(
		`${folder}/${name}.md`,
		frontmatter({
			title,
			date: day,
			time: when.format('HH:mm'),
			// Where the entry was recorded, so times stay right after travel or a move
			timezone: entry.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
			duration,
			summary: '',
			language: entry.language,
			visibility: 'private',
			source: 'recording',
			status: 'transcribed',
			recordings: [recordingName],
			...(photoNames.length ? { photos: photoNames } : {}),
			engine: entry.engine,
		}) +
			`${embed(folder, recordingName)}\n\n` +
			`${relatedLine(name, false)}\n\n` +
			`${entry.transcript}\n` +
			photoBlock(folder, photoNames),
	);
	return main;
}

/**
 * Adds another recording to an entry ("Record more"): the audio, its words in the transcript (with times
 * that carry on from the first recording), and any new photos. Write the story again afterwards.
 */
export async function addRecording(app: App, note: TFile, take: NewEntry): Promise<void> {
	const folder = note.parent;
	if (!folder) throw new Error('The entry has no folder');
	const fields: Record<string, unknown> = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
	const offset = parseTime(typeof fields.duration === 'string' ? fields.duration : '0:00');
	const stamp = moment(take.startedAt).format('YYYY-MM-DD HHmm');

	const recordingName = freeName(app, folder.path, `${stamp} recording`, extensionFor(take.mimeType));
	await app.vault.createBinary(`${folder.path}/${recordingName}`, await take.recording.arrayBuffer());

	// The transcript carries on, with this recording's player and times counted from where the last one ended
	const transcript = folder.children.find(
		(child): child is TFile => child instanceof TFile && app.metadataCache.getFileCache(child)?.frontmatter?.kind === 'transcript',
	);
	if (transcript) {
		const words = take.segments.length
			? take.segments.map((segment) => `**[${formatTime(offset + segment.start)}]** ${segment.text}`).join('\n\n')
			: take.transcript;
		await app.vault.process(transcript, (content) => `${content.trimEnd()}\n\n${embed(folder.path, recordingName)}\n\n${words}\n`);
	}

	// The entry: another player under the first
	await app.vault.process(note, (content) => {
		const parsed = parseEntryNote(content);
		return serializeEntryNote({ ...parsed, players: [...parsed.players, embed(folder.path, recordingName)] });
	});
	await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
		fm.recordings = [...listOf(fm.recordings), recordingName];
		fm.duration = formatTime(offset + take.durationMs / 1000);
	});
	await addPhotos(app, note, take.photos ?? [], take.startedAt);
}

/** Saves photos into a folder as "<stamp> photo N", numbered from `firstNumber`, and returns their file names. */
export async function savePhotos(app: App, folder: string, stamp: string, photos: EntryPhoto[], firstNumber = 1): Promise<string[]> {
	const names: string[] = [];
	for (const [i, photo] of photos.entries()) {
		const name = freeName(app, folder, `${stamp} photo ${firstNumber + i}`, photoExtension(photo));
		await app.vault.createBinary(`${folder}/${name}`, await photo.data.arrayBuffer());
		names.push(name);
	}
	return names;
}

/** Adds photos to a saved entry or loose page: the files beside it, shown under its text, and listed in its frontmatter. */
export async function addPhotos(app: App, note: TFile, photos: EntryPhoto[], when: Date = new Date()): Promise<void> {
	if (!photos.length) return;
	const folder = note.parent;
	if (!folder) throw new Error('The entry has no folder');
	const existing = listOf(app.metadataCache.getFileCache(note)?.frontmatter?.photos);
	const names = await savePhotos(app, folder.path, moment(when).format('YYYY-MM-DD HHmm'), photos, existing.length + 1);
	await app.vault.process(note, (content) => content.trimEnd() + '\n' + photoBlock(folder.path, names));
	await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
		fm.photos = [...listOf(fm.photos), ...names];
	});
}

/** Makes `names` the entry's photos, in that order, in its frontmatter and body; photos left out go to the trash. */
export async function setPhotos(app: App, note: TFile, names: string[]): Promise<void> {
	const folder = note.parent;
	if (!folder) throw new Error('The entry has no folder');
	let before: string[] = [];
	await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
		before = listOf(fm.photos);
		if (names.length) fm.photos = names;
		else delete fm.photos;
	});
	await app.vault.process(note, (content) => serializeEntryNote({ ...parseEntryNote(content), photos: names.map((name) => embed(folder.path, name)) }));
	for (const name of before.filter((photo) => !names.includes(photo))) {
		const file = app.vault.getAbstractFileByPath(normalizePath(`${folder.path}/${name}`));
		if (file instanceof TFile) await app.fileManager.trashFile(file);
	}
}

/** A frontmatter list as names (empty if it isn't a list). */
function listOf(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

/** A file name not yet used in the folder: "name.ext", or "name 2.ext", "name 3.ext"… */
export function freeName(app: App, folder: string, name: string, extension: string): string {
	let candidate = `${name}.${extension}`;
	for (let n = 2; app.vault.getAbstractFileByPath(normalizePath(`${folder}/${candidate}`)); n++) candidate = `${name} ${n}.${extension}`;
	return candidate;
}

/** "1:14" → 74 seconds; "1:02:05" → 3725. */
function parseTime(text: string): number {
	return text.split(':').reduce((total, part) => total * 60 + (Number(part) || 0), 0);
}

/**
 * An embed with the full path. Every entry has a "recording.webm" and a "photo 1.jpg", so a bare
 * ![[recording.webm]] could show another entry's file. Obsidian updates these paths on rename.
 */
export function embed(folder: string, file: string): string {
	return `![[${normalizePath(`${folder}/${file}`)}]]`;
}

/** The entry's photos, shown under the story. */
export function photoBlock(folder: string, photos: string[]): string {
	return photos.length ? `\n${photos.map((photo) => embed(folder, photo)).join('\n')}\n` : '';
}

/** The small line of links under the audio player: Transcript · AI draft. */
export function relatedLine(name: string, hasDraft: boolean): string {
	const links = [`[[${name} (transcript)|${t('files.transcript')}]]`];
	if (hasDraft) links.push(`[[${name} (AI draft)|${t('files.aiDraft')}]]`);
	return `*${links.join(' · ')}*`;
}

/** The first few words of what was said, as a short title. */
export function titleFrom(transcript: string): string {
	const firstSentence = /^[^.!?。？！]*/.exec(transcript.trim())?.[0] ?? '';
	const words = firstSentence.trim().split(/\s+/).filter(Boolean);
	return words.slice(0, 6).join(' ');
}

/** Removes characters that Windows, macOS, or USB drives (FAT32/exFAT) don't allow, and Obsidian link characters. */
export function safeName(name: string): string {
	return name
		.normalize('NFC')
		.replace(/[\\/:*?"<>|#^[\]]/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[. ]+$/, '')
		.trim()
		.slice(0, 80);
}

function frontmatter(fields: Record<string, unknown>): string {
	return `---\n${stringifyYaml(fields)}---\n\n`;
}

function formatTime(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = String(whole % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	let current = '';
	for (const part of normalizePath(path).split('/')) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (!existing) await app.vault.createFolder(current);
		else if (!(existing instanceof TFolder)) throw new Error(`${current} is a file, not a folder`);
	}
}

function uniqueFolder(app: App, path: string): string {
	let candidate = normalizePath(path);
	for (let n = 2; app.vault.getAbstractFileByPath(candidate); n++) candidate = normalizePath(`${path} (${n})`);
	return candidate;
}
