import { App, Notice, Platform, debounce, moment, type TFile } from 'obsidian';
import { SpeechEngine } from '../transcribe/speech-engine';
import { transcribeRecording } from '../transcribe/final-transcriber';
import { addToStory, writeStory } from '../compose/write-story';
import type { LanguageModel } from '../compose/language-model';
import type { Metrics } from '../metrics/metrics';
import { storyMessage } from '../ui/story-messages';
import { t } from '../i18n';
import { looseFolder, readSessions, type Take } from './capture-store';
import { reconcile, type SessionStatus, type Transcribed } from './reconcile';

// Runs reconcile on a computer: whenever something arrives in Loose pages, after a short quiet moment, and owns the speech model.

const UNLOAD_AFTER_MS = 5 * 60_000; // free the graphics card when there's been nothing to do for a while
const QUIET_MS = 3000; // sync delivers files in bursts
const NOTICE_MS = 8000;
const NOTICE_PROBLEM_MS = 60_000;

export class CaptureProcessor {
	statuses: SessionStatus[] = [];
	private running = false;
	private again = false;
	private disposed = false;
	private whisper: SpeechEngine | null = null;
	private idleTimer = 0;
	private notice: Notice | null = null;
	private noticeMs = NOTICE_MS;
	/** Runs once things settle: several arrivals close together are one run. */
	readonly schedule = debounce(() => void this.run(), QUIET_MS, true);

	constructor(
		private app: App,
		private journalFolder: () => string,
		private llm: LanguageModel,
		private metrics: Metrics,
		private version: string,
	) {}

	get folder(): string {
		return looseFolder(this.journalFolder());
	}

	statusOf(session: string): SessionStatus | undefined {
		return this.statuses.find((status) => status.session === session);
	}

	dispose(): void {
		this.disposed = true;
		window.clearTimeout(this.idleTimer);
		this.whisper?.dispose();
		this.whisper = null;
	}

	/** Writes up everything that can be, and reports where each recording stands. */
	async run(): Promise<SessionStatus[]> {
		if (!Platform.isDesktopApp || this.disposed) return this.statuses;
		if (this.running) {
			this.again = true;
			return this.statuses;
		}
		if (!readSessions(this.app, this.journalFolder()).length) {
			this.statuses = [];
			return this.statuses;
		}
		this.running = true;
		window.clearTimeout(this.idleTimer);
		try {
			do {
				this.again = false;
				this.statuses = await reconcile({
					app: this.app,
					journalFolder: this.journalFolder(),
					transcribe: (recording, take) => this.transcribe(recording, take),
					story: (note, newWords) => this.writeStoryFor(note, newWords),
					stopped: () => this.disposed,
					onError: (message) => {
						this.metrics.log({ event: 'error', where: 'process-loose', message });
						this.show(t('loose.failed'));
					},
				});
			} while (this.again && !this.disposed);
		} finally {
			this.running = false;
			if (this.notice) {
				const notice = this.notice;
				this.notice = null;
				window.setTimeout(() => notice.hide(), this.noticeMs);
				this.noticeMs = NOTICE_MS;
			}
			if (!this.disposed) this.idleTimer = window.setTimeout(() => this.unloadModel(), UNLOAD_AFTER_MS);
		}
		return this.statuses;
	}

	private unloadModel(): void {
		this.whisper?.dispose();
		this.whisper = null;
	}

	private show(message: string): void {
		if (this.notice) this.notice.setMessage(message);
		else this.notice = new Notice(message, 0);
	}

	private async transcribe(recording: Blob, take: Take): Promise<Transcribed> {
		this.show(`${t('loose.processing')} ${moment(take.startedAt).format('lll')}…`);
		this.whisper ??= new SpeechEngine('whisper-turbo', {
			onStage: () => this.show(t('loose.preparing')),
			onProgress: (percent) => this.show(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs, model, precision) => this.metrics.log({ event: 'model_load', kind: 'final', model, device, precision, loadMs: Math.round(loadMs) }),
			onError: (message) => this.metrics.log({ event: 'error', where: 'loose-transcript', message }),
		});
		this.show(t('loose.transcribing'));
		const result = await transcribeRecording(this.whisper, recording);
		this.metrics.log({
			event: 'transcribe',
			kind: 'final',
			model: 'whisper-large-v3-turbo',
			audioMs: Math.round(result.audioMs),
			ms: Math.round(result.ms),
			speed: Math.round((result.audioMs / Math.max(1, result.ms)) * 100) / 100,
		});
		return { text: result.text, segments: result.segments ?? [], audioMs: result.audioMs, engine: `jeong-plugin ${this.version} · whisper-large-v3-turbo` };
	}

	private async writeStoryFor(note: TFile, newWords: string | null): Promise<void> {
		const onProgress = (progress: Parameters<typeof storyMessage>[0]) => this.show(storyMessage(progress));
		const written = newWords === null ? await writeStory(this.app, this.llm, this.metrics, note, onProgress) : await addToStory(this.app, this.llm, this.metrics, note, newWords, onProgress);
		if (written) this.show(t('loose.done'));
		// No story: its message stays up, and long enough to read, saying what to do
		else this.noticeMs = NOTICE_PROBLEM_MS;
	}
}
