import { App, Modal, Notice, TFile, normalizePath, setIcon } from 'obsidian';
import { findTranscript } from '../journal/apply-story';
import { saveEntryEdits } from '../journal/edit-entry';
import { embeddedName, parseEntryNote, transcriptParagraphs } from '../journal/entry-note';
import { PhotoTray } from './photo-tray';
import { t } from '../i18n';

// Changing an entry by hand, on a phone or a computer: its title, story, and transcript, and its photos.
// Nothing is written until Save, so Cancel really does leave the entry as it was.

export class EntryEditModal extends Modal {
	private photos: string[] = [];
	private tray!: PhotoTray;
	private strip!: HTMLElement;

	constructor(
		app: App,
		private note: TFile,
		private onSaved?: () => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { note } = this;
		this.modalEl.addClass('jeong', 'jeong-story', 'jeong-edit');
		const page = this.contentEl.createDiv({ cls: 'jeong-story-page' });
		page.createEl('h2', { cls: 'jeong-edit-heading', text: t('edit.heading') });

		const content = await this.app.vault.read(note);
		const parsed = parseEntryNote(content);
		// A phone recording waiting to be written up has no words yet, only photos to change
		const hasWords = !/^status:\s*recorded\s*$/m.test(parsed.frontmatter);
		// The list the timeline reads, then any in the note it doesn't have yet (just saved, or added by hand)
		const listed: unknown = this.app.metadataCache.getFileCache(note)?.frontmatter?.photos;
		const names = Array.isArray(listed) ? listed.map(String) : [];
		this.photos = [...names, ...parsed.photos.map(embeddedName).filter((name) => !names.includes(name))];

		const photos = page.createDiv({ cls: 'jeong-edit-field' });
		photos.createDiv({ cls: 'jeong-edit-label', text: t('edit.photos') });
		this.strip = photos.createDiv({ cls: 'jeong-edit-photos' });
		this.tray = new PhotoTray(photos, t('photos.addShort'));
		this.renderPhotos();

		let title: HTMLInputElement | null = null;
		let story: HTMLTextAreaElement | null = null;
		let transcript: HTMLTextAreaElement | null = null;
		if (hasWords) {
			title = this.field(page, t('edit.title')).createEl('input', { type: 'text', attr: { 'aria-label': t('edit.title') } });
			const name: unknown = this.app.metadataCache.getFileCache(note)?.frontmatter?.title;
			title.value = typeof name === 'string' ? name : note.basename;
			story = this.field(page, t('edit.story')).createEl('textarea', { attr: { rows: '10', 'aria-label': t('edit.story') } });
			story.value = parsed.story;
			const file = findTranscript(this.app, note);
			if (file) {
				transcript = this.field(page, t('edit.transcript')).createEl('textarea', { attr: { rows: '8', 'aria-label': t('edit.transcript') } });
				transcript.value = transcriptParagraphs(await this.app.vault.read(file)).join('\n\n');
			}
		}
		const originalTranscript = transcript?.value;

		const actions = page.createDiv({ cls: 'jeong-story-actions' });
		const save = actions.createEl('button', { cls: 'jeong-open-button is-pill jeong-edit-save', text: t('edit.save') });
		actions.createEl('button', { cls: 'jeong-open-button is-pill', text: t('entry.cancel') }).addEventListener('click', () => this.close());
		save.addEventListener('click', () => {
			save.disabled = true;
			void saveEntryEdits(this.app, note, {
				title: title?.value,
				story: story?.value,
				transcript: transcript && transcript.value !== originalTranscript ? transcript.value : undefined,
				photos: this.photos,
				newPhotos: this.tray.photos.map(({ file }) => ({ name: file.name, type: file.type, data: file })),
			}).then(
				() => {
					new Notice(t('edit.saved'));
					this.close();
					this.onSaved?.();
				},
				(error: unknown) => {
					console.error('Jeong: could not save the edits', error);
					new Notice(t('edit.failed'));
					save.disabled = false;
				},
			);
		});
	}

	private field(parent: HTMLElement, label: string): HTMLElement {
		const field = parent.createEl('label', { cls: 'jeong-edit-field' });
		field.createDiv({ cls: 'jeong-edit-label', text: label });
		return field;
	}

	/** The photos already saved: a star makes one the main photo, and an × takes it away on Save. */
	private renderPhotos(): void {
		this.strip.empty();
		this.photos.forEach((name, index) => {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(`${this.note.parent?.path ?? ''}/${name}`));
			if (!(file instanceof TFile)) return;
			const item = this.strip.createDiv({ cls: `jeong-edit-photo${index === 0 ? ' is-main' : ''}` });
			item.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: '' } });
			if (index > 0) {
				const star = item.createEl('button', { attr: { 'aria-label': t('photos.makeMain') } });
				setIcon(star, 'star');
				star.addEventListener('click', () => {
					this.photos.unshift(...this.photos.splice(index, 1));
					this.renderPhotos();
				});
			}
			const remove = item.createEl('button', { cls: 'jeong-edit-photo-remove', attr: { 'aria-label': t('photos.remove') } });
			setIcon(remove, 'x');
			remove.addEventListener('click', () => {
				this.photos.splice(index, 1);
				this.renderPhotos();
			});
		});
	}

	onClose(): void {
		this.tray?.dispose();
		this.contentEl.empty();
	}
}
