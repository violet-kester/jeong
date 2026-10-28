import { App, Component, MarkdownRenderer, Modal, Platform, moment, setIcon } from 'obsidian';
import type { EntryInfo } from '../journal/entries';
import { findTranscript } from '../journal/apply-story';
import { storyText } from '../journal/story-text';
import { applyInk, type InkName } from '../paint/ink';
import { t } from '../i18n';

// Reading an entry from the timeline: its picture, when it was, its title, and the story itself, with a way
// into the story's note and the raw transcript in Obsidian.

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

		// The painting leads, then the photos
		const [main, ...rest] = [entry.painting, ...entry.photos].filter((file) => file !== null);
		if (main) {
			page.createEl('img', {
				cls: `jeong-story-picture${main === entry.painting ? ' jeong-painting' : ''}`,
				attr: { src: this.app.vault.getResourcePath(main), alt: '' },
			});
			if (rest.length) {
				const strip = page.createDiv({ cls: 'jeong-story-strip' });
				for (const photo of rest) strip.createEl('img', { attr: { src: this.app.vault.getResourcePath(photo), alt: '' } });
			}
		}

		const meta = [moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'LLLL' : 'LL'), entry.duration].filter(Boolean).join(' · ');
		page.createDiv({ cls: 'jeong-story-meta', text: meta });
		page.createEl('h1', { cls: 'jeong-story-title', text: entry.title });

		const body = page.createDiv({ cls: 'jeong-story-body' });
		if (entry.status === 'recorded') {
			body.createEl('p', { text: t('timeline.waiting') });
		} else {
			this.renderer.load();
			const story = storyText(await this.app.vault.cachedRead(entry.file));
			await MarkdownRenderer.render(this.app, story, body, entry.file.path, this.renderer);
		}

		const actions = page.createDiv({ cls: 'jeong-story-actions' });
		// Two different things, so two buttons: more words join the story; spoken changes are applied to it
		const record = this.record;
		if (record && entry.status !== 'recorded' && !Platform.isMobile) {
			this.button(actions, 'mic', t('story.add'), () => record('add'));
			this.button(actions, 'pencil', t('story.change'), () => record('change'));
		}
		this.action(actions, 'book-open', t('story.openNote'), () => entry.file);
		const transcript = findTranscript(this.app, entry.file);
		if (transcript) this.action(actions, 'align-left', t('story.openTranscript'), () => transcript);
	}

	/** A pill that closes the story and opens a note in Obsidian. */
	private action(parent: HTMLElement, icon: string, label: string, file: () => EntryInfo['file']): void {
		this.button(parent, icon, label, () => void this.app.workspace.getLeaf(false).openFile(file()));
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
