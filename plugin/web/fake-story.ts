// Demo only (?demo): stands in for Ollama. Goes through the same steps, then saves a story into the
// entry with the plugin's own applyStory, so the title, the story pane, and the renamed files are real.

import type { TFile } from './obsidian';
import { applyStory } from '../src/journal/apply-story';
import type { StoryProgress } from '../src/compose/write-story';

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function writeStory(app: never, _ollama: unknown, _metrics: unknown, note: TFile, onProgress: (progress: StoryProgress) => void): Promise<boolean> {
	for (const step of ['story', 'check', 'summary'] as const) {
		onProgress(step);
		await wait(900);
	}
	const story =
		'Blake was in the kitchen while I sat in the dining room. It was cold outside, and the light around the mirror was on.\n\nWe made his grandmother’s soup, the one with the little dumplings. I think I’ll remember this one.';
	await applyStory(app, note as never, { story, aiDraft: story, title: 'Soup on a Cold Night', summary: 'Blake cooked his grandmother’s soup while I sat in the dining room on a cold night.', flagged: [] }, 'demo');
	onProgress('done');
	return true;
}
