import { Notice, Platform, Plugin, TFile } from 'obsidian';
import { LooseProcessor } from './journal/process-loose';
import { StoryWriter } from './compose/language-model';
import { writeStory } from './compose/write-story';
import { paintMessage, storyMessage } from './ui/story-messages';
import { TIMELINE_VIEW, TimelineView } from './ui/timeline-view';
import { DEFAULT_SETTINGS, JeongSettings, JeongSettingTab, OLD_PAINT_STYLES, PAINT_STYLE, type JeongTheme } from './settings';
import { RecordModal, type RecordModalOptions } from './ui/record-modal';
import { PerformanceModal } from './ui/performance-modal';
import { Metrics } from './metrics/metrics';
import { Painter } from './paint/painter';
import { addIcons } from './ui/icons';
import { t } from './i18n';

/**
 * Jeong (정) for Obsidian: record your thoughts and see them on a timeline,
 * all on your own computer.
 */
export default class JeongPlugin extends Plugin {
	settings!: JeongSettings;
	metrics!: Metrics;
	llm!: StoryWriter;
	loose!: LooseProcessor;
	painter!: Painter;

	async onload() {
		await this.loadSettings();
		addIcons();
		this.applyTheme();
		this.metrics = new Metrics(this.app, () => this.settings.journalFolder, this.manifest.version);
		const secret = (id: string) => (id ? (this.app.secretStorage.getSecret(id) ?? '') : '');
		this.llm = new StoryWriter(() => this.settings, secret);
		this.painter = new Painter(this.app, this.llm, this.metrics, () => this.settings, secret);
		this.loose = new LooseProcessor(this.app, () => this.settings.journalFolder, this.llm, this.metrics, this.manifest.version);

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
			id: 'paint',
			name: t('command.paint'),
			checkCallback: (checking) => {
				// Painting runs on a computer's graphics card, so phones don't offer it
				const note = this.app.workspace.getActiveFile();
				if (Platform.isMobile || !note || !this.isEntry(note)) return false;
				if (!checking) void this.paintFor(note);
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
		this.painter?.dispose();
		document.body.removeClass('jeong-theme-light', 'jeong-theme-dark');
	}

	/** Light or dark for now, from the timeline's button; the theme in settings comes back when Obsidian starts again. */
	private themeForNow: JeongTheme | null = null;

	/** Shows Jeong in `theme` for now, or, given null, in the theme from settings again. */
	showTheme(theme: JeongTheme | null) {
		this.themeForNow = theme;
		this.applyTheme();
	}

	/** Puts Jeong's light or dark colors on every Jeong view and window, or lets them follow Obsidian. */
	applyTheme() {
		const theme = this.themeForNow ?? this.settings.theme;
		document.body.toggleClass('jeong-theme-light', theme === 'light');
		document.body.toggleClass('jeong-theme-dark', theme === 'dark');
		for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW)) {
			if (leaf.view instanceof TimelineView) leaf.view.showThemeButton();
		}
	}

	/** Redraws open timelines, e.g. after the ink color changes. */
	refreshTimelines() {
		for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW)) {
			if (leaf.view instanceof TimelineView) leaf.view.applyInk();
		}
	}

	/** The recording window: a new entry, or (with `entry`) adding to or changing one. */
	openRecorder(entry?: RecordModalOptions['entry']) {
		new RecordModal(this.app, this.metrics, { ...this.recordOptions(), entry }).open();
	}

	private recordOptions() {
		return {
			liveMode: this.settings.liveMode,
			journalFolder: this.settings.journalFolder,
			llm: this.llm,
			painter: this.painter,
			paintInk: this.settings.paintInk,
		};
	}

	/** An entry is a note in the journal folder with a date and a visibility in its frontmatter. */
	private isEntry(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return file.path.startsWith(`${this.settings.journalFolder}/`) && typeof fm?.date === 'string' && fm !== undefined && 'visibility' in fm;
	}

	private async writeStoryFor(note: TFile) {
		const notice = new Notice(storyMessage('story'), 0);
		await writeStory(this.app, this.llm, this.metrics, note, (progress) => notice.setMessage(storyMessage(progress)));
		window.setTimeout(() => notice.hide(), 6000);
	}

	private async paintFor(note: TFile) {
		const notice = new Notice(paintMessage('scene'), 0);
		await this.painter.paint(note, (progress) => notice.setMessage(paintMessage(progress)));
		window.setTimeout(() => notice.hide(), 6000);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<JeongSettings>);
		// Older versions saved a model name here; anything unknown falls back to the default
		if (this.settings.liveMode !== 'moonshine') this.settings.liveMode = 'hybrid';
		// A painting style never edited is the built-in one, so it follows when the built-in one changes
		if (OLD_PAINT_STYLES.includes(this.settings.paintStyle)) this.settings.paintStyle = PAINT_STYLE;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
