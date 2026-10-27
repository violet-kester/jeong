import { Notice, Plugin, TFile } from 'obsidian';
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

	async onload() {
		await this.loadSettings();
		this.metrics = new Metrics(this.app, () => this.settings.journalFolder, this.manifest.version);
		this.ollama = new Ollama(() => this.settings.ollamaUrl, () => this.settings.storyModel);

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

		this.addSettingTab(new JeongSettingTab(this.app, this));
	}

	/** Opens the timeline in a tab, or switches to it if it's already open. */
	async openTimeline() {
		const existing = this.app.workspace.getLeavesOfType(TIMELINE_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getLeaf('tab');
		if (!existing) await leaf.setViewState({ type: TIMELINE_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
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
