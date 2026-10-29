import { App, TFile, normalizePath } from 'obsidian';
import type { ChatResult, LanguageModel } from '../compose/language-model';
import type { Metrics } from '../metrics/metrics';
import { freeName } from '../journal/entry-writer';
import { CloudImages } from './cloud-images';
import { ComfyUI, type Workflow } from './comfyui';
import { ComfyLauncher } from './comfy-launcher';
import { kleinWorkflow } from './klein-workflow';
import { storyText } from '../journal/story-text';

// Paints a picture for an entry that has no photos, on this computer unless a cloud painter is chosen in settings:
// The language model describes one scene from the entry, and ComfyUI paints it in the style from settings.
// The painting is saved in the entry's folder and named in its frontmatter (painting), with the
// scene it was painted from (scene), so it's clear it's a painting and not a photo.

const PHOTO_RULES = `You look at the photos from someone's journal entry and note what the people, animals and things in them look like, so a painter can draw them loosely from memory.
- Each person: hair (length, color, curl), glasses, build, skin tone, notable clothing, and "face visible" if their face can be seen.
- Each animal: what it is, its breed if clear, size, coat color and markings, ears.
- Notable things: their shape and pattern.
- One short line per person, animal or thing. Nothing about the photos' framing, background, setting or mood. No names.`;

/** How many photos are looked at, and how large, for the notes. */
const PHOTOS_SEEN = 3;
const PHOTO_SIZE = 768;

const SCENE_RULES = `You choose one image to paint for someone's journal entry. Think like a poet or a photographer, not an illustrator.
- Find the one detail that holds the entry's most important moment, and an unexpected way to see it, rather than the whole scene told literally.
- Zoom in. A close-up, a fragment, an unusual viewpoint (from just above the ground, from directly above, through a doorway or a window), a shadow or a trace, or one object that stands for the moment. A walk in the park might be shoes on the path seen from low down; morning coffee might be the rim of the cup filling the frame.
- Use only things in the entry, or what the moment plainly holds (the hands holding the cup, the feet doing the walking). Don't invent places, people, weather, or objects, and keep each detail true to the moment (if the rain had stopped, there is no rain).
- Leave out any setting the entry doesn't describe. Name the textures of what is there (the grain of the table, the weave of a sweater, the fall of rain) so the picture can be filled with them.
- Let the picture carry the entry's own feeling, whatever it is; don't bring a mood of your own.
- Make it poetic: you may turn the moment into one visual metaphor, but only by reshaping things the entry mentions (if the entry has steam, the steam can become a river); never by adding something new.
- When a person is part of it, show as little of them as the moment needs: hands, feet, a back, a shadow, or a simple figure. Say "someone" or "a figure". Never give a gender, a skin color, an age, a hairstyle, or anything else that says who they are unless the entry or the photos do.
- PHOTOS, when given, only tell you what the people, animals and things in the moment look like. Draw them that way, loosely (the dog's own coat and ears, someone's curly hair and glasses). Never copy a photo's framing, setting or pose: still find your own poetic way into the moment.
- Describe only what can be seen: no feelings, no colors. Never mention anything with writing on it by what it says (a card, not an invitation; a screen, not a message), and no letters or signs. (It is painted in one ink.)
- Write only the description, in one or two short sentences, in English.`;

