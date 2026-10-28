// Jeong in the browser: the plugin's own timeline and recording window, running in Chrome on this
// computer, reading and writing your Obsidian vault folder. Served from this computer (npm run web), so it
// works offline; the speech models run in Chrome and the stories come from Ollama, both on this computer.
// With ?demo it runs on a sample journal kept inside the browser instead, and never touches your vault.

import { Platform, WorkspaceLeaf, moment, setIcon } from './obsidian';
import { FsVault } from './vault';
import { seedDemo } from './demo';
import { TimelineView } from '../src/ui/timeline-view';
import { RecordModal, type RecordModalOptions } from '../src/ui/record-modal';
import { DEFAULT_SETTINGS, type JeongSettings, type JeongTheme } from '../src/settings';
import { Metrics } from '../src/metrics/metrics';
import { Ollama } from '../src/compose/ollama';
import { Painter } from '../src/paint/painter';
import { addIcons } from '../src/ui/icons';
import mark from '../../jeong-logo-card.svg';

declare const JEONG_DEMO: boolean;

const params = new URLSearchParams(location.search);

void start();

async function start(): Promise<void> {
	moment.locale(navigator.language);
	document.body.addClass(matchMedia('(prefers-color-scheme: dark)').matches ? 'theme-dark' : 'theme-light');
	if (Platform.isMobile) document.body.addClass('is-mobile');
	// A stand-in for Obsidian's floating phone toolbar, to see what it covers (?phone in a desktop browser)
	if (params.has('phone') && !/iPhone|Android/.test(navigator.userAgent)) document.body.createDiv({ cls: 'mobile-navbar' });

	if (JEONG_DEMO) {
		const handle = await seedDemo();
		await open(handle, 'Demo');
		return;
	}
	const remembered = await rememberedVault();
	welcome(remembered);
}

/** The first screen: choose the vault folder, or carry on with the one chosen last time. */
function welcome(remembered: FileSystemDirectoryHandle | null): void {
	const screen = document.body.createDiv({ cls: 'jeong jeong-web-welcome' });
	screen.createDiv({ cls: 'jeong-web-mark' }).append(logo());
	screen.createEl('h1', { text: 'Jeong' });
	screen.createEl('p', { text: 'Your journal lives in your Obsidian vault. Choose the vault folder once, and Jeong will read and write your entries there, all on this computer.' });
	const actions = screen.createDiv({ cls: 'jeong-web-actions' });
	if (remembered) {
		const resume = actions.createEl('button', { cls: 'jeong-button-primary', text: `Open ${remembered.name}` });
		resume.addEventListener('click', async () => {
			if ((await remembered.requestPermission({ mode: 'readwrite' })) === 'granted') {
				screen.remove();
				await open(remembered, remembered.name);
			}
		});
	}
	const choose = actions.createEl('button', { cls: remembered ? 'jeong-web-secondary' : 'jeong-button-primary', text: remembered ? 'Choose another folder' : 'Choose my vault folder' });
	choose.addEventListener('click', async () => {
		const handle = await window.showDirectoryPicker({ id: 'jeong-vault', mode: 'readwrite' });
		await rememberVault(handle);
		screen.remove();
		await open(handle, handle.name);
	});
	if (!('showDirectoryPicker' in window)) {
		screen.createEl('p', { cls: 'jeong-web-note', text: 'This needs Chrome or Edge on a computer, which can open a folder on your disk.' });
		choose.disabled = true;
	}
}

