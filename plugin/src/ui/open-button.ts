import { setIcon } from 'obsidian';
import { t } from '../i18n';

// Open entry: a hanji button with a book. Round with its label underneath in the recording window;
// a pill with the label inside on the timeline's preview card. Both share .jeong-open-button in styles.css.

/** The round Open entry button with its label underneath, inside an action column. */
export function openButtonRound(parent: HTMLElement, onClick: () => void): { action: HTMLElement; button: HTMLButtonElement } {
	const action = parent.createDiv({ cls: 'jeong-entry-action is-hidden' });
	const button = action.createEl('button', { cls: 'jeong-open-button', attr: { 'aria-label': t('record.openEntry') } });
	setIcon(button, 'book-open');
	action.createDiv({ cls: 'jeong-entry-action-label', text: t('record.openEntry') });
	button.addEventListener('click', onClick);
	return { action, button };
}

/** The pill Open entry button, with its label inside. */
export function openButtonPill(parent: HTMLElement, onClick: () => void): HTMLButtonElement {
	const button = parent.createEl('button', { cls: 'jeong-open-button is-pill' });
	setIcon(button.createSpan({ cls: 'jeong-open-button-icon' }), 'book-open');
	button.createSpan({ text: t('record.openEntry') });
	button.addEventListener('click', onClick);
	return button;
}