const CHECK_RULES = `You compare a description of a picture (DESCRIPTION) with the journal entry it came from (ENTRY).
List every thing in the DESCRIPTION that the ENTRY never mentions: objects, light, steam, smoke, weather, places, clutter. Use the exact words from the DESCRIPTION.
Don't list the person themselves or what the moment plainly holds: their hands, feet, shoes, clothes, back, or shadow, or the viewpoint. Anything the PHOTOS describe counts as in the entry.
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

/** How people look: faceless and nobody in particular, unless the entry's photos show them. */
const FACELESS =
	'Any people are shown simply, or only in part (hands, feet, a back, a shadow), with smooth, faceless heads, and nothing that says their gender, skin color, or age unless the subject does. ';
const FROM_PHOTOS =
	'People and animals in the subject look loosely like the Looks notes below, drawn from memory, never copied from a photo; a person whose face the notes say is visible may have simple features, others stay faceless. ';

/** Asked of every painting, whatever the style; how people look comes first, where the model pays most attention. */
const ARTWORK =
	'A small, striking work of art: expressive, poetic, never literal, never centered, never realistic, never an illustration. ' +
	'Full of energy, in the mood of the moment, whatever it is. ' +
	"Fill the space with carved texture drawn from the subject's own world (its surfaces, weather, light, movement), not generic swirls. " +
	'Paint only what the subject mentions: no added scenery, windows, rooms, landscapes or objects.';

/** How long ComfyUI keeps its models (or, if Jeong started it, keeps running) after the last painting. */
const FREE_AFTER_MS = 5 * 60 * 1000;

export type PaintProgress = 'starting' | 'scene' | 'painting' | 'not-ready' | 'done' | 'failed';

export interface PaintSettings {
	/** ComfyUI on this computer, or OpenAI's or xAI's image API with the person's own key. */
	paintProvider: 'comfyui' | 'openai' | 'xai';
	comfyUrl: string;
	/** On a computer, the command that starts ComfyUI when a painting needs it; '' to start it yourself. */
	comfyCommand: string;
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
	private launcher: ComfyLauncher;
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
		this.launcher = new ComfyLauncher(() => this.settings().comfyCommand, () => this.comfy.isReady());
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
		this.busy.add(note.path);
		this.changed();
		window.clearTimeout(this.freeTimer);
		if (!(await this.ready(onProgress))) {
			onProgress('not-ready');
			this.busy.delete(note.path);
			this.changed();
			return false;
		}
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
			const { scene, photos } = await this.scene(note);
			const sceneMs = lap();
			// An 8 GB graphics card can't hold the story model and the painting model at once
			await this.llm.unload();
			const unloadMs = lap();
			onProgress('painting');
			// Style first: the model pays the most attention to the start of the prompt
			const composition = COMPOSITIONS[Math.floor(Math.random() * COMPOSITIONS.length)];
			// People drawn from the photos' notes when there are any, otherwise faceless and nobody in particular
			const people = photos ? FROM_PHOTOS : FACELESS;
			const looks = photos ? `\n\nLooks (only for whoever and whatever is in the subject): ${photos}` : '';
			const prompt = `${this.settings().paintStyle} ${people}${ARTWORK}\n\nComposition: ${composition}\n\nSubject: ${scene}${looks}`;
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

	/** True when the painter can paint: the cloud key is there, or ComfyUI is running (started now if need be). */
	private async ready(onProgress: (progress: PaintProgress) => void): Promise<boolean> {
		if (!this.local) return this.cloud.isReady();
		if (await this.comfy.isReady()) return true;
		if (!this.launcher.canStart) return false;
		onProgress('starting');
		return this.launcher.start();
	}

	/**
	 * Lets ComfyUI free its models once nothing has been painted for a while, like Ollama does, so they don't
	 * hold the computer's memory for hours; ComfyUI that Jeong started stops altogether. The next painting
	 * loads them again (10 to 20 seconds), or starts ComfyUI again.
	 */
	private freeWhenIdle(): void {
		window.clearTimeout(this.freeTimer);
		if (!this.local) return;
		this.freeTimer = window.setTimeout(() => {
			if (this.busy.size) return;
			void this.comfy.free().then(() => this.launcher.stop());
		}, FREE_AFTER_MS);
	}

	/** Stops waiting to free ComfyUI's models, and stops ComfyUI if Jeong started it, when Jeong closes. */
	dispose(): void {
		window.clearTimeout(this.freeTimer);
		this.launcher.stop();
	}

	private changed(): void {
		this.listeners.forEach((listener) => listener());
	}

	/**
	 * What to paint, from the entry, and what its photos show of how people, animals and things look ('' without
	 * photos). Without a language model, the title and summary are the scene.
	 */
	private async scene(note: TFile): Promise<{ scene: string; photos: string }> {
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
		const title = typeof fm.title === 'string' ? fm.title : note.basename;
		const summary = typeof fm.summary === 'string' ? fm.summary : '';
		const story = storyText(await this.app.vault.cachedRead(note)).slice(0, 6000);
		if (!(await this.llm.isReady())) return { scene: [title, summary].filter(Boolean).join('. '), photos: '' };
		const photos = await this.photoNotes(note, fm.photos);
		// The photos' notes count as part of the entry, so the check below keeps what they describe
		const entry = `${story || summary}${photos ? `\n\nPHOTOS (what the people, animals and things look like):\n${photos}` : ''}`;
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
		return { scene: withoutClauses(scene.content, flagged) || title, photos };
	}

	/**
	 * Notes on what the people, animals and things in the entry's photos look like, for drawing them loosely.
	 * Empty without photos, or when no model that sees images is available (the painting just doesn't use them).
	 */
	private async photoNotes(note: TFile, names: unknown): Promise<string> {
		const files = (Array.isArray(names) ? names.map(String) : [])
			.map((name) => this.app.vault.getAbstractFileByPath(normalizePath(`${note.parent?.path ?? ''}/${name}`)))
			.filter((file): file is TFile => file instanceof TFile)
			.slice(0, PHOTOS_SEEN);
		if (!files.length) return '';
		try {
			const images = await Promise.all(files.map(async (file) => toSmallJpeg(await this.app.vault.readBinary(file))));
			const notes = await this.llm.chat([
				{ role: 'system', content: PHOTO_RULES },
				{ role: 'user', content: 'What do the people, animals and things in these photos look like?', images },
			]);
			this.logLlm('photo-notes', notes);
			return notes.content.trim();
		} catch (error) {
			this.metrics.log({ event: 'error', where: 'photo-notes', message: error instanceof Error ? error.message : String(error) });
			return '';
		}
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

/** A photo at most PHOTO_SIZE on its longer side, as base64 JPEG, small enough to send to a model that sees images. */
async function toSmallJpeg(bytes: ArrayBuffer): Promise<string> {
	const bitmap = await createImageBitmap(new Blob([bytes]));
	const scale = Math.min(1, PHOTO_SIZE / Math.max(bitmap.width, bitmap.height));
	const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
	const binary = new Uint8Array(await blob.arrayBuffer());
	let text = '';
	for (let i = 0; i < binary.length; i += 0x8000) text += String.fromCharCode(...binary.subarray(i, i + 0x8000));
	return window.btoa(text);
}

/** The painters send PNGs; a JPEG is a fraction of the size, which matters when the vault syncs to a phone. */
async function toJpeg(png: ArrayBuffer): Promise<ArrayBuffer> {
	const bitmap = await createImageBitmap(new Blob([png]));
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
}
