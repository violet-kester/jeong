// Jeong in the browser reads and writes your Obsidian vault folder directly, through Chrome's
// File System Access API, so entries land exactly where the plugin puts them and Obsidian (and Obsidian
// Sync) see them as usual. This covers the part of Obsidian's App that Jeong uses: the vault, the
// metadata cache, the file manager, and opening a note (handed to the Obsidian app).

import { TAbstractFile, TFile, TFolder, normalizePath, stringifyYaml } from './obsidian';

type Listener = (...args: unknown[]) => void;

class Events {
	private listeners = new Map<string, Listener[]>();
	on(name: string, listener: Listener): { name: string; listener: Listener } {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
		return { name, listener };
	}
	trigger(name: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(name) ?? []) listener(...args);
	}
}

/** Just enough YAML for Jeong's frontmatter: plain values and simple lists. */
export function parseFrontmatter(content: string): Record<string, unknown> | undefined {
	const block = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
	if (block === undefined) return undefined;
	const result: Record<string, unknown> = {};
	let list: string[] | null = null;
	for (const line of block.split('\n')) {
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && list) {
			list.push(unquote(item[1] ?? ''));
			continue;
		}
		const pair = /^([^:\s][^:]*):\s?(.*)$/.exec(line);
		if (!pair) continue;
		const key = pair[1] ?? '';
		const value = pair[2] ?? '';
		if (value === '') {
			list = [];
			result[key] = list;
		} else {
			list = null;
			result[key] = value === '[]' ? [] : unquote(value);
		}
	}
	return result;
}

function unquote(value: string): string {
	const text = value.trim();
	if (/^".*"$/.test(text)) {
		try {
			return JSON.parse(text) as string;
		} catch {
			return text.slice(1, -1);
		}
	}
	return /^'.*'$/.test(text) ? text.slice(1, -1).replace(/''/g, "'") : text;
}

export class FsVault extends Events {
	private files = new Map<string, TAbstractFile>();
	private urls = new Map<string, string>();
	private cache = new Map<string, { frontmatter?: Record<string, unknown> }>();
	readonly root: TFolder;
	readonly adapter;
	readonly metadataCache;
	readonly fileManager;
	readonly workspace;

	constructor(
		private handle: FileSystemDirectoryHandle,
		/** The vault's name, for opening notes in the Obsidian app. */
		readonly name: string,
	) {
		super();
		this.root = new TFolder('');
		this.files.set('', this.root);
		const vault = this;
		const metadataEvents = new Events();
		this.metadataCache = {
			getFileCache: (file: TFile) => vault.cache.get(file.path) ?? null,
			on: (name: string, listener: Listener) => metadataEvents.on(name, listener),
			trigger: (name: string, ...args: unknown[]) => metadataEvents.trigger(name, ...args),
		};
		this.adapter = {
			exists: async (path: string) => (await vault.handleAt(path)) !== null,
			mkdir: async (path: string) => void (await vault.folderHandle(path, true)),
			read: async (path: string) => {
				const handle = await vault.handleAt(path);
				if (!handle || handle.kind !== 'file') throw new Error(`No file at ${path}`);
				return (await (handle as FileSystemFileHandle).getFile()).text();
			},
			write: async (path: string, text: string) => vault.writeAt(path, text),
			append: async (path: string, text: string) => {
				const handle = await vault.handleAt(path);
				const before = handle && handle.kind === 'file' ? await (await (handle as FileSystemFileHandle).getFile()).text() : '';
				await vault.writeAt(path, before + text);
			},
			list: async (path: string) => {
				const folder = await vault.folderHandle(path, false);
				const files: string[] = [];
				const folders: string[] = [];
				if (folder) {
					for await (const [name, child] of folder.entries()) (child.kind === 'file' ? files : folders).push(normalizePath(`${path}/${name}`));
				}
				return { files, folders };
			},
		};
		this.fileManager = {
			processFrontMatter: async (file: TFile, change: (fm: Record<string, unknown>) => void) => {
				const content = await vault.read(file);
				const fm = parseFrontmatter(content) ?? {};
				change(fm);
				const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
				await vault.modify(file, `---\n${stringifyYaml(fm)}---\n${body.startsWith('\n') ? body : `\n${body}`}`);
			},
			renameFile: async (file: TAbstractFile, newPath: string) => vault.rename(file, normalizePath(newPath)),
			trashFile: async (file: TAbstractFile) => vault.remove(file),
		};
		this.workspace = {
			// Notes open in the Obsidian app itself
			getLeaf: () => ({
				openFile: async (file: TFile) => {
					location.href = `obsidian://open?vault=${encodeURIComponent(vault.name)}&file=${encodeURIComponent(file.path)}`;
				},
			}),
			on: () => ({}),
			revealLeaf: async () => {},
			getLeavesOfType: () => [],
		};
	}

