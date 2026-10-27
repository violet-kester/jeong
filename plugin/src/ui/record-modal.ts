import { App, Modal, Platform, moment } from 'obsidian';
import { t } from '../i18n';
import { Recorder, type Recording } from '../audio/recorder';
import { Waveform } from './waveform';
import { checkWebGpu } from '../diagnostics/webgpu';
import { deleteTemp, extensionFor, saveToTemp } from '../storage/temp-file';
import { writeEntry } from '../journal/entry-writer';
import { saveLoosePage } from '../journal/loose-pages';
import { writeStory } from '../compose/write-story';
import type { Ollama } from '../compose/ollama';
import { storyMessage } from './story-messages';
import { LiveTranscriber } from '../transcribe/live-transcriber';
import { transcribeRecording } from '../transcribe/final-transcriber';
import { SpeechEngine, type EngineEvents, type Transcript } from '../transcribe/speech-engine';
import type { Metrics } from '../metrics/metrics';
import { TEST_SCRIPT, wordErrorRate } from '../metrics/word-error-rate';
import type { LiveMode } from '../settings';

export interface RecordModalOptions {
	/** How the live transcript is written. */
	liveMode: LiveMode;
	/** Where entries are saved, inside the vault. */
	journalFolder: string;
	/** The local language model that writes stories and summaries. */
	ollama: Ollama;
	/** Show the test script and score both transcripts against it. */
	test?: boolean;
}

// The recording panel. For now (milestone M1) it's a test bench: record, watch the
// live waveform and live transcript, and see what this computer supports.
export class RecordModal extends Modal {
	private recorder = new Recorder();
	private waveform: Waveform | null = null;
	private transcriber: LiveTranscriber | null = null;
	private moonshine: SpeechEngine | null = null;
	private whisper: SpeechEngine | null = null;
	private timerFrame = 0;
	private startedAt = new Date();
	private live = { ms: 0, audioMs: 0, phrases: 0, text: [] as string[] };
	private models = { live: '', final: '' };

	private button!: HTMLButtonElement;
	private status!: HTMLElement;
	private timer!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private transcript!: HTMLElement;
	private partial!: HTMLElement;
	private details!: HTMLElement;
	private modelRow!: HTMLElement;
	private speedRow!: HTMLElement;
	private finalRow!: HTMLElement;
	private comparison!: HTMLElement;

	constructor(
		app: App,
		private metrics: Metrics,
		private options: RecordModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('jeong', 'jeong-record');
		this.setTitle(t(this.options.test ? 'test.title' : 'record.title'));
		const { contentEl } = this;

		if (this.options.test) {
			contentEl.createDiv({ cls: 'jeong-test-intro', text: t('test.intro') });
			contentEl.createDiv({ cls: 'jeong-test-script', text: TEST_SCRIPT });
		}
		this.timer = contentEl.createDiv({ cls: 'jeong-record-timer', text: '0:00' });
		this.canvas = contentEl.createEl('canvas', { cls: 'jeong-record-waveform' });
		this.transcript = contentEl.createDiv({ cls: 'jeong-transcript' });
		this.partial = this.transcript.createSpan({ cls: 'jeong-transcript-partial' });
		this.comparison = contentEl.createDiv({ cls: 'jeong-comparison' });
		this.status = contentEl.createDiv({ cls: 'jeong-record-status', text: t('record.ready') });
		this.button = contentEl.createEl('button', { cls: 'jeong-record-button mod-cta', text: t('record.start') });
		this.button.addEventListener('click', () => void this.toggle());

		this.details = contentEl.createDiv({ cls: 'jeong-record-details' });
		// Phones can't run the speech models: record only, and write it up on a computer later
		if (this.onPhone) {
			this.transcript.hide();
			this.status.setText(t('record.readyPhone'));
			return;
		}
		this.modelRow = this.addDetail(t('check.liveModel'), t('check.loading'));
		this.speedRow = this.addDetail(t('check.speed'), '—');
		this.finalRow = this.addDetail(t('check.finalModel'), t('check.loading'));
		void this.showSystemCheck();
		this.startTranscribers();
	}

