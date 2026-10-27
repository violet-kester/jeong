import { App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type JeongPlugin from './main';
import { t } from './i18n';

export interface JeongSettings {
	journalFolder: string;
	/** How the words you see while you talk are written. */
	liveMode: LiveMode;
}

/** hybrid: Moonshine guesses (light ink), Whisper writes each finished phrase (full ink). moonshine: Moonshine only, for slower computers. */
export type LiveMode = 'hybrid' | 'moonshine';

export const DEFAULT_SETTINGS: JeongSettings = {
	journalFolder: 'spaces/jeong',
	liveMode: 'hybrid',
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
					.addOption('hybrid', t('settings.liveModel.hybrid'))
					.addOption('moonshine', t('settings.liveModel.moonshine'))
					.setValue(this.plugin.settings.liveMode)
					.onChange(async (value) => {
						this.plugin.settings.liveMode = value === 'moonshine' ? 'moonshine' : 'hybrid';
						await this.plugin.saveSettings();
					}),
			);
	}
}
