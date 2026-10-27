import { Plugin } from 'obsidian';
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

	async onload() {
		await this.loadSettings();
		this.metrics = new Metrics(this.app, () => this.settings.journalFolder, this.manifest.version);

		this.addRibbonIcon('mic', t('ribbon.record'), () => this.openRecorder());

		this.addCommand({
			id: 'new-entry',
			name: t('command.newEntry'),
			callback: () => this.openRecorder(),
		});

		this.addCommand({
			id: 'transcription-test',
			name: t('command.transcriptionTest'),
			callback: () => new RecordModal(this.app, this.metrics, { test: true, liveMode: this.settings.liveMode }).open(),
		});

		this.addCommand({
			id: 'show-performance',
			name: t('command.showPerformance'),
			callback: () => new PerformanceModal(this.app, this.metrics).open(),
		});

		this.addSettingTab(new JeongSettingTab(this.app, this));
	}

	openRecorder() {
		new RecordModal(this.app, this.metrics, { liveMode: this.settings.liveMode }).open();
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
