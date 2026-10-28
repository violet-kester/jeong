import { App, TFile } from 'obsidian';
import { composeEntry, reviseEntry, type ComposedEntry, type ComposeStep } from './composer';
import type { ChatResult, LanguageModel } from './language-model';
import type { Metrics } from '../metrics/metrics';
import { applyStory, findTranscript, transcriptText } from '../journal/apply-story';
import { storyText } from '../journal/story-text';

export type StoryProgress = ComposeStep | 'not-ready' | 'done' | 'failed';

/**
 * Writes the story, title, and summary for an entry from its transcript.md, and saves them
 * into the entry. Used right after recording, and by the "Write the story" command.
 */
export async function writeStory(
	app: App,
	llm: LanguageModel,
	metrics: Metrics,
	note: TFile,
	onProgress: (progress: StoryProgress) => void,
): Promise<boolean> {
	return compose(app, llm, metrics, note, onProgress, (transcript, onStep) => composeEntry(llm, transcript, onStep));
}

/**
 * Changes an entry's story the way the person asked, out loud, and saves it. Their words are only instructions:
 * they change the story and are never added to it, and the transcript stays as it was.
 */
export async function reviseStory(
	app: App,
	llm: LanguageModel,
	metrics: Metrics,
	note: TFile,
	instructions: string,
	onProgress: (progress: StoryProgress) => void,
): Promise<boolean> {
	const current = storyText(await app.vault.read(note));
	return compose(app, llm, metrics, note, onProgress, (transcript, onStep) => reviseEntry(llm, transcript, current, instructions, onStep));
}

/** Runs one way of writing the story from the entry's transcript, logs each step, and saves the result. */
async function compose(
	app: App,
	llm: LanguageModel,
	metrics: Metrics,
	note: TFile,
	onProgress: (progress: StoryProgress) => void,
	write: (transcript: string, onStep: (step: ComposeStep, result?: ChatResult) => void) => Promise<ComposedEntry>,
): Promise<boolean> {
	if (!(await llm.isReady())) {
		onProgress('not-ready');
		return false;
	}
	const transcriptFile = findTranscript(app, note);
	if (!transcriptFile) throw new Error('This entry has no transcript');
	const transcript = transcriptText(await app.vault.read(transcriptFile));

	try {
		let model = '';
		const composed = await write(transcript, (step, result) => {
			if (!result) {
				onProgress(step);
				return;
			}
			model = result.model;
			metrics.log({
				event: 'llm',
				task: step,
				model: result.model,
				promptTokens: result.promptTokens,
				outputTokens: result.outputTokens,
				ms: Math.round(result.ms),
				tokensPerSecond: Math.round((result.outputTokens / Math.max(1, result.ms)) * 1000 * 10) / 10,
			});
		});
		await applyStory(app, note, composed, model);
		onProgress('done');
		return true;
	} catch (error) {
		console.error('Jeong: could not write the story', error);
		metrics.log({ event: 'error', where: 'write-story', message: error instanceof Error ? error.message : String(error) });
		onProgress('failed');
		return false;
	}
}
