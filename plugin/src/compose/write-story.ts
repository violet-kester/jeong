import { App, TFile } from 'obsidian';
import { composeEntry, reviseEntry, type ComposedEntry, type ComposeStep } from './composer';
import type { ChatResult, LanguageModel } from './language-model';
import type { Metrics } from '../metrics/metrics';
import { applyStory, findTranscript } from '../journal/apply-story';
import { parseEntryNote, storyIsEdited, storyText, transcriptText } from '../journal/entry-note';

export type StoryProgress = ComposeStep | 'not-ready' | 'done' | 'failed' | 'kept-edits';

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
	if (storyIsEdited(await app.vault.read(note))) {
		onProgress('kept-edits');
		return false;
	}
	return compose(app, llm, metrics, note, onProgress, (transcript, onStep) => composeEntry(llm, transcript, onStep));
}

/**
 * After Record more. A story nobody has touched is written again from everything said; one the person has changed
 * stays exactly as it is, with a story of just the new words added beneath it.
 */
export async function addToStory(
	app: App,
	llm: LanguageModel,
	metrics: Metrics,
	note: TFile,
	newWords: string,
	onProgress: (progress: StoryProgress) => void,
): Promise<boolean> {
	const content = await app.vault.read(note);
	if (!storyIsEdited(content)) return writeStory(app, llm, metrics, note, onProgress);
	const kept = storyText(content);
	return compose(app, llm, metrics, note, onProgress, async (_transcript, onStep) => {
		const added = await composeEntry(llm, newWords, onStep);
		return { ...added, story: `${kept}\n\n${added.story}`, aiDraft: '', title: '', summary: '' };
	});
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
	return compose(app, llm, metrics, note, onProgress, (_transcript, onStep) => reviseEntry(llm, current, instructions, onStep));
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
		metrics.log({ event: 'error', where: 'write-story', message: 'The language model is not ready' });
		onProgress('not-ready');
		return false;
	}
	try {
		const transcriptFile = findTranscript(app, note);
		if (!transcriptFile) throw new Error('This entry has no transcript');
		const transcript = transcriptText(await app.vault.read(transcriptFile));
		const { frontmatter, story: before } = parseEntryNote(await app.vault.read(note));
		// Stays the same when the entry is renamed for its new title
		const entry = /^session:\s*"?(.+?)"?\s*$/m.exec(frontmatter)?.[1] ?? note.parent?.name ?? note.path;
		let model = '';
		const composed = await write(transcript, (step, result) => {
			if (!result) {
				onProgress(step);
				return;
			}
			model = result.model;
			metrics.log({
				event: 'llm',
				entry,
				task: step,
				model: result.model,
				promptTokens: result.promptTokens,
				outputTokens: result.outputTokens,
				ms: Math.round(result.ms),
				tokensPerSecond: Math.round((result.outputTokens / Math.max(1, result.ms)) * 1000 * 10) / 10,
			});
		});
		if (!(await applyStory(app, note, composed, model, before))) {
			onProgress('kept-edits');
			return false;
		}
		onProgress('done');
		return true;
	} catch (error) {
		console.error('Jeong: could not write the story', error);
		metrics.log({ event: 'error', where: 'write-story', message: error instanceof Error ? error.message : String(error) });
		onProgress('failed');
		return false;
	}
}
