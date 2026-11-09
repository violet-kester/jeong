// Demo only (?demo): stands in for Ollama. Goes through the same steps, then saves a story into the
// entry with the plugin's own applyStory, so the title, the story pane, and the renamed files are real.

import type { TFile } from './obsidian';
import { applyStory } from '../src/journal/apply-story';
import { storyIsEdited, storyText } from '../src/journal/entry-note';
import type { StoryProgress } from '../src/compose/write-story';

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const readNote = (app: never, note: TFile) => (app as { vault: { read: (file: TFile) => Promise<string> } }).vault.read(note);

/** Demo only: the real rule for Record more, with a pretend story of the new words. */
export async function addToStory(app: never, ollama: unknown, metrics: unknown, note: TFile, newWords: string, onProgress: (progress: StoryProgress) => void): Promise<boolean> {
	const content = await readNote(app, note);
	if (!storyIsEdited(content)) return writeStory(app, ollama, metrics, note, onProgress);
	await applyStory(app, note as never, { story: `${storyText(content)}\n\nAdded: ${newWords}`, aiDraft: '', title: '', summary: '' }, 'demo');
	onProgress('done');
	return true;
}

export async function writeStory(app: never, _ollama: unknown, _metrics: unknown, note: TFile, onProgress: (progress: StoryProgress) => void): Promise<boolean> {
	if (storyIsEdited(await readNote(app, note))) {
		onProgress('kept-edits');
		return false;
	}
	for (const step of ['story', 'summary'] as const) {
		onProgress(step);
		await wait(900);
	}
	const story =
		'Blake was in the kitchen while I sat in the dining room. It was cold outside, and the light around the mirror was on.\n\nWe made his grandmother’s soup, the one with the little dumplings. I think I’ll remember this one.';
	await applyStory(app, note as never, { story, aiDraft: story, title: 'Soup on a Cold Night', summary: 'Blake cooked his grandmother’s soup while I sat in the dining room on a cold night.' }, 'demo');
	onProgress('done');
	return true;
}

/** Demo only: "changes" the story by noting the instructions under it, the way a real change would read them. */
export async function reviseStory(app: never, _ollama: unknown, _metrics: unknown, note: TFile, instructions: string, onProgress: (progress: StoryProgress) => void): Promise<boolean> {
	for (const step of ['rewrite', 'summary'] as const) {
		onProgress(step);
		await wait(900);
	}
	const fm = (app as { metadataCache: { getFileCache: (file: TFile) => { frontmatter?: Record<string, unknown> } | null } }).metadataCache.getFileCache(note)?.frontmatter ?? {};
	const title = typeof fm.title === 'string' ? fm.title : note.basename;
	const summary = typeof fm.summary === 'string' ? fm.summary : '';
	const story = `In the demo, a change is only pretended: here is what you asked for.\n\n${instructions}`;
	await applyStory(app, note as never, { story, aiDraft: '', title, summary }, 'demo');
	onProgress('done');
	return true;
}