async function open(handle: FileSystemDirectoryHandle, name: string): Promise<void> {
	addIcons();
	const settings = await loadSettings(handle);
	const vault = new FsVault(handle, name);
	await vault.load(settings.journalFolder);
	const app = { vault, metadataCache: vault.metadataCache, fileManager: vault.fileManager, workspace: vault.workspace };
	(window as unknown as { app: unknown }).app = app;


	const metrics = new Metrics(app, () => settings.journalFolder, 'web');
	const ollama = new Ollama(
		() => settings.ollamaUrl,
		() => settings.storyModel,
	);
	// In the browser there's no Obsidian keychain, so only the local, keyless models are offered
	const painter = new Painter(app, ollama, metrics, () => settings, () => '');
	const plugin = {
		app,
		settings,
		painter,
		openRecorder: (entry?: RecordModalOptions['entry']) =>
			new RecordModal(app, metrics, { liveMode: settings.liveMode, journalFolder: settings.journalFolder, llm: ollama, painter, paintInk: settings.paintInk, entry }).open(),
		showTheme: (theme: JeongTheme | null) => {
			showTheme(theme ?? settings.theme);
			view.showThemeButton();
		},
	};
	showTheme(savedTheme() ?? settings.theme);

	const view = new TimelineView(new WorkspaceLeaf(), plugin as never);
	view.containerEl.setAttribute('data-type', view.getViewType());
	document.body.prepend(view.containerEl);
	await view.onOpen();
	shareTitleLine(view);
	window.addEventListener('resize', () => view.onResize());
	if (params.has('record')) plugin.openRecorder();
}

/**
 * In the browser there's no Obsidian around the timeline, so Jeong's mark sits beside the tab's title, and on
 * a computer the title moves into the bar: one line for the title, the year, zoom, and Today.
 */
function shareTitleLine(view: TimelineView): void {
	const header = view.containerEl.querySelector('.view-header');
	const title = header?.querySelector('.view-header-title');
	if (!header || !title) return;
	const badge = createSpan({ cls: 'jeong-web-logo' });
	badge.append(logo());
	title.prepend(badge);
	if (Platform.isMobile) return;
	view.containerEl.querySelector('.jeong-timeline-bar')?.prepend(title);
	header.remove();
	view.onResize();
}

/**
 * Light and dark, from the timeline's button. In the browser the choice is remembered, in this browser only;
 * until then it's the plugin's own theme setting.
 */
function showTheme(theme: JeongTheme): void {
	document.body.toggleClass('jeong-theme-light', theme === 'light');
	document.body.toggleClass('jeong-theme-dark', theme === 'dark');
	try {
		if (theme === 'light' || theme === 'dark') localStorage.setItem(THEME_KEY, theme);
	} catch {
		// private window: it just isn't remembered
	}
}

function savedTheme(): JeongTheme | null {
	try {
		const saved = localStorage.getItem(THEME_KEY);
		return saved === 'light' || saved === 'dark' ? saved : null;
	} catch {
		return null;
	}
}

const THEME_KEY = 'jeong-web-theme';

/** Jeong's logo, the tall hwatu card, as an element. */
function logo(): Element {
	return new DOMParser().parseFromString(mark, 'image/svg+xml').documentElement;
}

/** The plugin's own settings, from the vault (so the browser uses the same journal folder and model). */
async function loadSettings(handle: FileSystemDirectoryHandle): Promise<JeongSettings> {
	try {
		const obsidian = await handle.getDirectoryHandle('.obsidian');
		const plugins = await obsidian.getDirectoryHandle('plugins');
		const jeong = await plugins.getDirectoryHandle('jeong');
		const data = JSON.parse(await (await (await jeong.getFileHandle('data.json')).getFile()).text()) as Partial<JeongSettings>;
		return { ...DEFAULT_SETTINGS, ...data };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

// Chrome can remember a folder the person chose, between visits, in IndexedDB
function database(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('jeong-web', 1);
		request.onupgradeneeded = () => request.result.createObjectStore('handles');
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function rememberVault(handle: FileSystemDirectoryHandle): Promise<void> {
	const db = await database();
	db.transaction('handles', 'readwrite').objectStore('handles').put(handle, 'vault');
}

async function rememberedVault(): Promise<FileSystemDirectoryHandle | null> {
	try {
		const db = await database();
		return await new Promise((resolve) => {
			const request = db.transaction('handles').objectStore('handles').get('vault');
			request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
			request.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}
