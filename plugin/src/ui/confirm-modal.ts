import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/** Asks before something that can't be taken back from here, like deleting an entry. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl('p', { text: this.body });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: t('entry.cancel') }).addEventListener('click', () => this.close());
		const confirm = buttons.createEl('button', { cls: 'mod-warning', text: this.confirmLabel });
		confirm.addEventListener('click', () => {
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
