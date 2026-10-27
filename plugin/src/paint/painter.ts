import { App, TFile, normalizePath } from 'obsidian';
import type { ChatResult, Ollama } from '../compose/ollama';
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
- Leave out any setting the entry doesn't describe: no view out of a window, no room, no landscape unless the entry mentions it.
- Don't add details to make it vivid: no extra objects, clutter, steam, smoke, light or effects the entry doesn't mention.
- Make it poetic: you may turn the moment into one quiet visual metaphor, but only by reshaping things the entry mentions (if the entry has steam, the steam can become a river); never by adding something new.
- People are welcome when the moment is about them, as simple figures: say "someone" or "a figure", never a gender unless the entry gives one.
- Describe only what can be seen: no feelings, no colors, no words, no letters, no signs. (It is painted in one ink.)
- Write only the description.`;

const CHECK_RULES = `You compare a description of a picture (DESCRIPTION) with the journal entry it came from (ENTRY).
List every thing in the DESCRIPTION that the ENTRY never mentions: objects, light, steam, smoke, weather, places, clutter. Use the exact words from the DESCRIPTION.
If everything is in the entry, return an empty list.`;

const CHECK_SCHEMA = {
	type: 'object',
	properties: { invented: { type: 'array', items: { type: 'string' } } },
	required: ['invented'],
};

/** Words for the person in the picture; the writer is always there, so these are never invented. */
const PERSON = /^(a |the )?(figure|someone|person|people|man|woman|they|them|their)\b/i;

/**
 * Each painting takes one of these at random, so it's never a centered, literal picture and no two look alike:
 * pressing Illustrate is a small surprise every time.
 */
const COMPOSITIONS = [
	'Seen from directly above, the subject pushed into a lower corner and cut off by the edge of the paper.',
	'An extreme close-up fragment of the subject, enormous, cropped hard by two edges, almost abstract.',
	'The subject very small, low in one third of the sheet, beneath a towering field of turbulent wash.',
	'Almost entirely abstract: open wash and empty paper filling the sheet, only a hint of the subject at one edge.',
	"The subject's shape echoed two or three times, drifting off-center like ripples or moons.",
	'A violent diagonal: the subject and its shadow slicing across the sheet from corner to corner, off balance.',
];

/** Asked of every painting, whatever the style. */
const ARTWORK =
	'A small, striking work of art: expressive, poetic, never literal, never centered, never realistic. ' +
	'Any people are simple, abstract figures with smooth, faceless heads, genderless unless the subject says otherwise. ' +
	'Paint only what the subject mentions: no added scenery, windows, rooms, landscapes or objects; anything not described stays bare paper or abstract wash.';

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
		const entry = story || summary;
		const scene = await this.ollama.chat([
			{ role: 'system', content: SCENE_RULES },
			{ role: 'user', content: `TITLE: ${title}\n\nENTRY:\n${entry}` },
		]);
		this.logLlm('scene', scene);
		// Small models add things to make a picture vivid (steam from a cold drink, a lamp, clutter). A check lists them;
		// Jeong keeps only the ones really missing from the entry, then drops each clause that holds one
		const check = await this.ollama.chat(
			[
				{ role: 'system', content: CHECK_RULES },
				{ role: 'user', content: `ENTRY:\n${entry}\n\nDESCRIPTION:\n${scene.content}` },
			],
			{ schema: CHECK_SCHEMA },
		);
		this.logLlm('scene-check', check);
		const flagged = parseList(check.content).filter((thing) => !PERSON.test(thing.trim()) && !mentioned(thing, entry));
		return withoutClauses(scene.content, flagged) || title;
	}

	private logLlm(task: string, result: ChatResult): void {
		this.metrics.log({
			event: 'llm',
			task,
			model: result.model,
			promptTokens: result.promptTokens,
			outputTokens: result.outputTokens,
			ms: Math.round(result.ms),
			tokensPerSecond: Math.round((result.outputTokens / Math.max(1, result.ms)) * 1000 * 10) / 10,
		});
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

/** True when the entry mentions the thing: any of its longer words appears in the entry. */
function mentioned(thing: string, entry: string): boolean {
	const text = entry.toLowerCase();
	return words(thing).some((word) => text.includes(word));
}

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
}

/** The description without any clause that names a flagged thing. */
function withoutClauses(description: string, flagged: string[]): string {
	if (!flagged.length) return description.trim();
	const bad = new Set(flagged.flatMap(words));
	const clauses = description.split(/[,.;:]|\s(?=with |while |as )/).map((clause) => clause.trim()).filter(Boolean);
	const kept = clauses.filter((clause) => !words(clause).some((word) => bad.has(word)));
	return kept.length ? `${kept.join(', ')}.` : '';
}

function parseList(json: string): string[] {
	try {
		const { invented } = JSON.parse(json) as { invented?: unknown };
		return Array.isArray(invented) ? invented.filter((thing): thing is string => typeof thing === 'string') : [];
	} catch {
		return [];
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
