// A small stand-in for Obsidian's API, so the plugin's real views and windows run in a browser
// (Jeong in the browser: npm run web). Only what Jeong uses is here. The vault itself is in vault.ts.

import momentLib from 'moment';
import { createElement, icons } from 'lucide';

export const moment = momentLib;

// ---- Obsidian's helpers on DOM elements ----

interface ElementInfo {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
	type?: string;
}

function build<K extends keyof HTMLElementTagNameMap>(tag: K, info?: ElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	const options = typeof info === 'string' ? { cls: info } : (info ?? {});
	if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
	if (options.text !== undefined) el.textContent = options.text;
	if (options.type) el.setAttribute('type', options.type);
	for (const [name, value] of Object.entries(options.attr ?? {})) if (value !== null && value !== false) el.setAttribute(name, value === true ? '' : String(value));
	callback?.(el);
	return el;
}

declare global {
	interface Node {
		createEl<K extends keyof HTMLElementTagNameMap>(tag: K, info?: ElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
		createDiv(info?: ElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
		createSpan(info?: ElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
		createSvg<K extends keyof SVGElementTagNameMap>(tag: K, info?: ElementInfo | string): SVGElementTagNameMap[K];
		empty(): void;
	}
	interface Element {
		addClass(...classes: string[]): void;
		removeClass(...classes: string[]): void;
		toggleClass(cls: string, value: boolean): void;
		hasClass(cls: string): boolean;
		setText(text: string): void;
		getText(): string;
		setAttr(name: string, value: string | number | boolean | null): void;
	}
	interface HTMLElement {
		hide(): void;
		show(): void;
	}
	function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, info?: ElementInfo | string): HTMLElementTagNameMap[K];
	function createDiv(info?: ElementInfo | string): HTMLDivElement;
	function createSpan(info?: ElementInfo | string): HTMLSpanElement;
}

Node.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(this: Node, tag: K, info?: ElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void) {
	return this.appendChild(build(tag, info, callback));
};
Node.prototype.createDiv = function (this: Node, info?: ElementInfo | string, callback?: (el: HTMLDivElement) => void) {
	return this.createEl('div', info, callback);
};
Node.prototype.createSpan = function (this: Node, info?: ElementInfo | string, callback?: (el: HTMLSpanElement) => void) {
	return this.createEl('span', info, callback);
};
Node.prototype.createSvg = function <K extends keyof SVGElementTagNameMap>(this: Node, tag: K, info?: ElementInfo | string) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	const options = typeof info === 'string' ? { cls: info } : (info ?? {});
	if (options.cls) el.setAttribute('class', Array.isArray(options.cls) ? options.cls.join(' ') : options.cls);
	for (const [name, value] of Object.entries(options.attr ?? {})) if (value !== null && value !== false) el.setAttribute(name, String(value));
	return this.appendChild(el);
};
Node.prototype.empty = function (this: Node) {
	while (this.firstChild) this.removeChild(this.firstChild);
};
Element.prototype.addClass = function (this: Element, ...classes: string[]) {
	this.classList.add(...classes);
};
Element.prototype.removeClass = function (this: Element, ...classes: string[]) {
	this.classList.remove(...classes);
};
Element.prototype.toggleClass = function (this: Element, cls: string, value: boolean) {
	this.classList.toggle(cls, value);
};
Element.prototype.hasClass = function (this: Element, cls: string) {
	return this.classList.contains(cls);
};
HTMLElement.prototype.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
	for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
};
Element.prototype.setText = function (this: Element, text: string) {
	this.textContent = text;
};
Element.prototype.getText = function (this: Element) {
	return this.textContent ?? '';
};
Element.prototype.setAttr = function (this: Element, name: string, value: string | number | boolean | null) {
	if (value === null || value === false) this.removeAttribute(name);
	else this.setAttribute(name, value === true ? '' : String(value));
};
HTMLElement.prototype.hide = function (this: HTMLElement) {
	this.style.display = 'none';
};
HTMLElement.prototype.show = function (this: HTMLElement) {
	this.style.display = '';
};
HTMLElement.prototype.isShown = function (this: HTMLElement) {
	return this.style.display !== 'none' && this.isConnected;
};
Object.assign(window, {
	createEl: (tag: keyof HTMLElementTagNameMap, info?: ElementInfo | string) => build(tag, info),
	createDiv: (info?: ElementInfo | string) => build('div', info),
	createSpan: (info?: ElementInfo | string) => build('span', info),
	activeDocument: document,
	activeWindow: window,
});

// ---- Small functions ----

const customIcons = new Map<string, string>();

/** Jeong's own icons (src/ui/icons.ts), drawn on a 100×100 grid like Obsidian's. */
export function addIcon(name: string, svgContent: string): void {
	customIcons.set(name, svgContent);
}

export function setIcon(el: HTMLElement, name: string): void {
	el.empty();
	const custom = customIcons.get(name);
	if (custom) {
		el.innerHTML = `<svg class="svg-icon ${name}" viewBox="0 0 100 100" width="24" height="24">${custom}</svg>`;
		return;
	}
	const key = name.replace(/^lucide-/, '').replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase()) as keyof typeof icons;
	const icon = icons[key];
	if (!icon) return;
	const svg = createElement(icon);
	svg.setAttribute('class', `svg-icon lucide-${name}`);
	el.appendChild(svg);
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function debounce<T extends unknown[]>(fn: (...args: T) => unknown, wait = 0, _resetTimer = false): (...args: T) => void {
	let timer = 0;
	return (...args: T) => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => fn(...args), wait);
	};
}