	private get onPhone(): boolean {
		return Platform.isMobile;
	}

	onClose(): void {
		this.waveform?.stop();
		window.cancelAnimationFrame(this.timerFrame);
		this.recorder.release();
		this.moonshine?.dispose();
		this.whisper?.dispose();
		this.contentEl.empty();
	}

	// Load both models as soon as the panel opens, so they're ready by the time you talk.
	// Moonshine makes quick guesses; one shared Whisper writes each phrase and the final transcript.
	private startTranscribers(): void {
		this.moonshine = new SpeechEngine('moonshine-base', this.engineEvents('live', this.modelRow));
		this.whisper = new SpeechEngine('whisper-turbo', this.engineEvents('final', this.finalRow));
		const writer = this.options.liveMode === 'hybrid' ? this.whisper : this.moonshine;

		this.transcriber = new LiveTranscriber(
			{
				onPartial: (text) => this.partial.setText(text),
				onFinal: (text) => {
					if (text) {
						this.live.text.push(text);
						this.transcript.insertBefore(createSpan({ cls: 'jeong-transcript-final', text: `${text} ` }), this.partial);
					}
					this.live.phrases++;
					this.partial.setText('');
					this.transcript.scrollTop = this.transcript.scrollHeight;
				},
				onTiming: (ms, audioMs, final) => {
					// All the models' work counts, but only finished phrases count as speech heard
					this.live.ms += ms;
					if (final) this.live.audioMs += audioMs;
					const factor = this.live.audioMs / Math.max(1, this.live.ms);
					this.speedRow.setText(`${factor.toFixed(1)}× ${t('check.fasterThanSpeech')} · ${Math.round(ms)} ms ${t('check.lastPhrase')}`);
				},
			},
			this.moonshine,
			writer,
		);
	}

	private engineEvents(kind: 'live' | 'final', row: HTMLElement): EngineEvents {
		return {
			onStage: (stage) => row.setText(t(stage === 'loading' ? 'check.loading' : 'check.warming')),
			onProgress: (percent) => row.setText(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs, model, precision) => {
				this.models[kind] = model;
				row.setText(`${shortName(model)} · ${device} · ${t('check.readyIn')} ${(loadMs / 1000).toFixed(1)} s`);
				this.metrics.log({ event: 'model_load', kind, model, device, precision, loadMs: Math.round(loadMs) });
			},
			onError: (message) => {
				console.error(`Jeong ${kind} transcript:`, message);
				row.setText(`${t('check.error')}: ${message}`);
				this.metrics.log({ event: 'error', where: `${kind}-transcript`, message });
			},
		};
	}

	/** The name logged for the live transcript, e.g. "moonshine-base-ONNX + whisper-large-v3-turbo". */
	private get liveLabel(): string {
		const guesser = shortName(this.models.live);
		return this.options.liveMode === 'hybrid' ? `${guesser} + ${shortName(this.models.final)}` : guesser;
	}

	private async toggle(): Promise<void> {
		if (this.recorder.analyser) await this.stop();
		else await this.start();
	}

