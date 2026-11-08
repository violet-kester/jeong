// An in-memory vault with the parts of Obsidian's App that capture uses. `failOn` makes a chosen write throw,
// and files can be held back to act like sync delivering them late.
import './dom-stub';
import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import { parseFrontmatter } from '../web/vault';

type Stored = string | ArrayBuffer;

export class FakeVault {
	readonly files = new Map<string, TFile | TFolder>();
	readonly data = new Map<string, Stored>();
	readonly trashed: string[] = [];
	writes = 0;
	failOn: ((action: string, path: string) => boolean) | null = null;
	/** Pretend the metadata cache hasn't caught up on these paths. */
	uncached = new Set<string>();

	constructor() {
		this.files.set('', new TFolder(''));
	}

	private check(action: string, path: string): void {
		if (this.failOn?.(action, path)) throw new Error(`Failed: ${action} ${path}`);
	}

	private attach(path: string, file: TFile | TFolder): void {
		const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (!this.files.has(parentPath)) this.makeFolder(parentPath);
		const parent = this.files.get(parentPath) as TFolder;
		file.parent = parent;
		parent.children.push(file);
		this.files.set(path, file);
	}

	makeFolder(path: string): TFolder {
		const folder = new TFolder(path);
		this.attach(path, folder);
		return folder;
	}

	private put(path: string, data: Stored): TFile {
		const clean = normalizePath(path);
		this.writes++;
		const file = (this.files.get(clean) as TFile | undefined) ?? new TFile(clean);
		if (!this.files.has(clean)) this.attach(clean, file);
		this.data.set(clean, data);
		(file as unknown as { stat: { size: number } }).stat = { size: typeof data === 'string' ? data.length : data.byteLength };
		return file;
	}

	/** Drops a file in place, as if sync delivered it. */
	deliver(path: string, data: Stored): TFile {
		return this.put(path, data);
	}

	/** Takes a file away, as if sync hasn't delivered it yet; returns it to hand back later. */
	withhold(path: string): Stored {
		const file = this.files.get(path) as TFile;
		const data = this.data.get(path) as Stored;
		(file.parent as TFolder).children = (file.parent as TFolder).children.filter((child) => child !== file);
		this.files.delete(path);
		this.data.delete(path);
		return data;
	}

	names(folder: string): string[] {
		const found = this.files.get(folder);
		return found instanceof TFolder ? found.children.map((child) => child.name).sort() : [];
	}

	notes(): TFile[] {
		return [...this.files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md');
	}

	text(path: string): string {
		return this.data.get(path) as string;
	}

	readonly app = {
		vault: {
			getAbstractFileByPath: (path: string) => this.files.get(normalizePath(path)) ?? null,
			getMarkdownFiles: () => this.notes(),
			createFolder: async (path: string) => this.makeFolder(normalizePath(path)),
			create: async (path: string, text: string) => {
				this.check('create', path);
				return this.put(path, text);
			},
			createBinary: async (path: string, data: ArrayBuffer) => {
				this.check('createBinary', path);
				return this.put(path, data);
			},
			modifyBinary: async (file: TFile, data: ArrayBuffer) => {
				this.check('modifyBinary', file.path);
				this.put(file.path, data);
			},
			read: async (file: TFile) => this.data.get(file.path) as string,
			readBinary: async (file: TFile) => this.data.get(file.path) as ArrayBuffer,
			process: async (file: TFile, change: (content: string) => string) => {
				this.check('process', file.path);
				const next = change(this.data.get(file.path) as string);
				this.put(file.path, next);
				return next;
			},
		},
		metadataCache: {
			getFileCache: (file: TFile) => {
				if (this.uncached.has(file.path)) return null;
				return { frontmatter: parseFrontmatter(this.data.get(file.path) as string) };
			},
		},
		fileManager: {
			trashFile: async (file: TFile | TFolder) => {
				this.check('trash', file.path);
				const remove = (target: TFile | TFolder) => {
					if (target instanceof TFolder) [...target.children].forEach((child) => remove(child as TFile | TFolder));
					this.files.delete(target.path);
					this.data.delete(target.path);
					this.trashed.push(target.path);
					if (target.parent) target.parent.children = target.parent.children.filter((child) => child !== target);
				};
				remove(file);
			},
			processFrontMatter: async (file: TFile, change: (fm: Record<string, unknown>) => void) => {
				this.check('frontmatter', file.path);
				const content = this.data.get(file.path) as string;
				const fm = parseFrontmatter(content) ?? {};
				change(fm);
				const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
				const { stringifyYaml } = await import('obsidian');
				this.put(file.path, `---\n${stringifyYaml(fm)}---\n${body}`);
			},
		},
	} as unknown as App;
}
