import { App, Modal } from 'obsidian';
import { t } from '../i18n';
import { Recorder } from '../audio/recorder';
import { Waveform } from './waveform';
import { checkWebGpu } from '../diagnostics/webgpu';
import { extensionFor, saveToTemp } from '../storage/temp-file';
import { LiveTranscriber } from '../transcribe/live-transcriber';
import { FinalTranscriber } from '../transcribe/final-transcriber';

// The recording panel. For now (milestone M1) it's a test bench: record, watch the
// live waveform and live transcript, and see what this computer supports.
export class RecordModal extends Modal {
	private recorder = new Recorder();
	private waveform: Waveform | null = null;
	private transcriber: LiveTranscriber | null = null;
	private finalTranscriber: FinalTranscriber | null = null;
	private timerFrame = 0;
	private speed = { ms: 0, audioMs: 0 };

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

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('jeong', 'jeong-record');
		this.setTitle(t('record.title'));
		const { contentEl } = this;

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
		this.startTranscriber();
	}

	onClose(): void {
		this.waveform?.stop();
		window.cancelAnimationFrame(this.timerFrame);
		this.recorder.release();
		this.transcriber?.dispose();
		this.finalTranscriber?.dispose();
		this.contentEl.empty();
	}

	// Load the model as soon as the panel opens, so it's ready by the time you talk
	private startTranscriber(): void {
		this.finalTranscriber = new FinalTranscriber({
			onStage: (stage) => this.finalRow.setText(t(stage === 'loading' ? 'check.loading' : 'check.warming')),
			onProgress: (percent) => this.finalRow.setText(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs) =>
				this.finalRow.setText(`Whisper Large v3 Turbo · ${device} · ${t('check.readyIn')} ${(loadMs / 1000).toFixed(1)} s`),
			onResult: (text, ms, audioMs) => {
				this.comparison.empty();
				this.comparison.createDiv({ cls: 'jeong-comparison-label', text: t('compare.whisper') });
				this.comparison.createDiv({ cls: 'jeong-comparison-text', text: text || '—' });
				this.comparison.createDiv({
					cls: 'jeong-comparison-label',
					text: `${(ms / 1000).toFixed(1)} s ${t('compare.toRead')} ${(audioMs / 1000).toFixed(0)} s · ${(audioMs / Math.max(1, ms)).toFixed(1)}× ${t('check.fasterThanSpeech')}`,
				});
			},
			onError: (message) => {
				console.error('Jeong final transcript:', message);
				this.finalRow.setText(`${t('check.error')}: ${message}`);
			},
		});
		this.transcriber = new LiveTranscriber({
			onStage: (stage) => this.modelRow.setText(t(stage === 'loading' ? 'check.loading' : 'check.warming')),
			onProgress: (percent) => this.modelRow.setText(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs) =>
				this.modelRow.setText(`Moonshine Base · ${device} · ${t('check.readyIn')} ${(loadMs / 1000).toFixed(1)} s`),
			onPartial: (text) => this.partial.setText(text),
			onFinal: (text) => {
				if (text) this.transcript.insertBefore(createSpan({ cls: 'jeong-transcript-final', text: `${text} ` }), this.partial);
				this.partial.setText('');
				this.transcript.scrollTop = this.transcript.scrollHeight;
			},
			onTiming: (ms, audioMs) => {
				this.speed.ms += ms;
				this.speed.audioMs += audioMs;
				const factor = this.speed.audioMs / Math.max(1, this.speed.ms);
				this.speedRow.setText(`${factor.toFixed(1)}× ${t('check.fasterThanSpeech')} · ${Math.round(ms)} ms ${t('check.lastPhrase')}`);
			},
			onError: (message) => {
				console.error('Jeong live transcript:', message);
				this.modelRow.setText(`${t('check.error')}: ${message}`);
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
		this.comparison.setText(t('compare.reading'));
		void this.finalTranscriber?.transcribe(recording.blob).catch((error: unknown) => {
			this.comparison.setText(`${t('check.error')}: ${error instanceof Error ? error.message : String(error)}`);
		});
		this.button.setText(t('record.start'));
		this.status.setText(t('record.saving'));
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
		}
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