	/** Reads the journal folder (and only that) into memory: its files, frontmatter, and photos. */
	async load(folder: string): Promise<void> {
		const path = normalizePath(folder);
		const handle = await this.folderHandle(path, true);
		if (!handle) return;
		await this.walk(handle, this.ensureFolder(path));
	}

	private async walk(handle: FileSystemDirectoryHandle, folder: TFolder): Promise<void> {
		for await (const [name, child] of handle.entries()) {
			const path = normalizePath(`${folder.path}/${name}`);
			if (child.kind === 'directory') {
				// Jeong's hidden metrics folder isn't part of the journal
				if (name.startsWith('.')) continue;
				await this.walk(child as FileSystemDirectoryHandle, this.ensureFolder(path));
			} else {
				const file = this.attach(new TFile(path));
				const data = await (child as FileSystemFileHandle).getFile();
				if (file.extension === 'md') this.cache.set(path, { frontmatter: parseFrontmatter(await data.text()) });
				else this.urls.set(path, URL.createObjectURL(data));
			}
		}
	}

	// ---- Obsidian's vault ----

	getMarkdownFiles(): TFile[] {
		return [...this.files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md');
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(normalizePath(path)) ?? null;
	}

	getResourcePath(file: TFile): string {
		return this.urls.get(file.path) ?? '';
	}

	async createFolder(path: string): Promise<TFolder> {
		await this.folderHandle(path, true);
		return this.ensureFolder(normalizePath(path));
	}

	async create(path: string, text: string): Promise<TFile> {
		await this.writeAt(path, text);
		const file = this.attach(new TFile(normalizePath(path)));
		this.indexText(file, text);
		this.trigger('create', file);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		await this.writeAt(path, data);
		const file = this.attach(new TFile(normalizePath(path)));
		this.urls.set(file.path, URL.createObjectURL(new Blob([data], { type: mimeFor(file.extension) })));
		this.trigger('create', file);
		return file;
	}

	async read(file: TFile): Promise<string> {
		return this.adapter.read(file.path);
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async modify(file: TFile, text: string): Promise<void> {
		await this.writeAt(file.path, text);
		this.indexText(file, text);
		this.trigger('modify', file);
	}

	async process(file: TFile, change: (content: string) => string): Promise<string> {
		const next = change(await this.read(file));
		await this.modify(file, next);
		return next;
	}

	// ---- Behind the scenes ----

	private indexText(file: TFile, text: string): void {
		if (file.extension !== 'md') return;
		this.cache.set(file.path, { frontmatter: parseFrontmatter(text) });
		this.metadataCache.trigger('changed', file);
	}

	private ensureFolder(path: string): TFolder {
		const existing = this.files.get(path);
		if (existing instanceof TFolder) return existing;
		return this.attach(new TFolder(path)) as TFolder;
	}

	private attach<T extends TAbstractFile>(file: T): T {
		const existing = this.files.get(file.path);
		if (existing) return existing as T;
		const parentPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
		const parent = this.ensureFolder(parentPath);
		file.parent = parent === file ? null : parent;
		if (file.parent && !file.parent.children.includes(file)) file.parent.children.push(file);
		this.files.set(file.path, file);
		return file;
	}

	private async handleAt(path: string): Promise<FileSystemHandle | null> {
		const parts = normalizePath(path).split('/').filter(Boolean);
		const name = parts.pop();
		const folder = await this.folderHandle(parts.join('/'), false);
		if (!folder || !name) return folder;
		try {
			return await folder.getFileHandle(name);
		} catch {
			try {
				return await folder.getDirectoryHandle(name);
			} catch {
				return null;
			}
		}
	}

	private async folderHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
		let folder = this.handle;
		for (const part of normalizePath(path).split('/').filter(Boolean)) {
			try {
				folder = await folder.getDirectoryHandle(part, { create });
			} catch {
				return null;
			}
		}
		return folder;
	}

	private async writeAt(path: string, data: string | ArrayBuffer): Promise<void> {
		const parts = normalizePath(path).split('/');
		const name = parts.pop() ?? '';
		const folder = await this.folderHandle(parts.join('/'), true);
		if (!folder) throw new Error(`Can't make the folder for ${path}`);
		const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
		await writable.write(data);
		await writable.close();
	}

	/** Moves a file or folder by copying it and removing the original, then fixes links that pointed at it. */
	private async rename(file: TAbstractFile, newPath: string): Promise<void> {
		const oldPath = file.path;
		if (oldPath === newPath) return;
		if (file instanceof TFolder) {
			await this.folderHandle(newPath, true);
			for (const child of [...file.children]) await this.rename(child, `${newPath}/${child.name}`);
			await this.removeEntry(oldPath);
			this.files.delete(oldPath);
			file.parent?.children.splice(file.parent.children.indexOf(file), 1);
			file.path = newPath;
			this.attach(file);
			// Embeds in Jeong's notes use full paths; point them at the new folder
			for (const note of this.getMarkdownFiles().filter((note) => note.path.startsWith(`${newPath}/`))) {
				await this.process(note as TFile, (content) => content.split(`${oldPath}/`).join(`${newPath}/`));
			}
			return;
		}
		const handle = await this.handleAt(oldPath);
		if (!handle || handle.kind !== 'file') return;
		const data = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
		await this.writeAt(newPath, data);
		await this.removeEntry(oldPath);
		this.files.delete(oldPath);
		file.parent?.children.splice(file.parent.children.indexOf(file), 1);
		const cached = this.cache.get(oldPath);
		const url = this.urls.get(oldPath);
		this.cache.delete(oldPath);
		this.urls.delete(oldPath);
		file.path = newPath;
		this.attach(file);
		if (cached) this.cache.set(newPath, cached);
		if (url) this.urls.set(newPath, url);
		// Links by name ([[Old title]], [[Old title (transcript)|…]]) follow a renamed note
		const oldName = oldPath.split('/').pop()?.replace(/\.md$/, '');
		const newName = (file as TFile).basename;
		if (oldName && oldName !== newName && file.parent) {
			for (const note of file.parent.children.filter((child): child is TFile => child instanceof TFile && child.extension === 'md')) {
				await this.process(note, (content) => content.split(`[[${oldName}]]`).join(`[[${newName}]]`).split(`[[${oldName}|`).join(`[[${newName}|`).split(`[[${oldName} (`).join(`[[${newName} (`));
			}
		}
		this.trigger('rename', file, oldPath);
	}

	private async remove(file: TAbstractFile): Promise<void> {
		await this.removeEntry(file.path);
		this.files.delete(file.path);
		file.parent?.children.splice(file.parent.children.indexOf(file), 1);
		this.trigger('delete', file);
	}

	private async removeEntry(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		const name = parts.pop() ?? '';
		const folder = await this.folderHandle(parts.join('/'), false);
		await folder?.removeEntry(name, { recursive: true });
	}
}

function mimeFor(extension: string): string {
	return (
		{ svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', webm: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg' }[extension] ??
		'application/octet-stream'
	);
}