	private async start(): Promise<void> {
		try {
			await this.recorder.start();
		} catch {
			this.status.setText(t('record.noMicrophone'));
			this.metrics.log({ event: 'error', where: 'microphone', message: 'Could not start the microphone' });
			return;
		}
		if (!this.recorder.analyser || !this.recorder.stream) return;
		this.startedAt = new Date();
		this.waveform = new Waveform(this.canvas, this.recorder.analyser);
		this.waveform.start();
		await this.transcriber?.listen(this.recorder.stream);
		this.button.setText(t('record.stop'));
		this.status.setText(t('record.recording'));
		const tick = () => {
			const seconds = Math.floor(this.recorder.elapsedMs / 1000);
			this.timer.setText(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
			this.timerFrame = window.requestAnimationFrame(tick);
		};
		tick();
	}

	private async stop(): Promise<void> {
		this.waveform?.stop();
		window.cancelAnimationFrame(this.timerFrame);
		const liveDone = this.transcriber?.finish() ?? Promise.resolve();
		const recording = await this.recorder.stop();
		this.button.setText(t('record.start'));
		this.button.disabled = true;
		this.status.setText(t('record.saving'));
		this.addDetail(t('check.format'), recording.mimeType || t('check.unknown'));
		this.metrics.log({
			event: 'recording',
			durationMs: Math.round(recording.durationMs),
			bytes: recording.blob.size,
			kbps: Math.round((recording.blob.size * 8) / Math.max(1, recording.durationMs)),
			mimeType: recording.mimeType,
		});

		if (this.onPhone) {
			await this.saveLoose(recording);
			return;
		}

		// Keep a safe copy first, outside the vault, so nothing is lost if anything below fails
		const tempPath = await this.saveTemp(recording.blob, recording.mimeType);

		// Whisper finishes the live phrases first (same queue), then reads the whole recording
		this.comparison.setText(t('compare.reading'));
		let result: Transcript | null = null;
		try {
			if (this.whisper) result = await transcribeRecording(this.whisper, recording.blob);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.comparison.setText(`${t('check.error')}: ${message}`);
			this.metrics.log({ event: 'error', where: 'final-transcript', message });
		}
		await liveDone;
		this.logLive();
		this.button.disabled = false;
		if (!result) {
			this.status.setText(t('record.keptInTemp'));
			return;
		}
		this.showFinal(result.text, result.ms, result.audioMs);

		if (this.options.test) {
			this.status.setText(t('record.saved'));
			return;
		}
		await this.saveEntry(recording, result, tempPath);
	}

	private async saveEntry(recording: Recording, result: Transcript, tempPath: string | null): Promise<void> {
		this.status.setText(t('record.writing'));
		const started = performance.now();
		try {
			const note = await writeEntry(this.app, this.options.journalFolder, {
				recording: recording.blob,
				mimeType: recording.mimeType,
				durationMs: recording.durationMs,
				startedAt: this.startedAt,
				transcript: result.text,
				segments: result.segments ?? [],
				engine: `jeong-plugin ${this.metrics.version} · ${shortName(this.models.final)}`,
				language: this.language,
			});
			this.metrics.log({
				event: 'entry_saved',
				durationMs: Math.round(recording.durationMs),
				words: result.text.split(/\s+/).filter(Boolean).length,
				ms: Math.round(performance.now() - started),
			});
			if (tempPath) await deleteTemp(tempPath);
			this.status.setText(t('record.savedEntry'));
			const open = this.contentEl.createEl('button', { cls: 'jeong-record-button', text: t('record.openEntry') });
			this.status.after(open);
			open.addEventListener('click', () => {
				void this.app.workspace.getLeaf(false).openFile(note);
				this.close();
			});
			// Turn the transcript into a story, in the background; the entry is already safe
			await writeStory(this.app, this.options.ollama, this.metrics, note, (progress) => this.status.setText(storyMessage(progress)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not write the entry', error);
			this.status.setText(t('record.entryFailed'));
			this.metrics.log({ event: 'error', where: 'write-entry', message });
		}
	}

	/** On a phone: save the recording to Loose pages, to be written up on a computer later. */
	private async saveLoose(recording: Recording): Promise<void> {
		try {
			const note = await saveLoosePage(this.app, this.options.journalFolder, {
				recording: recording.blob,
				mimeType: recording.mimeType,
				durationMs: recording.durationMs,
				startedAt: this.startedAt,
				language: this.language,
			});
			this.status.setText(t('record.savedLoose'));
			this.button.disabled = false;
			const open = this.contentEl.createEl('button', { cls: 'jeong-record-button', text: t('record.openEntry') });
			this.status.after(open);
			open.addEventListener('click', () => {
				void this.app.workspace.getLeaf(false).openFile(note);
				this.close();
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not save the recording', error);
			this.status.setText(t('record.saveFailed'));
			this.button.disabled = false;
			this.metrics.log({ event: 'error', where: 'save-loose', message });
		}
	}

	/** Saves the recording to the temp folder and shows where. Returns the path, or null if that isn't possible. */
	private async saveTemp(blob: Blob, mimeType: string): Promise<string | null> {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		try {
			const path = await saveToTemp(blob, `recording-${stamp}.${extensionFor(mimeType)}`);
			this.addDetail(t('check.saved'), path ? `${path} (${Math.round(blob.size / 1024)} KB)` : t('check.savedLater'));
			return path;
		} catch (error) {
			console.error('Jeong: could not save the recording', error);
			this.metrics.log({ event: 'error', where: 'save', message: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	private logLive(): void {
		if (!this.live.audioMs) return;
		this.metrics.log({
			event: 'transcribe',
			kind: 'live',
			model: this.liveLabel,
			audioMs: Math.round(this.live.audioMs),
			ms: Math.round(this.live.ms),
			speed: round(this.live.audioMs / Math.max(1, this.live.ms)),
			phrases: this.live.phrases,
			skippedPartials: this.transcriber?.skippedPartials ?? 0,
		});
	}

	/** Best guess at the spoken language until the models detect it: Obsidian's display language. */
	private get language(): string {
		return moment.locale().split('-')[0] ?? 'en';
	}

	private showFinal(text: string, ms: number, audioMs: number): void {
		this.comparison.empty();
		this.comparison.createDiv({ cls: 'jeong-comparison-label', text: t('compare.whisper') });
		this.comparison.createDiv({ cls: 'jeong-comparison-text', text: text || '—' });
		this.comparison.createDiv({
			cls: 'jeong-comparison-label',
			text: `${(ms / 1000).toFixed(1)} s ${t('compare.toRead')} ${(audioMs / 1000).toFixed(0)} s · ${(audioMs / Math.max(1, ms)).toFixed(1)}× ${t('check.fasterThanSpeech')}`,
		});
		this.metrics.log({
			event: 'transcribe',
			kind: 'final',
			model: this.models.final,
			audioMs: Math.round(audioMs),
			ms: Math.round(ms),
			speed: round(audioMs / Math.max(1, ms)),
		});

		if (!this.options.test) return;
		const liveText = this.live.text.join(' ');
		const liveWer = wordErrorRate(TEST_SCRIPT, liveText);
		const finalWer = wordErrorRate(TEST_SCRIPT, text);
		const referenceWords = TEST_SCRIPT.split(/\s+/).length;
		this.metrics.log({ event: 'quality', kind: 'live', model: this.liveLabel, wer: round(liveWer), referenceWords });
		this.metrics.log({ event: 'quality', kind: 'final', model: this.models.final, wer: round(finalWer), referenceWords });
		this.comparison.createDiv({
			cls: 'jeong-comparison-score',
			text: `${t('test.wordsWrong')}: ${t('test.live')} ${percent(liveWer)} · ${t('test.final')} ${percent(finalWer)}`,
		});
	}

	private async showSystemCheck(): Promise<void> {
		const gpu = await checkWebGpu();
		this.addDetail(t('check.webgpu'), gpu.available ? gpu.adapter ?? t('check.yes') : t('check.no'));
	}

	/** Adds a label/value row to the details and returns the value element, so it can be updated. */
	private addDetail(label: string, value: string): HTMLElement {
		const row = this.details.createDiv({ cls: 'jeong-record-detail' });
		row.createSpan({ cls: 'jeong-record-detail-label', text: label });
		return row.createSpan({ text: value });
	}
}

/** "onnx-community/whisper-large-v3-turbo" → "whisper-large-v3-turbo" */
export function shortName(model: string): string {
	return model.split('/').pop() ?? model;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}
