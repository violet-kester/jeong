import { App, TFile, TFolder, moment, normalizePath } from 'obsidian';
import { addPhotos, addRecording, markTake, writeEntry, type EntryPhoto, type NewEntry } from './entry-writer';
import { looseFolder, missingPieces, readSessions, takeBase, type CaptureSession, type Take } from './capture-store';
import type { Segment } from '../transcribe/messages';

// Turns what has arrived in Loose pages into entries. It looks at the folder and does whatever is still missing, so it can
// run any number of times: an entry names its session and lists the takes it holds, and a source file is only removed
// here, once the entry lists its take. A take can't count until all its files are present at the size the phone wrote.

export interface Transcribed {
	text: string;
	segments: Segment[];
	audioMs: number;
	engine: string;
}

export interface ReconcileDeps {
	app: App;
	journalFolder: string;
	transcribe: (recording: Blob, take: Take) => Promise<Transcribed>;
	/** Writes the story: from scratch for a new entry (`newWords` null), otherwise adding those words. */
	story: (note: TFile, newWords: string | null) => Promise<void>;
	stopped?: () => boolean;
	onError?: (message: string) => void;
}

export interface SessionStatus {
	session: string;
	state: 'done' | 'waiting' | 'failed';
	detail: string;
}

export async function reconcile(deps: ReconcileDeps): Promise<SessionStatus[]> {
	const statuses: SessionStatus[] = [];
	for (const session of readSessions(deps.app, deps.journalFolder)) {
		if (deps.stopped?.()) break;
		try {
			statuses.push(await reconcileSession(deps, session));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not write up a recording', error);
			deps.onError?.(detail);
			statuses.push({ session: session.id, state: 'failed', detail });
		}
	}
	return statuses;
}

async function reconcileSession(deps: ReconcileDeps, session: CaptureSession): Promise<SessionStatus> {
	const { app } = deps;
	const first = session.takes[0];
	if (!first) return { session: session.id, state: 'waiting', detail: 'no recordings listed' };

	const found = await findEntry(app, deps.journalFolder, session.id, first.startedAt);
	// A folder with the session's transcript but no entry note is a write that was cut short: start it again
	if (found.partial) await app.fileManager.trashFile(found.partial);
	let note = found.note;
	const done = new Set(note ? takesIn(await app.vault.read(note)) : []);

	for (const take of session.takes) if (done.has(take.number)) await removeTake(deps, session, take);

	let expected = (done.size ? Math.max(...done) : 0) + 1;
	let created = false;
	const newWords: string[] = [];
	let waiting = '';
	for (const take of session.takes) {
		if (done.has(take.number)) continue;
		if (take.number !== expected) {
			waiting = `take ${expected} hasn't arrived`;
			break;
		}
		const missing = missingPieces(app, deps.journalFolder, take);
		if (missing.length) {
			waiting = `waiting for ${missing.join(', ')}`;
			break;
		}
		const built = await buildTake(deps, session, take);
		if (built.recording) {
			if (note) await addRecording(app, note, built.entry);
			else {
				note = await writeEntry(app, deps.journalFolder, built.entry);
				created = true;
			}
			newWords.push(built.entry.transcript);
		} else if (note) {
			await addPhotos(app, note, built.entry.photos ?? [], take.startedAt);
			await markTake(app, note, take.number);
		} else {
			waiting = 'photos arrived before their recording';
			break;
		}
		done.add(take.number);
		await removeTake(deps, session, take);
		expected++;
	}

	if (session.oldPage && !waiting) await finishOldPage(deps, session, done);
	if (note && (created || newWords.length)) {
		try {
			await deps.story(note, created ? null : newWords.join('\n\n'));
		} catch (error) {
			// The entry is whole without its story, which can be written from the entry
			deps.onError?.(error instanceof Error ? error.message : String(error));
		}
	}
	return waiting ? { session: session.id, state: 'waiting', detail: waiting } : { session: session.id, state: 'done', detail: '' };
}

async function buildTake(deps: ReconcileDeps, session: CaptureSession, take: Take): Promise<{ recording: boolean; entry: NewEntry }> {
	const { app, journalFolder } = deps;
	const folder = looseFolder(journalFolder);
	const stamp = moment(take.startedAt).format('YYYY-MM-DD HHmm');
	const fileFor = (name: string) => app.vault.getAbstractFileByPath(normalizePath(`${folder}/${name}`));

	const photos: EntryPhoto[] = [];
	for (const [i, piece] of take.photos.entries()) {
		const file = fileFor(piece.name);
		if (!(file instanceof TFile)) throw new Error(`${piece.name} has gone missing`);
		photos.push({
			name: file.name,
			type: '',
			data: new Blob([await app.vault.readBinary(file)]),
			fileName: `${stamp}${take.number > 1 ? ` take ${take.number}` : ''} photo ${i + 1}.${file.extension}`,
		});
	}

	const common = { startedAt: take.startedAt, language: take.language, timezone: take.timezone, photos, session: session.id, takeNumber: take.number };
	const audio = take.recording ? fileFor(take.recording.name) : null;
	if (!(audio instanceof TFile)) {
		return { recording: false, entry: { ...common, recording: new Blob(), mimeType: '', durationMs: 0, transcript: '', segments: [], engine: '' } };
	}
	const mimeType = MIME_TYPES[audio.extension.toLowerCase()] ?? 'audio/webm';
	const recording = new Blob([await app.vault.readBinary(audio)], { type: mimeType });
	const words = await transcribeOnce(deps, session, take, recording);
	return {
		recording: true,
		entry: {
			...common,
			recording,
			mimeType,
			durationMs: words.audioMs,
			transcript: words.text,
			segments: words.segments,
			engine: words.engine,
			fileName: `${stamp}${take.number > 1 ? ` take ${take.number}` : ''} recording.${audio.extension}`,
		},
	};
}

