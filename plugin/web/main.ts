// Jeong in the browser: the plugin's own timeline and recording window, running in Chrome on this
// computer, reading and writing your Obsidian vault folder. Served from this computer (npm run web), so it
// works offline; the speech models run in Chrome and the stories come from Ollama, both on this computer.
// With ?demo it runs on a sample journal kept inside the browser instead, and never touches your vault.

import { Platform, WorkspaceLeaf, moment } from './obsidian';
import { FsVault } from './vault';
import { seedDemo } from './demo';
import { TimelineView } from '../src/ui/timeline-view';
import { RecordModal } from '../src/ui/record-modal';
import { DEFAULT_SETTINGS, type JeongSettings } from '../src/settings';
import { Metrics } from '../src/metrics/metrics';
import { Ollama } from '../src/compose/ollama';

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
	screen.createDiv({ cls: 'jeong-web-mark', text: '정' });
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
	const settings = await loadSettings(handle);
	const vault = new FsVault(handle, name);
	await vault.load(settings.journalFolder);
	const app = { vault, metadataCache: vault.metadataCache, fileManager: vault.fileManager, workspace: vault.workspace };
	(window as unknown as { app: unknown }).app = app;

	document.body.toggleClass('jeong-theme-light', settings.theme === 'light');
	document.body.toggleClass('jeong-theme-dark', settings.theme === 'dark');

	const metrics = new Metrics(app, () => settings.journalFolder, 'web');
	const ollama = new Ollama(
		() => settings.ollamaUrl,
		() => settings.storyModel,
	);
	const plugin = {
		app,
		settings,
		openRecorder: () => new RecordModal(app, metrics, { liveMode: settings.liveMode, journalFolder: settings.journalFolder, ollama }).open(),
	};

	const view = new TimelineView(new WorkspaceLeaf(), plugin as never);
	view.containerEl.setAttribute('data-type', view.getViewType());
	document.body.prepend(view.containerEl);
	await view.onOpen();
	window.addEventListener('resize', () => view.onResize());
	if (params.has('record')) plugin.openRecorder();
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
