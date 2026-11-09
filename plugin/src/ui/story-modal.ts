import { App, Component, MarkdownRenderer, Modal, Platform, moment, setIcon } from 'obsidian';
import type { EntryInfo } from '../journal/entries';
import { findTranscript } from '../journal/apply-story';
import { storyText, transcriptParagraphs } from '../journal/entry-note';
import { applyInk, type InkName } from '../paint/ink';
import { EntryEditModal } from './entry-edit-modal';
import { t } from '../i18n';

// Reading an entry: its picture and photos, when it was, its title, the story, and word for word what was said,
// with a way into its note in the vault.

export class StoryModal extends Modal {
	private renderer = new Component();

	constructor(
		app: App,
		private entry: EntryInfo,
		private ink: InkName,
		/** Opens the recording window to add to this story or change it (on a computer, once it's written). */
		private record?: (mode: 'add' | 'change') => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { entry } = this;
		this.modalEl.addClass('jeong', 'jeong-story');
		const page = this.contentEl.createDiv({ cls: 'jeong-story-page' });
		applyInk(page, this.ink);

		// The words scroll; the buttons have their own place under them, so the two never overlap
		const scroll = page.createDiv({ cls: 'jeong-story-scroll' });

		// The painting leads, then the photos
		const [main, ...rest] = [entry.painting, ...entry.photos].filter((file) => file !== null);
		if (main) {
			scroll.createEl('img', {
				cls: `jeong-story-picture${main === entry.painting ? ' jeong-painting' : ''}`,
				attr: { src: this.app.vault.getResourcePath(main), alt: '' },
			});
			if (rest.length) {
				const strip = scroll.createDiv({ cls: 'jeong-story-strip' });
				for (const photo of rest) strip.createEl('img', { attr: { src: this.app.vault.getResourcePath(photo), alt: '' } });
			}
		}

		const meta = [moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'LLLL' : 'LL'), entry.duration].filter(Boolean).join(' · ');
		scroll.createDiv({ cls: 'jeong-story-meta', text: meta });
		scroll.createEl('h1', { cls: 'jeong-story-title', text: entry.title });

		const body = scroll.createDiv({ cls: 'jeong-story-body' });
		let story = '';
		if (entry.status === 'recorded') {
			body.createEl('p', { text: t('timeline.waiting') });
		} else {
			this.renderer.load();
			story = storyText(await this.app.vault.cachedRead(entry.file));
			await MarkdownRenderer.render(this.app, story, body, entry.file.path, this.renderer);
		}
		await this.showTranscript(scroll, story);

		const actions = page.createDiv({ cls: 'jeong-story-actions' });
		// By hand, on a phone too: the words, and the photos
		this.button(actions, 'square-pen', t('story.edit'), () => new EntryEditModal(this.app, entry.file).open());
		// Two different things, so two buttons: more words join the story; spoken changes are applied to it
		const record = this.record;
		if (record && entry.status !== 'recorded' && !Platform.isMobile) {
			this.button(actions, 'mic', t('story.add'), () => record('add'));
			this.button(actions, 'pencil', t('story.change'), () => record('change'));
		}
		this.button(actions, 'book-open', t('story.openInVault'), () => void this.app.workspace.getLeaf(false).openFile(entry.file));
	}

	/** Word for word what was said, under the story. Left out while the story is still just those same words. */
	private async showTranscript(page: HTMLElement, story: string): Promise<void> {
		const file = findTranscript(this.app, this.entry.file);
		if (!file) return;
		const paragraphs = transcriptParagraphs(await this.app.vault.cachedRead(file));
		const squeezed = (text: string) => text.replace(/\s+/g, ' ').trim();
		if (!paragraphs.length || squeezed(paragraphs.join(' ')) === squeezed(story)) return;
		const section = page.createDiv({ cls: 'jeong-story-transcript' });
		section.createEl('h2', { text: t('story.transcriptHeading') });
		for (const text of paragraphs) section.createEl('p', { text });
	}

	/** A pill that closes the story, then does what it says. */
	private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl('button', { cls: 'jeong-open-button is-pill' });
		setIcon(button.createSpan({ cls: 'jeong-open-button-icon' }), icon);
		button.createSpan({ text: label });
		button.addEventListener('click', () => {
			this.close();
			onClick();
		});
	}

	onClose(): void {
		this.renderer.unload();
		this.contentEl.empty();
	}
}
