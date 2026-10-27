import { App, Modal } from 'obsidian';
import { t } from '../i18n';
import { Recorder } from '../audio/recorder';
import { Waveform } from './waveform';
import { checkWebGpu } from '../diagnostics/webgpu';
import { extensionFor, saveToTemp } from '../storage/temp-file';
import { LiveTranscriber } from '../transcribe/live-transcriber';
import { FinalTranscriber } from '../transcribe/final-transcriber';
import type { Metrics } from '../metrics/metrics';
import { TEST_SCRIPT, wordErrorRate } from '../metrics/word-error-rate';
import type { SpeechModel } from '../transcribe/messages';

export interface RecordModalOptions {
	/** Which model writes the live preview. */
	liveModel: SpeechModel;
	/** Show the test script and score both transcripts against it. */
	test?: boolean;
}

// The recording panel. For now (milestone M1) it's a test bench: record, watch the
// live waveform and live transcript, and see what this computer supports.
export class RecordModal extends Modal {
	private recorder = new Recorder();
	private waveform: Waveform | null = null;
	private transcriber: LiveTranscriber | null = null;
	private finalTranscriber: FinalTranscriber | null = null;
	private timerFrame = 0;
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
		this.modelRow = this.addDetail(t('check.liveModel'), t('check.loading'));
		this.speedRow = this.addDetail(t('check.speed'), '—');
		this.finalRow = this.addDetail(t('check.finalModel'), t('check.loading'));
		void this.showSystemCheck();
		this.startTranscribers();
	}

	onClose(): void {
		this.waveform?.stop();
		window.cancelAnimationFrame(this.timerFrame);
		this.recorder.release();
		this.transcriber?.dispose();
		this.finalTranscriber?.dispose();
		this.contentEl.empty();
	}

	// Load both models as soon as the panel opens, so they're ready by the time you talk
	private startTranscribers(): void {
		this.transcriber = new LiveTranscriber({
			onStage: (stage) => this.modelRow.setText(t(stage === 'loading' ? 'check.loading' : 'check.warming')),
			onProgress: (percent) => this.modelRow.setText(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs, model, precision) => {
				this.models.live = model;
				this.modelRow.setText(`${shortName(model)} · ${device} · ${t('check.readyIn')} ${(loadMs / 1000).toFixed(1)} s`);
				this.metrics.log({ event: 'model_load', kind: 'live', model, device, precision, loadMs: Math.round(loadMs) });
			},
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
				// All the model's work counts, but only finished phrases count as speech heard
				this.live.ms += ms;
				if (final) this.live.audioMs += audioMs;
				const factor = this.live.audioMs / Math.max(1, this.live.ms);
				this.speedRow.setText(`${factor.toFixed(1)}× ${t('check.fasterThanSpeech')} · ${Math.round(ms)} ms ${t('check.lastPhrase')}`);
			},
			onError: (message) => {
				console.error('Jeong live transcript:', message);
				this.modelRow.setText(`${t('check.error')}: ${message}`);
				this.metrics.log({ event: 'error', where: 'live-transcript', message });
			},
		}, this.options.liveModel);

		this.finalTranscriber = new FinalTranscriber({
			onStage: (stage) => this.finalRow.setText(t(stage === 'loading' ? 'check.loading' : 'check.warming')),
			onProgress: (percent) => this.finalRow.setText(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs, model, precision) => {
				this.models.final = model;
				this.finalRow.setText(`${shortName(model)} · ${device} · ${t('check.readyIn')} ${(loadMs / 1000).toFixed(1)} s`);
				this.metrics.log({ event: 'model_load', kind: 'final', model, device, precision, loadMs: Math.round(loadMs) });
			},
			onResult: (text, ms, audioMs) => this.showFinal(text, ms, audioMs),
			onError: (message) => {
				console.error('Jeong final transcript:', message);
				this.finalRow.setText(`${t('check.error')}: ${message}`);
				this.metrics.log({ event: 'error', where: 'final-transcript', message });
			},
		});
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
		this.transcriber?.finish();
		const recording = await this.recorder.stop();
		this.button.setText(t('record.start'));
		this.status.setText(t('record.saving'));
		this.comparison.setText(t('compare.reading'));
		void this.finalTranscriber?.transcribe(recording.blob).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.comparison.setText(`${t('check.error')}: ${message}`);
			this.metrics.log({ event: 'error', where: 'decode', message });
		});

		this.metrics.log({
			event: 'recording',
			durationMs: Math.round(recording.durationMs),
			bytes: recording.blob.size,
			kbps: Math.round((recording.blob.size * 8) / Math.max(1, recording.durationMs)),
			mimeType: recording.mimeType,
		});
		if (this.live.audioMs) {
			this.metrics.log({
				event: 'transcribe',
				kind: 'live',
				model: this.models.live,
				audioMs: Math.round(this.live.audioMs),
				ms: Math.round(this.live.ms),
				speed: round(this.live.audioMs / Math.max(1, this.live.ms)),
				phrases: this.live.phrases,
				skippedPartials: this.transcriber?.skippedPartials ?? 0,
			});
		}
		// The live transcript keeps settling for a moment after Stop; score it once Whisper is done

		this.addDetail(t('check.format'), recording.mimeType || t('check.unknown'));
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const sizeKb = Math.round(recording.blob.size / 1024);
		try {
			const path = await saveToTemp(recording.blob, `test-${stamp}.${extensionFor(recording.mimeType)}`);
			this.addDetail(t('check.saved'), path ? `${path} (${sizeKb} KB)` : t('check.savedLater'));
			this.status.setText(t('record.saved'));
		} catch (error) {
			console.error('Jeong: could not save the recording', error);
			this.status.setText(t('record.saveFailed'));
			this.metrics.log({ event: 'error', where: 'save', message: error instanceof Error ? error.message : String(error) });
		}
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
		this.metrics.log({ event: 'quality', kind: 'live', model: this.models.live, wer: round(liveWer), referenceWords });
		this.metrics.log({ event: 'quality', kind: 'final', model: this.models.final, wer: round(finalWer), referenceWords });
		this.comparison.createDiv({
			cls: 'jeong-comparison-score',
			text: `${t('test.wordsWrong')}: ${shortName(this.models.live)} ${percent(liveWer)} · ${shortName(this.models.final)} ${percent(finalWer)}`,
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