/** Frontmatter as YAML: plain values where that's safe, quoted otherwise, and lists one item per line. */
export function stringifyYaml(value: Record<string, unknown>): string {
	const scalar = (v: unknown): string => {
		if (typeof v === 'number' || typeof v === 'boolean') return String(v);
		const text = typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
		return text === '' || /: |#|^[\s[\]{}"'&*!|>%@`,?-]|\s$|^(true|false|null|yes|no)$/i.test(text) ? JSON.stringify(text) : text;
	};
	return (
		Object.entries(value)
			.map(([key, v]) => (Array.isArray(v) ? (v.length ? `${key}:\n${v.map((item) => `  - ${scalar(item)}`).join('\n')}` : `${key}: []`) : `${key}: ${scalar(v)}`))
			.join('\n') + '\n'
	);
}

/** Phone or computer: a phone's layout with ?phone in the address (or on an actual phone). */
const phone = new URLSearchParams(location.search).has('phone') || /iPhone|Android/.test(navigator.userAgent);
export const Platform = { isMobile: phone, isDesktopApp: false, isDesktop: !phone, isIosApp: phone, isAndroidApp: false, isWin: /Windows/.test(navigator.userAgent) };

export class Notice {
	constructor(message: string) {
		console.info('Notice:', message);
	}
	setMessage(message: string): this {
		console.info('Notice:', message);
		return this;
	}
	hide(): void {}
}

/** Obsidian's requestUrl, as a fetch. Jeong only uses it for Ollama and ComfyUI, on this computer. */
export async function requestUrl(request: { url: string; method?: string; contentType?: string; body?: string; headers?: Record<string, string>; throw?: boolean }) {
	const response = await fetch(request.url, {
		method: request.method ?? 'GET',
		headers: { ...(request.contentType ? { 'Content-Type': request.contentType } : {}), ...(request.headers ?? {}) },
		body: request.body,
	});
	const arrayBuffer = await response.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);
	if (!response.ok && request.throw !== false) throw new Error(`Request failed, status ${response.status}`);
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Not JSON
	}
	return { status: response.status, text, json, arrayBuffer };
}

// ---- Files ----

export class TAbstractFile {
	parent: TFolder | null = null;
	constructor(public path: string) {}
	get name(): string {
		return this.path.split('/').pop() ?? '';
	}
}

export class TFile extends TAbstractFile {
	get basename(): string {
		return this.name.replace(/\.[^.]+$/, '');
	}
	get extension(): string {
		return this.name.split('.').pop() ?? '';
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

// ---- Views and windows ----

export class Component {
	private cleanups: (() => void)[] = [];
	registerEvent(_ref: unknown): void {}
	registerDomEvent<K extends keyof WindowEventMap>(el: EventTarget, type: K | string, callback: (event: never) => void, options?: AddEventListenerOptions): void {
		el.addEventListener(type, callback as EventListener, options);
		this.cleanups.push(() => el.removeEventListener(type, callback as EventListener, options));
	}
	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}
	load(): void {}
	unload(): void {
		this.cleanups.forEach((cleanup) => cleanup());
	}
}

export class WorkspaceLeaf {
	view: ItemView | null = null;
}

export class ItemView extends Component {
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	app: App;
	constructor(public leaf: WorkspaceLeaf) {
		super();
		this.app = (window as unknown as { app: App }).app;
		// The same structure as an Obsidian tab: a header strip, then the view's content
		this.containerEl = createDiv({ cls: 'workspace-leaf-content' });
		const header = this.containerEl.createDiv({ cls: 'view-header' });
		header.createDiv({ cls: 'view-header-title', text: 'Jeong timeline' });
		this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
	}
	onResize(): void {}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

export class Modal extends Component {
	app: App;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	contentEl: HTMLElement;
	titleEl: HTMLElement;
	constructor(app: App) {
		super();
		this.app = app;
		// The same structure as an Obsidian pop-up window
		this.containerEl = createDiv({ cls: 'modal-container mod-dim' });
		this.containerEl.createDiv({ cls: 'modal-bg' });
		this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
		const close = this.modalEl.createDiv({ cls: 'modal-close-button' });
		close.addEventListener('click', () => this.close());
		const header = this.modalEl.createDiv({ cls: 'modal-header' });
		this.titleEl = header.createDiv({ cls: 'modal-title' });
		this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
	}
	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}
	open(): void {
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}
	close(): void {
		this.onClose();
		this.containerEl.remove();
		this.unload();
	}
	onOpen(): void {}
	onClose(): void {}
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
/** Markdown, roughly: each paragraph as a <p>, which is all a story needs here. */
export const MarkdownRenderer = {
	async render(_app: unknown, markdown: string, el: HTMLElement): Promise<void> {
		for (const paragraph of markdown.split(/\n\s*\n/)) if (paragraph.trim()) el.createEl('p', { text: paragraph.trim() });
	},
};

// Settings pieces the browser preview never shows
export class SecretComponent {}
export class AbstractInputSuggest<T> {
	protected app: unknown;
	constructor(app: unknown, _inputEl: HTMLInputElement) {
		this.app = app;
	}
	setValue(_value: string): void {}
	close(): void {}
	getSuggestions(_query: string): T[] {
		return [];
	}
}

// The app the preview builds (see app.ts); typed loosely, since it only covers what Jeong uses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type App = any;
