import { App, TFile, TFolder, moment, normalizePath, stringifyYaml } from 'obsidian';
import { extensionFor } from '../storage/temp-file';
import { t } from '../i18n';
import { photoExtension } from '../ui/photo-tray';
import { embed, photoBlock } from './entry-writer';

// Quick captures that haven't become entries yet, for example recordings made on a phone,
// which can't run the transcription and story models. They're saved as:
//
//   <journal>/Loose pages/2026-10-27 0915 recording.m4a
//   <journal>/Loose pages/2026-10-27 0915.md   (date, time, length, status: recorded)
//
// The note puts the recording on the timeline right away; a computer writes it up later.

export interface LooseRecording {
	recording: Blob;
	mimeType: string;
	durationMs: number;
	startedAt: Date;
	language: string;
	photos?: { name: string; type: string; data: Blob }[];
}

export async function saveLoosePage(app: App, journalFolder: string, capture: LooseRecording): Promise<TFile> {
	const when = moment(capture.startedAt);
	const folder = normalizePath(`${journalFolder}/Loose pages`);
	if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await app.vault.createFolder(folder);

	const stamp = when.format('YYYY-MM-DD HHmm');
	let base = stamp;
	for (let n = 2; app.vault.getAbstractFileByPath(`${folder}/${base}.md`); n++) base = `${stamp} (${n})`;

	const recordingName = `${base} recording.${extensionFor(capture.mimeType)}`;
	await app.vault.createBinary(`${folder}/${recordingName}`, await capture.recording.arrayBuffer());

	const photoNames: string[] = [];
	for (const [i, photo] of (capture.photos ?? []).entries()) {
		const photoName = `${base} photo ${i + 1}.${photoExtension(photo)}`;
		await app.vault.createBinary(`${folder}/${photoName}`, await photo.data.arrayBuffer());
		photoNames.push(photoName);
	}

	const seconds = Math.floor(capture.durationMs / 1000);
	const fields = {
		title: t('loose.title'),
		date: when.format('YYYY-MM-DD'),
		time: when.format('HH:mm'),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		duration: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
		summary: '',
		language: capture.language,
		visibility: 'private',
		source: 'recording',
		status: 'recorded',
		recordings: [recordingName],
		...(photoNames.length ? { photos: photoNames } : {}),
	};
	return app.vault.create(
		`${folder}/${base}.md`,
		`---\n${stringifyYaml(fields)}---\n\n${embed(folder, recordingName)}\n\n> [!info] ${t('loose.waiting')}\n${photoBlock(folder, photoNames)}`,
	);
}
