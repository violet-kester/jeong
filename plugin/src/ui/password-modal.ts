import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/** Asks for a password (twice, when choosing a new one). `onSubmit` resolves true to close, false to say it's wrong. */
export class PasswordModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private choosing: boolean,
		private onSubmit: (password: string) => Promise<boolean>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.modalEl.addClass('jeong', 'jeong-password');
		const form = this.contentEl.createEl('form', { cls: 'jeong-password-form' });
		const input = form.createEl('input', { type: 'password', attr: { 'aria-label': t('lock.password'), placeholder: t('lock.password') } });
		const again = this.choosing ? form.createEl('input', { type: 'password', attr: { 'aria-label': t('lock.again'), placeholder: t('lock.again') } }) : null;
		const error = form.createDiv({ cls: 'jeong-password-error' });
		const submit = form.createEl('button', { cls: 'mod-cta', text: t('lock.continue'), attr: { type: 'submit' } });
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			if (!input.value) return;
			if (again && input.value !== again.value) {
				error.setText(t('lock.mismatch'));
				return;
			}
			submit.disabled = true;
			void this.onSubmit(input.value).then((done) => {
				submit.disabled = false;
				if (done) this.close();
				else error.setText(t('lock.wrong'));
			});
		});
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
