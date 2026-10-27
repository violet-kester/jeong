import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, JeongSettings, JeongSettingTab } from './settings';
import { RecordModal } from './ui/record-modal';
import { t } from './i18n';

/**
 * Jeong (정) for Obsidian: record your thoughts and see them on a timeline,
 * all on your own computer.
 */
export default class JeongPlugin extends Plugin {
	settings!: JeongSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('mic', t('ribbon.record'), () => this.openRecorder());

		this.addCommand({
			id: 'new-entry',
			name: t('command.newEntry'),
			callback: () => this.openRecorder(),
		});

		this.addSettingTab(new JeongSettingTab(this.app, this));
	}

	openRecorder() {
		new RecordModal(this.app).open();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<JeongSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
