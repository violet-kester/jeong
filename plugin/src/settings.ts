import { App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type JeongPlugin from './main';
import { t } from './i18n';
import type { SpeechModel } from './transcribe/messages';

export interface JeongSettings {
	journalFolder: string;
	/** Which model writes the words you see while you talk. */
	liveModel: SpeechModel;
}

export const DEFAULT_SETTINGS: JeongSettings = {
	journalFolder: 'spaces/jeong',
	liveModel: 'whisper-turbo',
};

export class JeongSettingTab extends PluginSettingTab {
	plugin: JeongPlugin;

	constructor(app: App, plugin: JeongPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t('settings.journalFolder.name'))
			.setDesc(t('settings.journalFolder.desc'))
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.journalFolder)
					.setValue(this.plugin.settings.journalFolder)
					.onChange(async (value) => {
						this.plugin.settings.journalFolder = normalizePath(value || DEFAULT_SETTINGS.journalFolder);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.liveModel.name'))
			.setDesc(t('settings.liveModel.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('whisper-turbo', t('settings.liveModel.whisper'))
					.addOption('moonshine-base', t('settings.liveModel.moonshine'))
					.setValue(this.plugin.settings.liveModel)
					.onChange(async (value) => {
						this.plugin.settings.liveModel = value as SpeechModel;
						await this.plugin.saveSettings();
					}),
			);
	}
}
