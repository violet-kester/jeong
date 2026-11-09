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
// Nothing the computer reads is edited once saved, so file sync has nothing to overwrite or merge. (The one edit is a
// player line added to the first take's body, by the phone that wrote it, so the waiting note plays every take.)
// The computer reads what has arrived (readSessions); only reconcile.ts removes anything.
//
// While a take is being recorded its audio goes into <journal>/.jeong/recording/<session> <nn>/ as numbered parts:
// outside the vault's notes, so nothing shows it or writes it up. A killed app leaves them there, and
// recoverDrafts turns them into a saved take the next time Jeong opens on that phone. Photos waiting to go with the
// take are copied beside its audio, so they come back with it.

export const LOOSE_FOLDER = 'Loose pages';

export interface Capture {
	/** Missing when a take is only photos added after the recording was saved. */
	recording?: Blob;
	mimeType?: string;
	durationMs: number;
	startedAt: Date;
	language: string;
	photos?: EntryPhoto[];
	/** The parts on disk behind this recording, removed once its marker is written. */
	draft?: TakeDraft;
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
		title: waitingTitle(when),
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
	const marker = await app.vault.create(markerPath, `---\n${stringifyYaml(fields)}---\n\n${player}> [!info] ${t('loose.waiting')}\n${photoBlock(folder, names)}`);
	if (recording && take > 1) await addPlayerToFirstTake(app, folder, session, recording.name);
	return marker;
}

/** What a recording is called until the computer names it from its words: "Sunday evening recording". */
function waitingTitle(when: moment.Moment): string {
	const hour = when.hour();
	const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
	return `${when.format('dddd')} ${t(`loose.title.${part}`)}`;
}

/** So the waiting note plays every take. Only the note's body, which nothing reads; the take is saved whether or not this works. */
async function addPlayerToFirstTake(app: App, folder: string, session: string, recording: string): Promise<void> {
	const first = app.vault.getAbstractFileByPath(normalizePath(`${folder}/${takeBase(session, 1)}.md`));
	if (!(first instanceof TFile)) return;
	const player = embed(folder, recording);
	try {
		await app.vault.process(first, (content) => {
			if (content.includes(player)) return content;
			const lines = content.split('\n');
			const last = lines.reduce((found, line, i) => (line.startsWith('![[') && line.includes(' recording.') ? i : found), -1);
			lines.splice(last + 1, 0, player);
			return lines.join('\n');
		});
	} catch (error) {
		console.error('Jeong: could not show the new recording on its page', error);
	}
}

/** What's needed to finish a take that was cut off. */
interface DraftInfo {
	session: string;
	take: number;
	startedAt: string;
	mimeType: string;
	language: string;
}

/** The drafts being recorded right now, which recovery must leave alone. */
const activeDrafts = new Set<string>();

function draftsFolder(journalFolder: string): string {
	return normalizePath(`${journalFolder}/.jeong/recording`);
}

async function ensureAdapterFolder(app: App, path: string): Promise<void> {
	let current = '';
	for (const part of path.split('/')) {
		current = current ? `${current}/${part}` : part;
		if (!(await app.vault.adapter.exists(current))) await app.vault.adapter.mkdir(current);
	}
}

async function readParts(app: App, directory: string, mimeType: string): Promise<{ blob: Blob; chunks: number } | null> {
	const { files } = await app.vault.adapter.list(directory);
	const parts = files.filter((file) => file.endsWith('.part')).sort();
	if (!parts.length) return null;
	const buffers: ArrayBuffer[] = [];
	for (const part of parts) buffers.push(await app.vault.adapter.readBinary(part));
	const chunks = parts.reduce((total, part) => total + (Number(/-(\d+)\.part$/.exec(part)?.[1]) || 0), 0);
	return { blob: new Blob(buffers, { type: mimeType }), chunks };
}

/** The photos kept with a draft, in the order the tray had them. One the list missed (cut off just after writing it) still counts. */
async function readDraftPhotos(app: App, directory: string): Promise<EntryPhoto[]> {
	const { files } = await app.vault.adapter.list(directory);
	const onDisk = files.map((file) => file.slice(file.lastIndexOf('/') + 1)).filter((name) => /^photo-\d+\.[^.]+$/.test(name)).sort();
	let listed: unknown = [];
	try {
		listed = JSON.parse(await app.vault.adapter.read(`${directory}/photos.json`));
	} catch {
		// No list, or one cut off mid-write: the photos themselves are what matter
	}
	const order = (Array.isArray(listed) ? listed : []).filter((name): name is string => onDisk.includes(name as string));
	const photos: EntryPhoto[] = [];
	for (const name of [...order, ...onDisk.filter((file) => !order.includes(file))]) {
		photos.push({ name, type: '', data: new Blob([await app.vault.adapter.readBinary(`${directory}/${name}`)]) });
	}
	return photos;
}

