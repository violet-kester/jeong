import { App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type JeongPlugin from './main';
import { t } from './i18n';

export interface JeongSettings {
	journalFolder: string;
}

export const DEFAULT_SETTINGS: JeongSettings = {
	journalFolder: 'spaces/jeong',
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
	}
}
