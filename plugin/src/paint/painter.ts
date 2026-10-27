import { App, TFile, normalizePath } from 'obsidian';
import type { Ollama } from '../compose/ollama';
import type { Metrics } from '../metrics/metrics';
import { freeName } from '../journal/entry-writer';
import { ComfyUI, type Workflow } from './comfyui';
import { kleinWorkflow } from './klein-workflow';

// Paints a picture for an entry that has no photos, all on this computer:
// Ollama describes one scene from the entry, and ComfyUI paints it in the style from settings.
// The painting is saved in the entry's folder and named in its frontmatter (painting), with the
// scene it was painted from (scene), so it's clear it's a painting and not a photo.

const SCENE_RULES = `You choose one image to paint for someone's journal entry.
- Pick the one or two things that hold the entry's most important moment, and describe them in one or two short sentences, in English.
- Use only things in the entry. Don't invent places, people, weather, or objects, and keep each detail true to the moment (if the rain had stopped, there is no rain).
- Make it poetic: you may turn the moment into one quiet visual metaphor (steam becomes a river, a person becomes the weather), built only from things in the entry.
- People are welcome when the moment is about them, as simple figures: say "someone" or "a figure", never a gender unless the entry gives one.
- Describe only what can be seen: no feelings, no colors, no words, no letters, no signs. (It is painted in one ink.)
- Write only the description.`;

/**
 * Each painting takes one of these at random, so it's never a centered, literal picture and no two look alike:
 * pressing Illustrate is a small surprise every time.
 */
const COMPOSITIONS = [
	'Seen from directly above, the subject pushed into a lower corner and cut off by the edge of the paper.',
	'An extreme close-up fragment of the subject, enormous, cropped hard by two edges, almost abstract.',
	'The subject very small, low in one third of the sheet, beneath a towering field of turbulent wash.',
	'Almost entirely abstract: the air, light or weather of the moment filling the sheet, only a hint of the subject at one edge.',
	"The subject's shape echoed two or three times, drifting off-center like ripples or moons.",
	'A violent diagonal: the subject and its shadow slicing across the sheet from corner to corner, off balance.',
];

/** Asked of every painting, whatever the style. */
const ARTWORK =
	'A small, striking work of art: expressive, poetic, never literal, never centered, never realistic. ' +
	'Any people are simple, abstract figures with smooth, faceless heads, genderless unless the subject says otherwise.';

export type PaintProgress = 'scene' | 'painting' | 'not-ready' | 'done' | 'failed';

export interface PaintSettings {
	comfyUrl: string;
	paintStyle: string;
	/** A workflow exported from ComfyUI (Export (API)), with {{prompt}} where the words go; '' uses FLUX.2 klein. */
	paintWorkflow: string;
}

export class Painter {
	readonly comfy: ComfyUI;
	private busy = new Set<string>();
	/** Entries whose painting just finished and hasn't been shown yet, so the timeline can brush it on. */
	private fresh = new Set<string>();
	private listeners = new Set<() => void>();

	constructor(
		private app: App,
		private ollama: Ollama,
		private metrics: Metrics,
		private settings: () => PaintSettings,
	) {
		this.comfy = new ComfyUI(() => this.settings().comfyUrl);
	}

	/** True while this entry is being painted. */
	isPainting(note: TFile): boolean {
		return this.busy.has(note.path);
	}

	/** True once for an entry whose painting just finished: the timeline shows it being brushed on. */
	takeFresh(note: TFile): boolean {
		return this.fresh.delete(note.path);
	}

	/** Called whenever a painting starts or ends. Returns a function that stops listening. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Paints a picture for the entry, replacing any earlier painting. */
	async paint(note: TFile, onProgress: (progress: PaintProgress) => void = () => {}): Promise<boolean> {
		if (this.busy.has(note.path)) return false;
		if (!(await this.comfy.isReady())) {
			onProgress('not-ready');
			return false;
		}
		this.busy.add(note.path);
		this.changed();
		try {
			onProgress('scene');
			const scene = await this.scene(note);
			onProgress('painting');
			// Style first: the model pays the most attention to the start of the prompt
			const composition = COMPOSITIONS[Math.floor(Math.random() * COMPOSITIONS.length)];
			const prompt = `${this.settings().paintStyle} ${ARTWORK}\n\nComposition: ${composition}\n\nSubject: ${scene}`;
			const png = await this.comfy.paint(await this.workflow(prompt));
			this.fresh.add(note.path);
			await this.save(note, await toJpeg(png), scene);
			onProgress('done');
			return true;
		} catch (error) {
			console.error('Jeong: could not paint', error);
			this.metrics.log({ event: 'error', where: 'paint', message: error instanceof Error ? error.message : String(error) });
			onProgress('failed');
			return false;
		} finally {
			this.busy.delete(note.path);
			this.changed();
		}
	}