/** A take's audio on disk while it's being recorded. Numbered files rather than one growing file, because a plain write is all that's needed of the phone. */
export class TakeDraft {
	private part = 0;
	private photoNumber = 0;
	private keptPhotos = new Map<Blob, string>();
	private photoWrites: Promise<void> = Promise.resolve();

	private constructor(
		private app: App,
		private directory: string,
		private info: DraftInfo,
	) {}

	static async open(app: App, journalFolder: string, info: DraftInfo): Promise<TakeDraft> {
		const directory = normalizePath(`${draftsFolder(journalFolder)}/${takeBase(info.session, info.take)}`);
		await ensureAdapterFolder(app, directory);
		await app.vault.adapter.write(`${directory}/draft.json`, JSON.stringify(info));
		activeDrafts.add(directory);
		return new TakeDraft(app, directory, info);
	}

	async writePart(data: Blob, chunks: number): Promise<void> {
		const number = String(this.part + 1).padStart(6, '0');
		await this.app.vault.adapter.writeBinary(`${this.directory}/${number}-${chunks}.part`, await data.arrayBuffer());
		this.part++;
	}

	/** Makes the photos on disk match these, in this order. Never fails: a photo that can't be copied mustn't stop the recording. */
	keepPhotos(photos: EntryPhoto[]): Promise<void> {
		this.photoWrites = this.photoWrites.then(() => this.writePhotos(photos)).catch((error: unknown) => console.error('Jeong: could not keep a photo with the recording', error));
		return this.photoWrites;
	}

	private async writePhotos(photos: EntryPhoto[]): Promise<void> {
		const adapter = this.app.vault.adapter;
		const wanted = new Set(photos.map((photo) => photo.data));
		for (const [data, name] of this.keptPhotos) {
			if (wanted.has(data)) continue;
			await adapter.remove(`${this.directory}/${name}`);
			this.keptPhotos.delete(data);
		}
		for (const photo of photos) {
			if (this.keptPhotos.has(photo.data)) continue;
			const name = `photo-${String(++this.photoNumber).padStart(3, '0')}.${photoExtension(photo)}`;
			// Renamed into place, so a kill mid-write can't leave half a picture to be recovered
			await adapter.writeBinary(`${this.directory}/${name}.tmp`, await photo.data.arrayBuffer());
			await adapter.rename(`${this.directory}/${name}.tmp`, `${this.directory}/${name}`);
			this.keptPhotos.set(photo.data, name);
		}
		await adapter.write(`${this.directory}/photos.json`, JSON.stringify(photos.map((photo) => this.keptPhotos.get(photo.data))));
	}

	async assemble(): Promise<Blob> {
		return (await readParts(this.app, this.directory, this.info.mimeType))?.blob ?? new Blob([], { type: this.info.mimeType });
	}

	/** This window is done with it; if it's still here, the next recovery may finish it. */
	release(): void {
		activeDrafts.delete(this.directory);
	}

	async remove(): Promise<void> {
		this.release();
		await this.photoWrites;
		await this.app.vault.adapter.rmdir(this.directory, true);
	}
}

let recovering: Promise<number> = Promise.resolve(0);

/**
 * Finishes takes that were cut off, by giving them the marker they never got. Runs on the phone that recorded them.
 * Returns how many were saved. A draft that can't be finished stays for next time.
 */
export function recoverDrafts(app: App, journalFolder: string): Promise<number> {
	recovering = recovering.then(() => recoverAll(app, journalFolder), () => recoverAll(app, journalFolder));
	return recovering;
}

async function recoverAll(app: App, journalFolder: string): Promise<number> {
	const root = draftsFolder(journalFolder);
	if (!(await app.vault.adapter.exists(root))) return 0;
	let saved = 0;
	for (const directory of (await app.vault.adapter.list(root)).folders) {
		if (activeDrafts.has(directory)) continue;
		try {
			if (await recoverDraft(app, journalFolder, directory)) saved++;
		} catch (error) {
			console.error('Jeong: could not recover a recording', error);
		}
	}
	return saved;
}

async function recoverDraft(app: App, journalFolder: string, directory: string): Promise<boolean> {
	const info = JSON.parse(await app.vault.adapter.read(`${directory}/draft.json`)) as DraftInfo;
	const marker = normalizePath(`${looseFolder(journalFolder)}/${takeBase(info.session, info.take)}.md`);
	if (app.vault.getAbstractFileByPath(marker)) {
		// Killed between the marker and the tidying up
		await app.vault.adapter.rmdir(directory, true);
		return false;
	}
	const parts = await readParts(app, directory, info.mimeType);
	// A first take with no audio never happened; a later one still needs its number, so the takes after it aren't held up
	if (parts || info.take > 1) {
		await saveTake(app, journalFolder, info.session, info.take, {
			...(parts ? { recording: parts.blob, mimeType: info.mimeType } : {}),
			durationMs: (parts?.chunks ?? 0) * 1000,
			startedAt: new Date(info.startedAt),
			language: info.language,
			photos: await readDraftPhotos(app, directory),
		});
	}
	await app.vault.adapter.rmdir(directory, true);
	return parts !== null;
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