const MIME_TYPES: Record<string, string> = { webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg' };

/** The take's words, kept beside it once heard, so trying again never transcribes finished work twice. */
async function transcribeOnce(deps: ReconcileDeps, session: CaptureSession, take: Take, recording: Blob): Promise<Transcribed> {
	const { app } = deps;
	const path = cachePath(deps.journalFolder, session, take);
	const cached = app.vault.getAbstractFileByPath(path);
	if (cached instanceof TFile) {
		try {
			return JSON.parse(await app.vault.read(cached)) as Transcribed;
		} catch {
			await app.fileManager.trashFile(cached);
		}
	}
	const words = await deps.transcribe(recording, take);
	await app.vault.create(path, JSON.stringify(words));
	return words;
}

function cachePath(journalFolder: string, session: CaptureSession, take: Take): string {
	const base = session.oldPage ? `${session.oldPage.basename} ${String(take.number).padStart(2, '0')}` : takeBase(session.id, take.number);
	return normalizePath(`${looseFolder(journalFolder)}/${base} words.json`);
}

/** Removes a take's source files. Only ever called once the entry lists the take; the marker goes last, so a failure can be finished later. */
async function removeTake(deps: ReconcileDeps, session: CaptureSession, take: Take): Promise<void> {
	const { app, journalFolder } = deps;
	const folder = looseFolder(journalFolder);
	const names = session.oldPage ? (take.recording ? [take.recording.name] : []) : [...(take.recording ? [take.recording.name] : []), ...take.photos.map((photo) => photo.name)];
	const paths = [...names.map((name) => normalizePath(`${folder}/${name}`)), cachePath(journalFolder, session, take)];
	for (const path of paths) {
		const file = app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await app.fileManager.trashFile(file);
	}
	if (!session.oldPage) await app.fileManager.trashFile(take.marker);
}

/** An older page goes last, and only if it lists nothing beyond what the entry now holds. */
async function finishOldPage(deps: ReconcileDeps, session: CaptureSession, done: Set<number>): Promise<void> {
	const { app, journalFolder } = deps;
	const page = session.oldPage;
	if (!page) return;
	const listed = listedRecordings(await app.vault.read(page));
	if (listed.length && !listed.every((_, i) => done.has(i + 1))) return;
	for (const { name } of session.takes[0]?.photos ?? []) {
		const file = app.vault.getAbstractFileByPath(normalizePath(`${looseFolder(journalFolder)}/${name}`));
		if (file instanceof TFile) await app.fileManager.trashFile(file);
	}
	await app.fileManager.trashFile(page);
}

function listedRecordings(content: string): string[] {
	const block = /^recordings:\s*\n((?:\s+-\s.*\n?)*)/m.exec(content)?.[1];
	return block ? block.split('\n').filter((line) => line.trim().startsWith('-')) : [];
}

/** The take numbers an entry lists, read from the note itself so a just-written entry is seen before the cache catches up. */
export function takesIn(content: string): number[] {
	const inline = /^takes:\s*\[(.*)\]\s*$/m.exec(content)?.[1];
	if (inline !== undefined) return inline.split(',').map(Number).filter(Number.isFinite).filter((n) => inline.trim() !== '' && n > 0);
	const block = /^takes:\s*\n((?:\s+-\s.*\n?)*)/m.exec(content)?.[1] ?? '';
	return block
		.split('\n')
		.map((line) => Number(line.replace(/^\s*-\s*/, '')))
		.filter((n) => n > 0);
}

interface FoundEntry {
	note: TFile | null;
	partial: TFolder | null;
}

/**
 * Finds the entry made from a session. The session's month is read from disk first, since an entry written a moment ago
 * may not be in Obsidian's cache; the cache covers an entry that has since been moved.
 */
async function findEntry(app: App, journalFolder: string, session: string, startedAt: Date): Promise<FoundEntry> {
	const when = moment(startedAt);
	const month = app.vault.getAbstractFileByPath(normalizePath(`${journalFolder}/${when.format('YYYY')}/${when.format('MM MMMM')}`));
	const belongs = new RegExp(`^session:\\s*["']?${session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm');
	if (month instanceof TFolder) {
		for (const folder of month.children) {
			if (!(folder instanceof TFolder) || !folder.name.startsWith(when.format('YYYY-MM-DD'))) continue;
			const notes = folder.children.filter((child): child is TFile => child instanceof TFile && child.extension === 'md');
			const transcript = notes.find((file) => file.name.endsWith(' (transcript).md'));
			if (!transcript || !belongs.test(await app.vault.read(transcript))) continue;
			const note = notes.find((file) => file !== transcript && !file.name.endsWith(' (AI draft).md')) ?? null;
			return note ? { note, partial: null } : { note: null, partial: folder };
		}
	}
	const moved = app.vault.getMarkdownFiles().find((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		return fm?.session === session && fm.take === undefined && fm.kind !== 'transcript';
	});
	return { note: moved ?? null, partial: null };
}

