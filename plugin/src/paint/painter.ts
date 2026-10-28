import { App, TFile, normalizePath } from 'obsidian';
import type { ChatResult, LanguageModel } from '../compose/language-model';
import type { Metrics } from '../metrics/metrics';
import { freeName } from '../journal/entry-writer';
import { CloudImages } from './cloud-images';
import { ComfyUI, type Workflow } from './comfyui';
import { kleinWorkflow } from './klein-workflow';

// Paints a picture for an entry that has no photos, on this computer unless a cloud painter is chosen in settings:
// The language model describes one scene from the entry, and ComfyUI paints it in the style from settings.
// The painting is saved in the entry's folder and named in its frontmatter (painting), with the
// scene it was painted from (scene), so it's clear it's a painting and not a photo.

const SCENE_RULES = `You choose one image to paint for someone's journal entry. Think like a poet or a photographer, not an illustrator.
- Find the one detail that holds the entry's most important moment, and an unexpected way to see it, rather than the whole scene told literally.
- Zoom in. A close-up, a fragment, an unusual viewpoint (from just above the ground, from directly above, through a doorway or a window), a shadow or a trace, or one object that stands for the moment. A walk in the park might be shoes on the path seen from low down; morning coffee might be the rim of the cup filling the frame.
- Use only things in the entry, or what the moment plainly holds (the hands holding the cup, the feet doing the walking). Don't invent places, people, weather, or objects, and keep each detail true to the moment (if the rain had stopped, there is no rain).
- Leave out any setting the entry doesn't describe. Name the textures of what is there (the grain of the table, the weave of a sweater, the fall of rain) so the picture can be filled with them.
- Let the picture carry the entry's own feeling, whatever it is; don't bring a mood of your own.
- Make it poetic: you may turn the moment into one visual metaphor, but only by reshaping things the entry mentions (if the entry has steam, the steam can become a river); never by adding something new.
- When a person is part of it, show as little of them as the moment needs: hands, feet, a back, a shadow, or a simple figure. Say "someone" or "a figure". Never give a gender, a skin color, an age, a hairstyle, or anything else that says who they are unless the entry does.
- Describe only what can be seen: no feelings, no colors. Never mention anything with writing on it by what it says (a card, not an invitation; a screen, not a message), and no letters or signs. (It is painted in one ink.)
- Write only the description, in one or two short sentences, in English.`;

const CHECK_RULES = `You compare a description of a picture (DESCRIPTION) with the journal entry it came from (ENTRY).
List every thing in the DESCRIPTION that the ENTRY never mentions: objects, light, steam, smoke, weather, places, clutter. Use the exact words from the DESCRIPTION.
Don't list the person themselves or what the moment plainly holds: their hands, feet, shoes, clothes, back, or shadow, or the viewpoint.
If everything is in the entry, return an empty list.`;

const CHECK_SCHEMA = {
	type: 'object',
	properties: { invented: { type: 'array', items: { type: 'string' } } },
	required: ['invented'],
};

/** Words for the person in the picture and what the moment plainly holds; the writer is always there, so these are never invented. */
const PERSON = /\b(figure|someone|person|people|they|them|their|hands?|fingers?|feet|foot|shoes?|steps?|footsteps|back|shoulders?|arms?|legs?|shadows?|silhouette|clothes|sleeves?)\b/i;

/**
 * Each painting takes one of these at random, so it's never a centered, literal picture and no two look alike:
 * pressing Illustrate is a small surprise every time.
 */
const COMPOSITIONS = [
	'A close-up so near that one small detail fills the sheet, cropped hard by the edges.',
	'Seen from very low, almost at ground level, looking along the ground or up.',
	'Seen from directly above, flattened into shapes and shadows.',
	'A fragment: only part of the subject, the rest carved into its texture.',
	'The subject small, off to one side, in a wide field of carved texture from its surroundings.',
	'Framed through something in the moment: a doorway, a window, a gap, a reflection.',
	'The moment told by a trace it leaves (footprints, a ring left by a cup, crumbs) rather than by the thing itself.',
	'A strong diagonal across the sheet, full of movement.',
];

/** Asked of every painting, whatever the style. */
const ARTWORK =
	'Any people are shown simply, or only in part (hands, feet, a back, a shadow), with smooth, faceless heads, and nothing that says their gender, skin color, or age unless the subject does. ' +
	'A small, striking work of art: expressive, poetic, never literal, never centered, never realistic, never an illustration. ' +
	'Full of energy, in the mood of the moment, whatever it is. ' +
	"Fill the space with carved texture drawn from the subject's own world (its surfaces, weather, light, movement), not generic swirls. " +
	'Paint only what the subject mentions: no added scenery, windows, rooms, landscapes or objects.';

/** How long ComfyUI keeps its models after the last painting. */
const FREE_AFTER_MS = 5 * 60 * 1000;

export type PaintProgress = 'scene' | 'painting' | 'not-ready' | 'done' | 'failed';