	private changed(): void {
		this.listeners.forEach((listener) => listener());
	}

	/** What to paint, from the entry. Without Ollama, the title and summary are the scene. */
	private async scene(note: TFile): Promise<string> {
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
		const title = typeof fm.title === 'string' ? fm.title : note.basename;
		const summary = typeof fm.summary === 'string' ? fm.summary : '';
		const story = storyText(await this.app.vault.cachedRead(note)).slice(0, 6000);
		if (!(await this.ollama.isReady())) return [title, summary].filter(Boolean).join('. ');
		const result = await this.ollama.chat([
			{ role: 'system', content: SCENE_RULES },
			{ role: 'user', content: `TITLE: ${title}\n\nENTRY:\n${story || summary}` },
		]);
		this.metrics.log({
			event: 'llm',
			task: 'scene',
			model: result.model,
			promptTokens: result.promptTokens,
			outputTokens: result.outputTokens,
			ms: Math.round(result.ms),
			tokensPerSecond: Math.round((result.outputTokens / Math.max(1, result.ms)) * 1000 * 10) / 10,
		});
		return result.content || title;
	}

	/** The built-in FLUX.2 klein workflow, or the person's own, with the prompt filled in and a new seed. */
	private async workflow(prompt: string): Promise<Workflow> {
		const seed = Math.floor(Math.random() * 2 ** 48);
		const path = this.settings().paintWorkflow.trim();
		if (!path) return kleinWorkflow(prompt, seed);
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error(`The painting workflow ${path} isn't in the vault`);
		// JSON.stringify(prompt) is the prompt as a JSON string, quotes and all; slice off the quotes to drop it into "{{prompt}}"
		const workflow = JSON.parse((await this.app.vault.read(file)).split('{{prompt}}').join(JSON.stringify(prompt).slice(1, -1))) as Workflow;
		for (const node of Object.values(workflow)) {
			for (const key of ['seed', 'noise_seed']) if (typeof node.inputs[key] === 'number') node.inputs[key] = seed;
		}
		return workflow;
	}

	private async save(note: TFile, jpeg: ArrayBuffer, scene: string): Promise<void> {
		const folder = note.parent;
		if (!folder) throw new Error('The entry has no folder');
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
		const stamp = `${String(fm.date ?? '')} ${String(fm.time ?? '').replace(':', '')}`.trim();
		const name = freeName(this.app, folder.path, `${stamp} painting`, 'jpg');
		await this.app.vault.createBinary(normalizePath(`${folder.path}/${name}`), jpeg);

		const earlier = typeof fm.painting === 'string' ? this.app.vault.getAbstractFileByPath(normalizePath(`${folder.path}/${fm.painting}`)) : null;
		await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
			frontmatter.painting = name;
			frontmatter.scene = scene;
		});
		// A new painting replaces the last one; the old file goes to the trash, so it can still be found
		if (earlier instanceof TFile) await this.app.fileManager.trashFile(earlier);
	}
}

/** The entry's words, without frontmatter, embeds, the links line, or callouts. */
function storyText(content: string): string {
	return content
		.replace(/^---[\s\S]*?---/, '')
		.replace(/!\[\[[^\]]*\]\]/g, '')
		.replace(/^\*\[\[.*\]\]\*$/gm, '')
		.replace(/^>.*$/gm, '')
		.trim();
}

/** ComfyUI saves PNGs; a JPEG is a fraction of the size, which matters when the vault syncs to a phone. */
async function toJpeg(png: ArrayBuffer): Promise<ArrayBuffer> {
	const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
}
