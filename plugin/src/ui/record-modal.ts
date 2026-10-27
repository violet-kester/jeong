import { App, Modal } from 'obsidian';
import { t } from '../i18n';

// Placeholder for the recording panel. Milestone M2 adds the live waveform,
// and M3 the live transcript.
export class RecordModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('jeong');
		this.setTitle(t('record.title'));
		this.contentEl.createEl('p', { text: t('record.comingSoon'), cls: 'jeong-record-placeholder' });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
