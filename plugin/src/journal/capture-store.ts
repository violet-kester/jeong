import { App, TFile, TFolder, moment, normalizePath, stringifyYaml } from 'obsidian';
import { extensionFor } from '../storage/temp-file';
import { photoExtension } from '../ui/photo-tray';
import { t } from '../i18n';
import { embed, formatTime, listOf, photoBlock, putBinary, type EntryPhoto } from './entry-writer';

// What a phone records, on its way to a computer. Each take is its own files in Loose pages:
//
//   <journal>/Loose pages/2026-11-08 1724 a3f9 01 recording.webm
//   <journal>/Loose pages/2026-11-08 1724 a3f9 01 photo 1.png
//   <journal>/Loose pages/2026-11-08 1724 a3f9 01.md      written last: this take is complete, and how big its files are
//
// Nothing here edits a file that has already been saved, so file sync has nothing to overwrite or merge.
// The computer reads what has arrived (readSessions); only reconcile.ts removes anything.

export const LOOSE_FOLDER = 'Loose pages';

export interface Capture {
	/** Missing when a take is only photos added after the recording was saved. */
	recording?: Blob;
	mimeType?: string;
	durationMs: number;
	startedAt: Date;
	language: string;
	photos?: EntryPhoto[];
}

export interface TakePiece {
	name: string;
	/** Null when an older page didn't record it. */
	size: number | null;
}

export interface Take {
	number: number;
	marker: TFile;
	recording: TakePiece | null;
	photos: TakePiece[];
	startedAt: Date;
	durationMs: number;
	language: string;
	timezone?: string;
}

export interface CaptureSession {
	id: string;
	takes: Take[];
	/** Set for a page saved by an older version, one note listing all its recordings. */
	oldPage: TFile | null;
}

export function looseFolder(journalFolder: string): string {
	return normalizePath(`${journalFolder}/${LOOSE_FOLDER}`);
}

export function newSessionId(startedAt: Date): string {
	return `${moment(startedAt).format('YYYY-MM-DD HHmm')} ${Math.random().toString(36).slice(2, 6)}`;
}

export function takeBase(session: string, take: number): string {
	return `${session} ${String(take).padStart(2, '0')}`;
}

/** Saves one take. Safe to repeat for the same take after a failure: the marker is only written once everything else is there. */
export async function saveTake(app: App, journalFolder: string, session: string, take: number, capture: Capture): Promise<TFile> {
	const folder = looseFolder(journalFolder);
	if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await app.vault.createFolder(folder);
	const base = takeBase(session, take);

	let recording: TakePiece | null = null;
	if (capture.recording) {
		const data = await capture.recording.arrayBuffer();
		recording = { name: `${base} recording.${extensionFor(capture.mimeType ?? '')}`, size: data.byteLength };
		await putBinary(app, `${folder}/${recording.name}`, data);
	}
	const photos: TakePiece[] = [];
	for (const [i, photo] of (capture.photos ?? []).entries()) {
		const data = await photo.data.arrayBuffer();
		const name = `${base} photo ${i + 1}.${photoExtension(photo)}`;
		await putBinary(app, `${folder}/${name}`, data);
		photos.push({ name, size: data.byteLength });
	}

	const markerPath = `${folder}/${base}.md`;
	const existing = app.vault.getAbstractFileByPath(markerPath);
	if (existing instanceof TFile) return existing;
	const when = moment(capture.startedAt);
	const seconds = capture.durationMs / 1000;
	const fields = {
		title: t('loose.title'),
		date: when.format('YYYY-MM-DD'),
		time: when.format('HH:mm'),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		duration: formatTime(seconds),
		summary: '',
		language: capture.language,
		visibility: 'private',
		source: 'recording',
		status: 'recorded',
		session,
		take,
		...(recording ? { recordings: [recording.name], recordingSize: recording.size } : {}),
		...(photos.length ? { photos: photos.map((photo) => photo.name), photoSizes: photos.map((photo) => photo.size) } : {}),
	};
	const player = recording ? `${embed(folder, recording.name)}\n\n` : '';
	const names = photos.map((photo) => photo.name);
	return app.vault.create(markerPath, `---\n${stringifyYaml(fields)}---\n\n${player}> [!info] ${t('loose.waiting')}\n${photoBlock(folder, names)}`);
}

/** Every session waiting in Loose pages, oldest first, from whatever has arrived so far. */
export function readSessions(app: App, journalFolder: string): CaptureSession[] {
	const folder = app.vault.getAbstractFileByPath(looseFolder(journalFolder));
	if (!(folder instanceof TFolder)) return [];
	const sessions = new Map<string, CaptureSession>();
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		const fm = app.metadataCache.getFileCache(child)?.frontmatter;
		if (!fm) continue;
		if (typeof fm.session === 'string' && fm.take !== undefined) {
			const session = sessions.get(fm.session) ?? { id: fm.session, takes: [], oldPage: null };
			sessions.set(fm.session, session);
			const recording = typeof fm.recordings === 'string' ? fm.recordings : listOf(fm.recordings)[0];
			const photos = listOf(fm.photos);
			const sizes = (Array.isArray(fm.photoSizes) ? fm.photoSizes : []).map(Number);
			session.takes.push({
				...takeBasics(fm),
				number: Number(fm.take),
				marker: child,
				recording: recording ? { name: recording, size: numberOrNull(fm.recordingSize) } : null,
				// Sizes only line up while the list is as the phone wrote it
				photos: photos.map((name, i) => ({ name, size: sizes.length === photos.length ? (sizes[i] ?? null) : null })),
			});
		} else if (fm.status === 'recorded') {
			const old = readOldPage(child, fm);
			sessions.set(old.id, old);
		}
	}
	for (const session of sessions.values()) session.takes.sort((a, b) => a.number - b.number);
	return [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** A page from an older version of Jeong, read as a session: one take for each recording it lists. */
function readOldPage(note: TFile, fm: Record<string, unknown>): CaptureSession {
	const recordings = typeof fm.recordings === 'string' ? [fm.recordings] : listOf(fm.recordings);
	const photos = listOf(fm.photos).map((name) => ({ name, size: null }));
	return {
		id: `old page ${note.basename}`,
		oldPage: note,
		takes: recordings.map((name, i) => ({
			...takeBasics(fm),
			number: i + 1,
			marker: note,
			recording: { name, size: null },
			photos: i === 0 ? photos : [],
		})),
	};
}

function takeBasics(fm: Record<string, unknown>): Pick<Take, 'startedAt' | 'durationMs' | 'language' | 'timezone'> {
	const text = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);
	return {
		startedAt: moment(`${text(fm.date, '')} ${text(fm.time, '12:00')}`, 'YYYY-MM-DD HH:mm').toDate(),
		durationMs: 0,
		language: text(fm.language, 'en'),
		timezone: typeof fm.timezone === 'string' ? fm.timezone : undefined,
	};
}

function numberOrNull(value: unknown): number | null {
	return value === undefined || value === null || value === '' ? null : Number(value);
}

/** The take's files that haven't fully arrived: missing, or not yet the size the phone wrote. */
export function missingPieces(app: App, journalFolder: string, take: Take): string[] {
	const folder = looseFolder(journalFolder);
	return [...(take.recording ? [take.recording] : []), ...take.photos]
		.filter(({ name, size }) => {
			const file = app.vault.getAbstractFileByPath(normalizePath(`${folder}/${name}`));
			return !(file instanceof TFile) || (size !== null && file.stat.size !== size);
		})
		.map(({ name }) => name);
}
