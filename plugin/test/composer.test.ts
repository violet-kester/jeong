import './dom-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault } from './fake-vault';
import { lightEdit } from '../src/compose/light-edit';
import { composeEntry, reviseEntry } from '../src/compose/composer';
import { writeStory } from '../src/compose/write-story';
import { renameToTitle } from '../src/journal/apply-story';
import { storyFingerprint, storyIsEdited } from '../src/journal/entry-note';
import type { ChatMessage, ChatResult, LanguageModel } from '../src/compose/language-model';
import type { Metrics } from '../src/metrics/metrics';

const LONG = Array.from({ length: 50 }, (_, i) => `Word${i}`).join(' ') + '.';

function model(replies: (messages: ChatMessage[]) => string | Partial<ChatResult>): LanguageModel & { calls: ChatMessage[][] } {
	const calls: ChatMessage[][] = [];
	return {
		calls,
		chat: async (messages) => {
			calls.push(messages);
			const reply = replies(messages);
			return { model: 'test', promptTokens: 1, outputTokens: 1, ms: 1, content: '', ...(typeof reply === 'string' ? { content: reply } : reply) };
		},
		unload: async () => {},
		isReady: async () => true,
	};
}
const named = (title: string, sentence = 1) => JSON.stringify({ title, sentence });
const noSteps = () => {};

test('a rewrite never reaches the story, and a question stays a question', () => {
	const said = 'Is it not possible to see the words on my phone?';
	assert.equal(lightEdit(said, 'It is definitely possible to view the words on your phone.'), said);
});

test('every word of the story was said, in order, whatever the model returns', () => {
	const said = 'I went to the shop. It was closed so I walked home.';
	for (const suggestion of ['A wonderful day of shopping awaited me.', 'home walked I closed was It shop the to went I', 'I went to the lovely shop. It was closed.', LONG]) {
		const story = lightEdit(said, suggestion).toLowerCase().split(/\s+/);
		const words = said.toLowerCase().split(/\s+/);
		let at = 0;
		for (const word of story) {
			at = words.indexOf(word, at) + 1;
			assert.ok(at > 0, `"${word}" was not said, in order`);
		}
	}
});

test('slips go: filler sounds, doubled words, a sentence restarted', () => {
	assert.equal(lightEdit('Um, I went to the the shop.', 'I went to the shop.'), 'I went to the shop.');
	const after = ' because the rain came in and the road started to flood near the bridge by our house.';
	assert.equal(lightEdit(`We were going we had to leave early${after}`, `We had to leave early${after}`), `We had to leave early${after}`);
});

test('a sentence start stays capitalized when the slip before it goes', () => {
	assert.equal(lightEdit('So I so we left today.', 'So we left today.'), 'So we left today.');
	assert.equal(lightEdit('It it was late.', 'It was late.'), 'It was late.');
});

test('words that are not slips stay, however the model tries to tidy them', () => {
	for (const [said, suggestion] of [
		['They are very small kind of buttons.', 'They are very small buttons.'],
		['I do not like it.', 'I do like it.'],
		['I never never said that but I did I do not know.', 'I said that but I do know.'],
		['I saw Anna and Anna saw me.', 'I saw and Anna saw me.'],
		['I went home and slept well.', 'I slept well.'],
	] as const) {
		assert.ok(lightEdit(said, suggestion).includes(said.includes('kind of') ? 'kind of' : said.includes('Anna and') ? 'Anna and' : 'I'), said);
	}
	assert.equal(lightEdit('They are very small kind of buttons.', 'They are very small buttons.'), 'They are very small kind of buttons.');
	assert.equal(lightEdit('I do not like it.', 'I do like it.'), 'I do not like it.');
	assert.equal(lightEdit('I went home and slept well.', 'I slept well.'), 'I went home and slept well.');
});

test('a stretch the model rewrote stands, even beside a doubled word', () => {
	assert.equal(lightEdit('It was the the best day.', 'It was the a best day.'), 'It was the the best day.');
});

test('nothing is taken from a question as a false start', () => {
	assert.equal(lightEdit('Did you did it work?', 'Did it work?'), 'Did you did it work?');
});

test('a cut-off or empty suggestion keeps everything that was said', () => {
	const said = 'One thing happened first. Then a second thing happened after that. And finally a third thing came.';
	assert.equal(lightEdit(said, 'One thing happened first.'), said);
	assert.equal(lightEdit(said, ''), said);
});

test('removing too much keeps everything', () => {
	assert.equal(lightEdit('I I we we they they go.', 'I we they go.'), 'I I we we they they go.');
});

test('paragraph breaks are taken, only between sentences', () => {
	assert.equal(lightEdit('First part here. Second part here.', 'First part here.\n\nSecond part here.'), 'First part here.\n\nSecond part here.');
	assert.equal(lightEdit('First part here. Second part here.', 'First part\n\nhere. Second part here.'), 'First part here. Second part here.');
});

