import { App, Modal } from 'obsidian';
import { t } from '../i18n';
import { Recorder } from '../audio/recorder';
import { Waveform } from './waveform';
import { checkWebGpu } from '../diagnostics/webgpu';
import { extensionFor, saveToTemp } from '../storage/temp-file';

// The recording panel. For now (milestone M1) it's a test bench: record, watch the
// live waveform, and see what this computer supports. M3 adds the live transcript.
export class RecordModal extends Modal {
	private recorder = new Recorder();
	private waveform: Waveform | null = null;
	private timerFrame = 0;

	private button!: HTMLButtonElement;
	private status!: HTMLElement;
	private timer!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private details!: HTMLElement;

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('jeong', 'jeong-record');
		this.setTitle(t('record.title'));
		const { contentEl } = this;

		this.timer = contentEl.createDiv({ cls: 'jeong-record-timer', text: '0:00' });
		this.canvas = contentEl.createEl('canvas', { cls: 'jeong-record-waveform' });
		this.status = contentEl.createDiv({ cls: 'jeong-record-status', text: t('record.ready') });
		this.button = contentEl.createEl('button', { cls: 'jeong-record-button mod-cta', text: t('record.start') });
		this.button.addEventListener('click', () => void this.toggle());

		this.details = contentEl.createDiv({ cls: 'jeong-record-details' });
		void this.showSystemCheck();
	}

	onClose(): void {
		this.waveform?.stop();
		window.cancelAnimationFrame(this.timerFrame);
		this.recorder.release();
		this.contentEl.empty();
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
		if (!this.recorder.analyser) return;
		this.waveform = new Waveform(this.canvas, this.recorder.analyser);
		this.waveform.start();
		this.button.setText(t('record.stop'));
		this.status.setText(t('record.recording'));
		this.addDetail(t('check.format'), this.recorder.mimeType || t('check.unknown'));
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
		const recording = await this.recorder.stop();
		this.button.setText(t('record.start'));
		this.status.setText(t('record.saving'));

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

	private addDetail(label: string, value: string): void {
		const row = this.details.createDiv({ cls: 'jeong-record-detail' });
		row.createSpan({ cls: 'jeong-record-detail-label', text: label });
		row.createSpan({ text: value });
	}
}
