import { App, Notice, Platform, TFile, moment, normalizePath } from 'obsidian';
import { SpeechEngine } from '../transcribe/speech-engine';
import { transcribeRecording } from '../transcribe/final-transcriber';
import { writeEntry } from './entry-writer';
import { writeStory } from '../compose/write-story';
import type { Ollama } from '../compose/ollama';
import type { Metrics } from '../metrics/metrics';
import { storyMessage } from '../ui/story-messages';
import { t } from '../i18n';

// Writes up recordings waiting in Loose pages (for example, from a phone): transcribes them
// with Whisper, saves a full entry, writes the story, then moves the loose page to the trash.
// Runs on a computer only, one recording at a time, in the background.

const UNLOAD_AFTER_MS = 5 * 60_000; // free the graphics card when there's been nothing to do for a while

const MIME_TYPES: Record<string, string> = { webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg' };

export class LooseProcessor {
	private queue: TFile[] = [];
	private running = false;
	private whisper: SpeechEngine | null = null;
	private idleTimer = 0;

	constructor(
		private app: App,
		private journalFolder: () => string,
		private ollama: Ollama,
		private metrics: Metrics,
		private version: string,
	) {}

	get folder(): string {
		return normalizePath(`${this.journalFolder()}/Loose pages`);
	}

	/** Loose pages still waiting to be written up. */
	waiting(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.parent?.path === this.folder && this.app.metadataCache.getFileCache(file)?.frontmatter?.status === 'recorded');
	}

	/** Queue every waiting loose page. Returns how many were queued. */
	processAll(): number {
		const files = this.waiting().filter((file) => !this.queue.includes(file));
		files.forEach((file) => this.enqueue(file));
		return files.length;
	}

	enqueue(file: TFile): void {
		if (!Platform.isDesktopApp || this.queue.includes(file)) return;
		this.queue.push(file);
		void this.run();
	}

	dispose(): void {
		window.clearTimeout(this.idleTimer);
		this.whisper?.dispose();
		this.whisper = null;
	}

	private async run(): Promise<void> {
		if (this.running) return;
		this.running = true;
		window.clearTimeout(this.idleTimer);
		while (this.queue.length) {
			const note = this.queue.shift();
			if (note && this.app.vault.getAbstractFileByPath(note.path)) await this.process(note);
		}
		this.running = false;
		this.idleTimer = window.setTimeout(() => this.dispose(), UNLOAD_AFTER_MS);
	}

	private async process(note: TFile): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
		if (fm.status !== 'recorded') return;
		const recordingName = Array.isArray(fm.recordings) ? String(fm.recordings[0]) : '';
		const recordingFile = this.app.vault.getAbstractFileByPath(normalizePath(`${this.folder}/${recordingName}`));
		if (!(recordingFile instanceof TFile)) return;

		const startedAt = moment(`${String(fm.date)} ${String(fm.time ?? '12:00')}`, 'YYYY-MM-DD HH:mm').toDate();
		const notice = new Notice(`${t('loose.processing')} ${moment(startedAt).format('lll')}…`, 0);
		try {
			const extension = recordingFile.extension.toLowerCase();
			const mimeType = MIME_TYPES[extension] ?? 'audio/webm';
			const blob = new Blob([await this.app.vault.readBinary(recordingFile)], { type: mimeType });
			const photoFiles = (Array.isArray(fm.photos) ? fm.photos.map(String) : [])
				.map((name) => this.app.vault.getAbstractFileByPath(normalizePath(`${this.folder}/${name}`)))
				.filter((file): file is TFile => file instanceof TFile);
			const photos = await Promise.all(
				photoFiles.map(async (file) => ({ name: file.name, type: '', data: new Blob([await this.app.vault.readBinary(file)]) })),
			);

			this.whisper ??= new SpeechEngine('whisper-turbo', {
				onStage: () => notice.setMessage(t('loose.preparing')),
				onProgress: (percent) => notice.setMessage(`${t('check.downloading')} ${percent}%`),
				onReady: (device, loadMs, model, precision) =>
					this.metrics.log({ event: 'model_load', kind: 'final', model, device, precision, loadMs: Math.round(loadMs) }),
				onError: (message) => this.metrics.log({ event: 'error', where: 'loose-transcript', message }),
			});
			notice.setMessage(t('loose.transcribing'));
			const result = await transcribeRecording(this.whisper, blob);
			this.metrics.log({
				event: 'transcribe',
				kind: 'final',
				model: 'whisper-large-v3-turbo',
				audioMs: Math.round(result.audioMs),
				ms: Math.round(result.ms),
				speed: Math.round((result.audioMs / Math.max(1, result.ms)) * 100) / 100,
			});

			const entry = await writeEntry(this.app, this.journalFolder(), {
				recording: blob,
				mimeType,
				durationMs: result.audioMs,
				startedAt,
				transcript: result.text,
				segments: result.segments ?? [],
				engine: `jeong-plugin ${this.version} · whisper-large-v3-turbo`,
				language: typeof fm.language === 'string' ? fm.language : 'en',
				timezone: typeof fm.timezone === 'string' ? fm.timezone : undefined,
				photos,
			});
			// The entry now has its own copy of the recording; the loose page can go (to the trash, recoverable)
			await this.app.fileManager.trashFile(recordingFile);
			for (const file of photoFiles) await this.app.fileManager.trashFile(file);
			await this.app.fileManager.trashFile(note);

			await writeStory(this.app, this.ollama, this.metrics, entry, (progress) => notice.setMessage(storyMessage(progress)));
			notice.setMessage(t('loose.done'));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not write up a loose page', error);
			this.metrics.log({ event: 'error', where: 'process-loose', message });
			notice.setMessage(t('loose.failed'));
		} finally {
			window.setTimeout(() => notice.hide(), 8000);
		}
	}
}