test('a story takes one call, then one for the title and summary', async () => {
	const llm = model((messages) => (messages[0]!.content.startsWith('You copy-edit') ? 'Something invented entirely.' : named('Fifty Words')));
	const entry = await composeEntry(llm, LONG, noSteps);
	assert.equal(entry.story, LONG);
	assert.equal(llm.calls.length, 2);
	assert.ok(entry.aiDraft, 'an entry the machine wrote is never marked as edited by hand');
});

test('a short recording skips the story call', async () => {
	const llm = model(() => named('Short'));
	const entry = await composeEntry(llm, 'A short one, that I said today.', noSteps);
	assert.equal(entry.story, 'A short one, that I said today.');
	assert.equal(llm.calls.length, 1);
});

test('the summary is one of the entry\'s own sentences, whichever the model names', async () => {
	const story = 'I went out early. I fixed the button today. It works now.';
	assert.equal((await composeEntry(model(() => named('Button', 2)), story, noSteps)).summary, 'I fixed the button today.');
	for (const reply of [named('Button', 99), named('Button', 0), 'not json']) {
		assert.equal((await composeEntry(model(() => reply), story, noSteps)).summary, 'I went out early.', reply);
	}
});

test('a long sentence is cut short for the summary', async () => {
	const story = Array.from({ length: 30 }, () => 'and').join(' ') + '.';
	const { summary } = await composeEntry(model(() => named('Long')), story, noSteps);
	assert.ok(summary.endsWith('…') && summary.split(' ').length === 25);
});

test('a changed story that was cut off is refused', async () => {
	await assert.rejects(reviseEntry(model(() => ({ content: 'Half a', truncated: true })), 'A whole story.', 'change it', noSteps));
});

const metrics = { log: () => {} } as unknown as Metrics;
const NOTE = 'j/e/Entry.md';
function entryVault(story = 'Old words.') {
	const v = new FakeVault();
	v.deliver(NOTE, `---\ntitle: Entry\nstatus: transcribed\nsession: s1\n---\n\n${story}\n`);
	v.deliver('j/e/Entry (transcript).md', `---\nkind: transcript\n---\n\n**[0:00]** Said words.\n`);
	return v;
}
const note = (v: FakeVault) => v.files.get(NOTE) as never;

test('a missing transcript reports failure instead of throwing', async () => {
	const v = new FakeVault();
	v.deliver(NOTE, `---\ntitle: Entry\n---\n\nOld.\n`);
	const steps: string[] = [];
	assert.equal(await writeStory(v.app, model(() => ''), metrics, note(v), (step) => steps.push(step)), false);
	assert.ok(steps.includes('failed'));
});

test('a hand edit made while the story was being written is kept', async () => {
	const v = entryVault();
	const llm = model(() => {
		v.data.set(NOTE, (v.data.get(NOTE) as string).replace('Old words.', 'My own edit.'));
		return named('New');
	});
	const steps: string[] = [];
	assert.equal(await writeStory(v.app, llm, metrics, note(v), (step) => steps.push(step)), false);
	assert.ok((v.data.get(NOTE) as string).includes('My own edit.'));
	assert.ok(steps.includes('kept-edits'));
});

test('a save cut off halfway is not mistaken for a hand edit', async () => {
	const v = new FakeVault();
	v.deliver(NOTE, `---\ntitle: Entry\nstoryPrint: ${storyFingerprint('Old words.')}\n---\n\nOld words.\n`);
	v.deliver('j/e/Entry (transcript).md', `---\nkind: transcript\n---\n\n**[0:00]** Said words.\n`);
	// The story's body is saved, and then the frontmatter write after it fails
	v.failOn = (action, path) => action === 'frontmatter' && path === NOTE && (v.data.get(NOTE) as string).includes('Said words.');
	assert.equal(await writeStory(v.app, model(() => named('New')), metrics, note(v), noSteps), false);
	v.failOn = null;
	assert.equal(storyIsEdited(v.data.get(NOTE) as string), false);
});

test('every note in the entry takes the new title, even ones the index has not caught up on', async () => {
	const v = new FakeVault();
	const old = 'j/2026-11-09 Old Words';
	v.deliver(`${old}/Old Words.md`, '---\ntitle: Old Words\n---\n\nWords.\n');
	v.deliver(`${old}/Old Words (transcript).md`, '---\nkind: transcript\n---\n\nWords.\n');
	v.deliver(`${old}/Old Words (AI draft).md`, '---\nkind: draft\n---\n\nWords.\n');
	v.uncached.add(`${old}/Old Words (transcript).md`);
	v.uncached.add(`${old}/Old Words (AI draft).md`);
	const renamed: string[] = [];
	(v.app.fileManager as unknown as { renameFile: (file: unknown, path: string) => Promise<void> }).renameFile = async (_file, path) => {
		renamed.push(path);
	};
	await renameToTitle(v.app, v.files.get(`${old}/Old Words.md`) as never, v.files.get(old) as never, 'New Title');
	assert.deepEqual(renamed, [`${old}/New Title (transcript).md`, `${old}/New Title (AI draft).md`, `${old}/New Title.md`, 'j/2026-11-09 New Title']);
});
