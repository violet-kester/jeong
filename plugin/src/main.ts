import { Notice, Platform, Plugin, TFile } from 'obsidian';
import { LooseProcessor } from './journal/process-loose';
import { Ollama } from './compose/ollama';
import { writeStory } from './compose/write-story';
import { storyMessage } from './ui/story-messages';
import { TIMELINE_VIEW, TimelineView } from './ui/timeline-view';
import { DEFAULT_SETTINGS, JeongSettings, JeongSettingTab } from './settings';
import { RecordModal } from './ui/record-modal';
import { PerformanceModal } from './ui/performance-modal';
import { Metrics } from './metrics/metrics';
import { t } from './i18n';

/**
 * Jeong (정) for Obsidian: record your thoughts and see them on a timeline,
 * all on your own computer.
 */
export default class JeongPlugin extends Plugin {
	settings!: JeongSettings;
	metrics!: Metrics;
	ollama!: Ollama;
	loose!: LooseProcessor;

	async onload() {
		await this.loadSettings();
		this.applyTheme();
		this.metrics = new Metrics(this.app, () => this.settings.journalFolder, this.manifest.version);
		this.ollama = new Ollama(() => this.settings.ollamaUrl, () => this.settings.storyModel);
		this.loose = new LooseProcessor(this.app, () => this.settings.journalFolder, this.ollama, this.metrics, this.manifest.version);

		this.registerView(TIMELINE_VIEW, (leaf) => new TimelineView(leaf, this));

		this.addRibbonIcon('mic', t('ribbon.record'), () => this.openRecorder());
		this.addRibbonIcon('history', t('ribbon.timeline'), () => void this.openTimeline());

		this.addCommand({
			id: 'new-entry',
			name: t('command.newEntry'),
			callback: () => this.openRecorder(),
		});

		this.addCommand({
			id: 'open-timeline',
			name: t('command.openTimeline'),
			callback: () => void this.openTimeline(),
		});

		this.addCommand({
			id: 'write-story',
			name: t('command.writeStory'),
			checkCallback: (checking) => {
				const note = this.app.workspace.getActiveFile();
				if (!note || !this.isEntry(note)) return false;
				if (!checking) void this.writeStoryFor(note);
				return true;
			},
		});

		this.addCommand({
			id: 'transcription-test',
			name: t('command.transcriptionTest'),
			callback: () => new RecordModal(this.app, this.metrics, { ...this.recordOptions(), test: true }).open(),
		});

		this.addCommand({
			id: 'show-performance',
			name: t('command.showPerformance'),
			callback: () => new PerformanceModal(this.app, this.metrics).open(),
		});

		this.addCommand({
			id: 'process-loose-pages',
			name: t('command.processLoose'),
			callback: () => {
				const queued = this.loose.processAll();
				new Notice(queued ? `${t('loose.queued')} ${queued}` : t('loose.none'));
			},
		});

		// On a computer, write up phone recordings as they arrive through sync, and any left from before
		if (Platform.isDesktopApp) {
			this.app.workspace.onLayoutReady(() => {
				if (this.settings.autoProcessLoose) this.loose.processAll();
				this.registerEvent(
					this.app.metadataCache.on('changed', (file) => {
						if (!this.settings.autoProcessLoose || file.parent?.path !== this.loose.folder) return;
						if (this.app.metadataCache.getFileCache(file)?.frontmatter?.status === 'recorded') this.loose.enqueue(file);
					}),
				);
				// Sync can deliver the note before its recording; try again once the audio arrives
				this.registerEvent(
					this.app.vault.on('create', (file) => {
						if (this.settings.autoProcessLoose && file.parent?.path === this.loose.folder && !file.path.endsWith('.md')) this.loose.processAll();
					}),
				);
			});
		}

		this.addSettingTab(new JeongSettingTab(this.app, this));
	}

	/** Opens the timeline in a tab, or switches to it if it's already open. */
	async openTimeline() {
		const existing = this.app.workspace.getLeavesOfType(TIMELINE_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getLeaf('tab');
		await leaf.loadIfDeferred();
		// A tab left over from before the plugin reloaded (after an update) can be empty; rebuild it
		if (!(leaf.view instanceof TimelineView)) await leaf.setViewState({ type: TIMELINE_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof TimelineView) leaf.view.goToToday();
	}

	onunload() {
		this.loose?.dispose();
		document.body.removeClass('jeong-theme-light', 'jeong-theme-dark');
	}

	/** Puts Jeong's light or dark colors on every Jeong view and window, or lets them follow Obsidian. */
	applyTheme() {
		document.body.toggleClass('jeong-theme-light', this.settings.theme === 'light');
		document.body.toggleClass('jeong-theme-dark', this.settings.theme === 'dark');
	}

	openRecorder() {
		new RecordModal(this.app, this.metrics, this.recordOptions()).open();
	}

	private recordOptions() {
		return { liveMode: this.settings.liveMode, journalFolder: this.settings.journalFolder, ollama: this.ollama };
	}

	/** An entry is a note in the journal folder with a date and a visibility in its frontmatter. */
	private isEntry(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return file.path.startsWith(`${this.settings.journalFolder}/`) && typeof fm?.date === 'string' && fm !== undefined && 'visibility' in fm;
	}

	private async writeStoryFor(note: TFile) {
		const notice = new Notice(storyMessage('story'), 0);
		await writeStory(this.app, this.ollama, this.metrics, note, (progress) => notice.setMessage(storyMessage(progress)));
		window.setTimeout(() => notice.hide(), 6000);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<JeongSettings>);
		// Older versions saved a model name here; anything unknown falls back to the default
		if (this.settings.liveMode !== 'moonshine') this.settings.liveMode = 'hybrid';
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
