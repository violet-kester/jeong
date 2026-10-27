import { App, TFile } from 'obsidian';
import { composeEntry, type ComposeStep } from './composer';
import type { Ollama } from './ollama';
import type { Metrics } from '../metrics/metrics';
import { applyStory, findTranscript, transcriptText } from '../journal/apply-story';

export type StoryProgress = ComposeStep | 'not-ready' | 'done' | 'failed';

/**
 * Writes the story, title, and summary for an entry from its transcript.md, and saves them
 * into the entry. Used right after recording, and by the "Write the story" command.
 */
export async function writeStory(
	app: App,
	ollama: Ollama,
	metrics: Metrics,
	note: TFile,
	onProgress: (progress: StoryProgress) => void,
): Promise<boolean> {
	if (!(await ollama.isReady())) {
		onProgress('not-ready');
		return false;
	}
	const transcriptFile = findTranscript(app, note);
	if (!transcriptFile) throw new Error('This entry has no transcript');
	const transcript = transcriptText(await app.vault.read(transcriptFile));

	try {
		let model = '';
		const composed = await composeEntry(ollama, transcript, (step, result) => {
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
