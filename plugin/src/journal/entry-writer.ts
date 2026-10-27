import { App, TFile, TFolder, moment, normalizePath, stringifyYaml } from 'obsidian';
import type { Segment } from '../transcribe/messages';
import { extensionFor } from '../storage/temp-file';
import { photoExtension } from '../ui/photo-tray';
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
	photos?: { name: string; type: string; data: Blob }[];
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

	const photoNames: string[] = [];
	for (const [i, photo] of (entry.photos ?? []).entries()) {
		const photoName = `${stamp} photo ${i + 1}.${photoExtension(photo)}`;
		await app.vault.createBinary(`${folder}/${photoName}`, await photo.data.arrayBuffer());
		photoNames.push(photoName);
	}

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
