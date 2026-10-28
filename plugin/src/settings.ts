import { App, PluginSettingTab, SecretComponent, Setting, normalizePath } from 'obsidian';
import type JeongPlugin from './main';
import { INKS, type InkName } from './paint/ink';
import type { StoryProvider } from './compose/language-model';
import { FolderSuggest } from './ui/folder-suggest';
import { t } from './i18n';

export interface JeongSettings {
	journalFolder: string;
	/** How the words you see while you talk are written. */
	liveMode: LiveMode;
	/** Who writes stories and summaries: Ollama on this computer, or Claude or OpenAI with the person's own key. */
	storyProvider: StoryProvider;
	/** Where Ollama runs (on this computer). */
	ollamaUrl: string;
	/** The Ollama model that writes stories and summaries. */
	storyModel: string;
	/** The Ollama model that looks at an entry's photos, so a painting can take cues from them. */
	photoModel: string;
	/** The name of the Anthropic API key in Obsidian's keychain (never the key itself). */
	claudeKey: string;
	claudeModel: string;
	/** The name of the OpenAI API key in Obsidian's keychain (never the key itself). */
	openaiKey: string;
	openaiModel: string;
	/** On a computer, write up phone recordings automatically when they arrive. */
	autoProcessLoose: boolean;
	/** Jeong's own light or dark colors, or whatever Obsidian uses. */
	theme: JeongTheme;
	/** Who paints: ComfyUI on this computer, or OpenAI's or xAI's image API with the person's own key. */
	paintProvider: 'comfyui' | 'openai' | 'xai';
	/** The name of the xAI API key in Obsidian's keychain (never the key itself). */
	xaiKey: string;
	openaiImageModel: string;
	xaiImageModel: string;
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
 * A raw expressionist woodcut: jagged gouged lines, the whole sheet carved, its fill made from the scene's own
 * textures (no swirls, steam or smoke unless the scene has them). How people look is asked separately (see
 * painter.ts), since photos can show it. Black ink only, because
 * the model holds to one color reliably only in black; Jeong shows it in the ink color from settings.
 */
export const PAINT_STYLE =
	'Expressionist woodcut: jagged gouged lines and harsh solid shapes, raw, graphic and full of energy, carved by hand, never neat, never a clean drawing. ' +
	'The whole sheet is alive with carved marks: the space around the subject is cut into expressive patterns made from the textures in the scene itself, its surfaces, weather, light and movement. ' +
	'No swirls unless something in the scene swirls; no steam or smoke unless the scene has them. Strong solid blacks against bold whites, high contrast. ' +
	'One ink only, black, on plain off-white paper. No text, no letters, no words, no signature, no initials, no borders, no frame.';

/** Earlier built-in styles: a vault that still has one of these, unedited, gets the current one. */
export const OLD_PAINT_STYLES = [
	'Expressionist woodcut: jagged gouged lines and harsh solid shapes, raw, graphic and full of energy, carved by hand, never neat, never a clean drawing. ' +
		'The whole sheet is alive with carved marks: the space around the subject is cut into expressive patterns made from the textures in the scene itself, its surfaces, weather, light and movement. ' +
		'No swirls unless something in the scene swirls; no steam or smoke unless the scene has them. Strong solid blacks against bold whites, high contrast. ' +
		'Any person has a blank, faceless head and no sign of gender. ' +
		'One ink only, black, on plain off-white paper. No text, no letters, no words, no signature, no initials, no borders, no frame.',
	'Expressionist woodcut in the spirit of Edvard Munch, full of energy: bold gouged lines and confident solid shapes, carved by hand, loose and alive, never neat, never a clean drawing. ' +
		'The whole sheet is alive with carved marks. The space around the subject is filled with expressive rhythmic patterns made from the scene itself: ' +
		'rain becomes slanting cuts, a road becomes rippling grain, steam becomes rising ribbons, a tablecloth becomes its weave, light becomes radiating strokes. ' +
		'Use swirls only where something really swirls. Strong solid blacks against bold whites, high contrast. ' +
		'Any person has a blank, faceless head and no sign of gender. ' +
		'One ink only, black, on plain off-white paper. No text, no letters, no words, no signature, no borders, no frame.',
	'Expressionist woodcut, full of energy: bold gouged lines and confident solid shapes, loose and alive, never neat. ' +
		'Strong solid blacks against bold bare whites, high contrast. Every gouge follows the form it describes: ' +
		'the grain of wood, the weave of cloth, the fall of rain, the edge of a shadow. No decorative swirls or ' +
		'patterns to fill space; wide areas of plain bare paper are welcome. ' +
		'Any face is a blank shape: no eyes, no nose, no mouth. ' +
		'One ink only, black, on plain off-white paper. No text, no letters, no signature, no borders, no frame.',
	'Expressionist woodcut: jagged gouged lines and harsh solid shapes, raw and urgent, never neat. ' +
		'Strong solid blacks against bold bare whites, high contrast. Every gouge follows the form it describes: ' +
		'the grain of wood, the weave of cloth, the fall of rain, the edge of a shadow. No decorative swirls or ' +
		'patterns to fill space; wide areas of plain bare paper are welcome. ' +
		'Any face is a blank shape: no eyes, no nose, no mouth. ' +
		'One ink only, black, on plain off-white paper. No text, no letters, no signature, no borders, no frame.',
	'Expressionist woodcut: jagged gouged lines and harsh solid shapes, raw, urgent and wild, never neat; swirling, undulating lines ' +
		'in the spirit of Edvard Munch trembling through the whole sheet. Strong solid blacks against bold bare whites, high contrast. ' +
		'Any face is a blank shape: no eyes, no nose, no mouth. ' +
		'One ink only, black, on plain off-white paper. No text, no letters, no signature, no borders, no frame.',
];

export const DEFAULT_SETTINGS: JeongSettings = {
	journalFolder: 'spaces/jeong',
	liveMode: 'hybrid',
	storyProvider: 'ollama',
	ollamaUrl: 'http://localhost:11434',
	storyModel: 'granite4:tiny-h',
	photoModel: 'granite3.2-vision',
	claudeKey: '',
	claudeModel: 'claude-opus-5-5',
	openaiKey: '',
	openaiModel: 'gpt-5',
	autoProcessLoose: true,
	theme: 'obsidian',
	paintProvider: 'comfyui',
	xaiKey: '',
	openaiImageModel: 'gpt-image-1',
	xaiImageModel: 'grok-2-image',
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
			.addText((text) => {
				new FolderSuggest(this.app, text.inputEl);
				text
					.setPlaceholder(DEFAULT_SETTINGS.journalFolder)
					.setValue(this.plugin.settings.journalFolder)
					.onChange(async (value) => {
						this.plugin.settings.journalFolder = normalizePath(value || DEFAULT_SETTINGS.journalFolder);
						await this.plugin.saveSettings();
					});
			});

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
						// The timeline's light and dark button gives way to the new default
						this.plugin.showTheme(null);
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
			.setName(t('settings.storyProvider.name'))
			.setDesc(t('settings.storyProvider.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('ollama', t('settings.storyProvider.ollama'))
					.addOption('claude', t('settings.storyProvider.claude'))
					.addOption('openai', t('settings.storyProvider.openai'))
					.setValue(this.plugin.settings.storyProvider)
					.onChange(async (value) => {
						this.plugin.settings.storyProvider = value === 'claude' || value === 'openai' ? value : 'ollama';
						await this.plugin.saveSettings();
						// Show the fields for the chosen writer
						this.display();
					}),
			);

		const provider = this.plugin.settings.storyProvider;
		if (provider === 'ollama') {
			this.textSetting('storyModel', t('settings.storyModel.name'), t('settings.storyModel.desc'));
			this.textSetting('photoModel', t('settings.photoModel.name'), t('settings.photoModel.desc'));
			this.textSetting('ollamaUrl', t('settings.ollamaUrl.name'), t('settings.ollamaUrl.desc'));
		} else if (provider === 'claude') {
			this.keySetting('claudeKey', t('settings.claudeKey.desc'));
			this.textSetting('claudeModel', t('settings.cloudModel.name'), t('settings.claudeModel.desc'));
		} else {
			this.keySetting('openaiKey', t('settings.openaiKey.desc'));
			this.textSetting('openaiModel', t('settings.cloudModel.name'), t('settings.openaiModel.desc'));
		}

		new Setting(containerEl).setName(t('settings.paint.heading')).setHeading();

		new Setting(containerEl)
			.setName(t('settings.paintProvider.name'))
			.setDesc(t('settings.paintProvider.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('comfyui', t('settings.paintProvider.comfyui'))
					.addOption('openai', t('settings.paintProvider.openai'))
					.addOption('xai', t('settings.paintProvider.xai'))
					.setValue(this.plugin.settings.paintProvider)
					.onChange(async (value) => {
						this.plugin.settings.paintProvider = value === 'openai' || value === 'xai' ? value : 'comfyui';
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		const painter = this.plugin.settings.paintProvider;

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

		if (painter === 'openai') {
			this.keySetting('openaiKey', t('settings.openaiKey.desc'));
			this.textSetting('openaiImageModel', t('settings.cloudModel.name'), t('settings.openaiImageModel.desc'));
		} else if (painter === 'xai') {
			this.keySetting('xaiKey', t('settings.xaiKey.desc'));
			this.textSetting('xaiImageModel', t('settings.cloudModel.name'), t('settings.xaiImageModel.desc'));
		} else {
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

	/** A text setting that falls back to its default when left empty. */
	private textSetting(key: 'storyModel' | 'photoModel' | 'ollamaUrl' | 'claudeModel' | 'openaiModel' | 'openaiImageModel' | 'xaiImageModel', name: string, desc: string): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS[key])
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS[key];
						await this.plugin.saveSettings();
					}),
			);
	}

	/** An API key, kept in Obsidian's keychain on this device rather than in the vault, where it would sync. */
	private keySetting(key: 'claudeKey' | 'openaiKey' | 'xaiKey', desc: string): void {
		new Setting(this.containerEl)
			.setName(t('settings.apiKey.name'))
			.setDesc(desc)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(this.plugin.settings[key]).onChange(async (value) => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