export interface PaintSettings {
	/** ComfyUI on this computer, or OpenAI's or xAI's image API with the person's own key. */
	paintProvider: 'comfyui' | 'openai' | 'xai';
	comfyUrl: string;
	/** Names of API keys in Obsidian's keychain. */
	openaiKey: string;
	xaiKey: string;
	openaiImageModel: string;
	xaiImageModel: string;
	paintStyle: string;
	/** A workflow exported from ComfyUI (Export (API)), with {{prompt}} where the words go; '' uses FLUX.2 klein. */
	paintWorkflow: string;
}

export class Painter {
	private comfy: ComfyUI;
	private cloud: CloudImages;
	private busy = new Set<string>();
	/** Entries whose painting just finished and hasn't been shown yet, so the timeline can brush it on. */
	private fresh = new Set<string>();
	private listeners = new Set<() => void>();
	private freeTimer = 0;

	constructor(
		private app: App,
		private llm: LanguageModel,
		private metrics: Metrics,
		private settings: () => PaintSettings,
		secret: (id: string) => string,
	) {
		this.comfy = new ComfyUI(() => this.settings().comfyUrl);
		const cloud = () => (this.settings().paintProvider === 'xai' ? 'xai' : 'openai');
		this.cloud = new CloudImages(
			cloud,
			() => secret(cloud() === 'xai' ? this.settings().xaiKey : this.settings().openaiKey),
			() => (cloud() === 'xai' ? this.settings().xaiImageModel : this.settings().openaiImageModel),
		);
	}

	private get local(): boolean {
		return this.settings().paintProvider === 'comfyui';
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
		if (!(this.local ? await this.comfy.isReady() : this.cloud.isReady())) {
			onProgress('not-ready');
			return false;
		}
		this.busy.add(note.path);
		this.changed();
		// Where the time goes, so a slow painting can be traced to the scene, the painter, or the swap between them
		const started = performance.now();
		let mark = started;
		const lap = () => {
			const now = performance.now();
			const ms = Math.round(now - mark);
			mark = now;
			return ms;
		};
		try {
			onProgress('scene');
			const scene = await this.scene(note);
			const sceneMs = lap();
			// An 8 GB graphics card can't hold the story model and the painting model at once
			await this.llm.unload();
			const unloadMs = lap();
			onProgress('painting');
			// Style first: the model pays the most attention to the start of the prompt
			const composition = COMPOSITIONS[Math.floor(Math.random() * COMPOSITIONS.length)];
			const prompt = `${this.settings().paintStyle} ${ARTWORK}\n\nComposition: ${composition}\n\nSubject: ${scene}`;
			const png = this.local ? await this.comfy.paint(await this.workflow(prompt)) : await this.cloud.paint(prompt);
			const paintMs = lap();
			this.fresh.add(note.path);
			await this.save(note, await toJpeg(png), scene);
			const settings = this.settings();
			this.metrics.log({
				event: 'paint',
				painter: settings.paintProvider,
				model: { comfyui: settings.paintWorkflow || 'flux2-klein', openai: settings.openaiImageModel, xai: settings.xaiImageModel }[settings.paintProvider],
				sceneMs,
				unloadMs,
				paintMs,
				saveMs: lap(),
				ms: Math.round(performance.now() - started),
			});
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
			this.freeWhenIdle();
		}
	}

	/**
	 * Lets ComfyUI free its models once nothing has been painted for a while, like Ollama does, so they don't
	 * hold the computer's memory for hours. The next painting loads them again (10 to 20 seconds).
	 */
	private freeWhenIdle(): void {
		window.clearTimeout(this.freeTimer);
		if (!this.local) return;
		this.freeTimer = window.setTimeout(() => {
			if (!this.busy.size) void this.comfy.free();
		}, FREE_AFTER_MS);
	}

	/** Stops waiting to free ComfyUI's models, when Jeong closes. */
	dispose(): void {
		window.clearTimeout(this.freeTimer);
	}

	private changed(): void {
		this.listeners.forEach((listener) => listener());
	}

	/** What to paint, from the entry. Without a language model, the title and summary are the scene. */
	private async scene(note: TFile): Promise<string> {
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
		const title = typeof fm.title === 'string' ? fm.title : note.basename;
		const summary = typeof fm.summary === 'string' ? fm.summary : '';
		const story = storyText(await this.app.vault.cachedRead(note)).slice(0, 6000);
		if (!(await this.llm.isReady())) return [title, summary].filter(Boolean).join('. ');
		const entry = story || summary;
		const scene = await this.llm.chat([
			{ role: 'system', content: SCENE_RULES },
			{ role: 'user', content: `TITLE: ${title}\n\nENTRY:\n${entry}` },
		]);
		this.logLlm('scene', scene);
		// Small models add things to make a picture vivid (steam from a cold drink, a lamp, clutter). A check lists them;
		// Jeong keeps only the ones really missing from the entry, then drops each clause that holds one
		const check = await this.llm.chat(
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

/** The painters send PNGs; a JPEG is a fraction of the size, which matters when the vault syncs to a phone. */
async function toJpeg(png: ArrayBuffer): Promise<ArrayBuffer> {
	const bitmap = await createImageBitmap(new Blob([png]));
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
}
