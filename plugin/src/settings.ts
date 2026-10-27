import { App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type JeongPlugin from './main';
import { INKS, type InkName } from './paint/ink';
import { t } from './i18n';

export interface JeongSettings {
	journalFolder: string;
	/** How the words you see while you talk are written. */
	liveMode: LiveMode;
	/** Where Ollama runs (on this computer). */
	ollamaUrl: string;
	/** The Ollama model that writes stories and summaries. */
	storyModel: string;
	/** On a computer, write up phone recordings automatically when they arrive. */
	autoProcessLoose: boolean;
	/** Jeong's own light or dark colors, or whatever Obsidian uses. */
	theme: JeongTheme;
	/** Where ComfyUI runs (on this computer), for paintings. */
	comfyUrl: string;
	/** How paintings look: added to every picture's description. */
	paintStyle: string;
	/** Optional: a ComfyUI workflow in the vault (Export (API)) with {{prompt}} where the words go. Empty uses FLUX.2 klein. */
	paintWorkflow: string;
	/** The one ink color paintings are shown in (they're painted in black). */
	paintInk: InkName;
}

export type JeongTheme = 'obsidian' | 'light' | 'dark';

/** hybrid: Moonshine guesses (light ink), Whisper writes each finished phrase (full ink). moonshine: Moonshine only, for slower computers. */
export type LiveMode = 'hybrid' | 'moonshine';

/**
 * "Wash into mist": wet washes and a few dark marks, the forms melting into soft clouds of wash. Black ink only,
 * because the model holds to one color reliably only in black; Jeong shows it in the ink color from settings.
 */
export const PAINT_STYLE =
	'Wet ink wash dissolving into mist: bleeding washes and a few dark brush marks, the forms half there, melting into pale clouds of wash. Little detail. ' +
	'One ink only, black, on plain off-white paper. Expressive and imprecise, large areas of empty paper. No text, no letters, no signature, no borders, no frame.';

export const DEFAULT_SETTINGS: JeongSettings = {
	journalFolder: 'spaces/jeong',
	liveMode: 'hybrid',
	ollamaUrl: 'http://localhost:11434',
	storyModel: 'granite4:tiny-h',
	autoProcessLoose: true,
	theme: 'obsidian',
	comfyUrl: 'http://127.0.0.1:8188',
	paintStyle: PAINT_STYLE,
	paintWorkflow: '',
	paintInk: 'cinnabar',
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
			.setName(t('settings.theme.name'))
			.setDesc(t('settings.theme.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('obsidian', t('settings.theme.obsidian'))
					.addOption('light', t('settings.theme.light'))
					.addOption('dark', t('settings.theme.dark'))
					.setValue(this.plugin.settings.theme)
					.onChange(async (value) => {
						this.plugin.settings.theme = value === 'light' || value === 'dark' ? value : 'obsidian';
						this.plugin.applyTheme();
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

		new Setting(containerEl)
			.setName(t('settings.autoProcess.name'))
			.setDesc(t('settings.autoProcess.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoProcessLoose).onChange(async (value) => {
					this.plugin.settings.autoProcessLoose = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t('settings.storyModel.name'))
			.setDesc(t('settings.storyModel.desc'))
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.storyModel)
					.setValue(this.plugin.settings.storyModel)
					.onChange(async (value) => {
						this.plugin.settings.storyModel = value.trim() || DEFAULT_SETTINGS.storyModel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.ollamaUrl.name'))
			.setDesc(t('settings.ollamaUrl.desc'))
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl)
					.setValue(this.plugin.settings.ollamaUrl)
					.onChange(async (value) => {
						this.plugin.settings.ollamaUrl = value.trim() || DEFAULT_SETTINGS.ollamaUrl;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName(t('settings.paint.heading')).setHeading();

		new Setting(containerEl)
			.setName(t('settings.paintStyle.name'))
			.setDesc(t('settings.paintStyle.desc'))
			.addTextArea((text) => {
				text.inputEl.rows = 5;
				text.inputEl.addClass('jeong-settings-wide');
				text
					.setPlaceholder(PAINT_STYLE)
					.setValue(this.plugin.settings.paintStyle)
					.onChange(async (value) => {
						this.plugin.settings.paintStyle = value.trim() || PAINT_STYLE;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(t('settings.paintInk.name'))
			.setDesc(t('settings.paintInk.desc'))
			.addDropdown((dropdown) => {
				for (const ink of Object.keys(INKS) as InkName[]) dropdown.addOption(ink, t(`settings.paintInk.${ink}`));
				dropdown.setValue(this.plugin.settings.paintInk).onChange(async (value) => {
					this.plugin.settings.paintInk = value in INKS ? (value as InkName) : DEFAULT_SETTINGS.paintInk;
					this.plugin.refreshTimelines();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('settings.comfyUrl.name'))
			.setDesc(t('settings.comfyUrl.desc'))
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.comfyUrl)
					.setValue(this.plugin.settings.comfyUrl)
					.onChange(async (value) => {
						this.plugin.settings.comfyUrl = value.trim() || DEFAULT_SETTINGS.comfyUrl;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t('settings.paintWorkflow.name'))
			.setDesc(t('settings.paintWorkflow.desc'))
			.addText((text) =>
				text
					.setPlaceholder('jeong/painting.json')
					.setValue(this.plugin.settings.paintWorkflow)
					.onChange(async (value) => {
						this.plugin.settings.paintWorkflow = value.trim() ? normalizePath(value.trim()) : '';
						await this.plugin.saveSettings();
					}),
			);
	}
}
