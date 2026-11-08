import './dom-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault } from './fake-vault';
import { saveTake, readSessions } from '../src/journal/capture-store';
import { SaveQueue } from '../src/journal/save-queue';
import { reconcile, takesIn } from '../src/journal/reconcile';
import { listEntries } from '../src/journal/entries';
import { addRecording, writeEntry } from '../src/journal/entry-writer';

const J = 'journal';
const L = `${J}/Loose pages`;
const when = new Date(2026, 10, 8, 17, 24);
const S = '2026-11-08 1724 abcd';
const audio = (text: string) => new Blob([text], { type: 'audio/webm' });
const capture = (text: string, photos: string[] = []) => ({
	recording: audio(text),
	mimeType: 'audio/webm',
	durationMs: 5000,
	startedAt: when,
	language: 'en',
	photos: photos.map((name) => ({ name, type: 'image/png', data: new Blob([name]) })),
});

function deps(v: FakeVault, log: { transcribed: string[]; stories: (string | null)[] }, fail?: () => boolean) {
	return {
		app: v.app,
		journalFolder: J,
		transcribe: async (recording: Blob) => {
			const text = await recording.text();
			if (fail?.()) throw new Error('transcribe failed');
			log.transcribed.push(text);
			return { text: `Words of ${text}.`, segments: [], audioMs: 5000, engine: 'test' };
		},
		story: async (_note: unknown, newWords: string | null) => {
			log.stories.push(newWords);
		},
	};
}
const newLog = () => ({ transcribed: [] as string[], stories: [] as (string | null)[] });
const entryNotes = (v: FakeVault) => v.notes().filter((f) => f.path.startsWith(`${J}/2026`) && !f.name.includes('(transcript)'));

test('step 1: a failed save stays waiting, and closing must ask', async () => {
	const v = new FakeVault();
	v.failOn = (action) => action === 'createBinary';
	const q = new SaveQueue(v.app, J);
	q.add(capture('one'));
	await assert.rejects(q.flush());
	assert.equal(q.failed, true);
	assert.equal(q.hasUnsaved, true);
	v.failOn = null;
	assert.ok(await q.flush());
	assert.equal(q.failed, false);
	assert.equal(q.hasUnsaved, false);
	assert.equal(readSessions(v.app, J)[0]?.takes.length, 1);
});

test('step 1: a take with an unsynced photo is not written up', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one', ['p.png']));
	const held = v.withhold(`${L}/${S} 01 photo 1.png`);
	const log = newLog();
	let statuses = await reconcile(deps(v, log));
	assert.equal(statuses[0]?.state, 'waiting');
	assert.equal(entryNotes(v).length, 0);
	assert.equal(log.transcribed.length, 0);
	v.deliver(`${L}/${S} 01 photo 1.png`, held);
	statuses = await reconcile(deps(v, log));
	assert.equal(statuses[0]?.state, 'done');
	assert.match(v.text(entryNotes(v)[0]!.path), /photo 1\.png/);
});

test('step 2: takes are written up in order, one entry', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	await saveTake(v.app, J, S, 2, capture('two'));
	const log = newLog();
	await reconcile(deps(v, log));
	assert.deepEqual(log.transcribed, ['one', 'two']);
	assert.equal(entryNotes(v).length, 1);
	assert.deepEqual(takesIn(v.text(entryNotes(v)[0]!.path)), [1, 2]);
	assert.deepEqual(v.names(L), []);
});

test('step 2: audio that has only partly arrived does not count', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('complete audio'));
	v.deliver(`${L}/${S} 01 recording.webm`, new TextEncoder().encode('comp').buffer as ArrayBuffer);
	const statuses = await reconcile(deps(v, newLog()));
	assert.equal(statuses[0]?.state, 'waiting');
	assert.equal(entryNotes(v).length, 0);
	assert.ok(v.files.has(`${L}/${S} 01.md`));
});

test('step 2: a later take arriving first waits for the earlier one', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 2, capture('two'));
	const log = newLog();
	const statuses = await reconcile(deps(v, log));
	assert.equal(statuses[0]?.state, 'waiting');
	assert.equal(log.transcribed.length, 0);
});

test('step 3: running twice gives one entry', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	const log = newLog();
	await reconcile(deps(v, log));
	await reconcile(deps(v, log));
	assert.equal(entryNotes(v).length, 1);
	assert.deepEqual(log.transcribed, ['one']);
	assert.deepEqual(log.stories, [null]);
});

for (const [action, match] of [
	['createBinary', 'journal/2026'],
	['create', '(transcript).md'],
	['create', 'Words of one.md'],
	['process', '(transcript).md'],
	['process', 'Words of one.md'],
	['frontmatter', 'Words of one.md'],
	['trash', 'recording.webm'],
	['trash', '01.md'],
	['trash', '02.md'],
] as const) {
	test(`step 3: failing once at ${action} ${match} resumes with one whole entry and no repeated words`, async () => {
		const v = new FakeVault();
		await saveTake(v.app, J, S, 1, capture('one', ['p.png']));
		await saveTake(v.app, J, S, 2, capture('two'));
		const log = newLog();
		let failed = false;
		v.failOn = (a, path) => {
			if (failed || a !== action || !path.includes(match)) return false;
			failed = true;
			return true;
		};
		await reconcile(deps(v, log));
		assert.equal(failed, true, 'the failure should have happened');
		v.failOn = null;
		await reconcile(deps(v, log));
		const notes = entryNotes(v);
		assert.equal(notes.length, 1);
		assert.deepEqual(takesIn(v.text(notes[0]!.path)), [1, 2]);
		const transcript = v.notes().find((f) => f.name.endsWith('(transcript).md'))!;
		assert.equal(v.text(transcript.path).match(/Words of two\./g)?.length, 1);
		assert.equal(v.text(transcript.path).match(/Words of one\./g)?.length, 1);
		assert.deepEqual(v.names(L), []);
	});
}

test('step 3: a failure after transcribing does not transcribe the finished take again', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	const log = newLog();
	let once = true;
	v.failOn = (a, p) => {
		if (once && a === 'create' && p.endsWith('(transcript).md')) {
			once = false;
			return true;
		}
		return false;
	};
	await reconcile(deps(v, log));
	v.failOn = null;
	await reconcile(deps(v, log));
	assert.deepEqual(log.transcribed, ['one']);
	assert.equal(entryNotes(v).length, 1);
});

test('step 3: a take arriving after write-up joins the same entry, and its words are added', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	const log = newLog();
	await reconcile(deps(v, log));
	await saveTake(v.app, J, S, 2, capture('two'));
	await reconcile(deps(v, log));
	assert.equal(entryNotes(v).length, 1);
	assert.deepEqual(log.stories, [null, 'Words of two.']);
	assert.deepEqual(takesIn(v.text(entryNotes(v)[0]!.path)), [1, 2]);
});

test('step 3: late photos alone join the entry', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	await saveTake(v.app, J, S, 2, { durationMs: 0, startedAt: when, language: 'en', photos: [{ name: 'late.png', type: 'image/png', data: new Blob(['late']) }] });
	const log = newLog();
	await reconcile(deps(v, log));
	const note = entryNotes(v)[0]!;
	assert.match(v.text(note.path), /take 2 photo 1\.png/);
	assert.deepEqual(takesIn(v.text(note.path)), [1, 2]);
	assert.deepEqual(log.stories, [null]);
	assert.deepEqual(v.names(L), []);
});

test('step 3: a source is never removed before the entry lists its take', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	v.failOn = (a, p) => a === 'create' && p.endsWith('Words of one.md');
	await reconcile(deps(v, newLog()));
	assert.ok(v.files.has(`${L}/${S} 01 recording.webm`));
	assert.ok(v.files.has(`${L}/${S} 01.md`));
	assert.equal(v.trashed.some((p) => p.startsWith(L)), false);
});

test('step 3: a hand edit survives a later take', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	const log = newLog();
	await reconcile(deps(v, log));
	const note = entryNotes(v)[0]!;
	await v.app.vault.process(note, (c) => c.replace('Words of one.', 'My own words.'));
	await saveTake(v.app, J, S, 2, capture('two'));
	await reconcile(deps(v, log));
	assert.match(v.text(note.path), /My own words\./);
});

test('old pages still write up', async () => {
	const v = new FakeVault();
	const page = `${L}/2026-11-08 1724.md`;
	v.deliver(`${L}/2026-11-08 1724 recording.webm`, new TextEncoder().encode('one').buffer as ArrayBuffer);
	v.deliver(`${L}/2026-11-08 1724 recording 2.webm`, new TextEncoder().encode('two').buffer as ArrayBuffer);
	v.deliver(`${L}/2026-11-08 1724 photo 1.png`, new TextEncoder().encode('p').buffer as ArrayBuffer);
	v.deliver(page, `---\ntitle: Recording\ndate: 2026-11-08\ntime: 17:24\nvisibility: private\nstatus: recorded\nrecordings:\n  - 2026-11-08 1724 recording.webm\n  - 2026-11-08 1724 recording 2.webm\nphotos:\n  - 2026-11-08 1724 photo 1.png\n---\n\nbody\n`);
	const log = newLog();
	await reconcile(deps(v, log));
	assert.deepEqual(log.transcribed, ['one', 'two']);
	assert.equal(entryNotes(v).length, 1);
	assert.deepEqual(v.names(L), []);
	await reconcile(deps(v, log));
	assert.equal(entryNotes(v).length, 1);
});

test('an old page that gains a recording during write-up is kept, and the new recording joins', async () => {
	const v = new FakeVault();
	const page = `${L}/2026-11-08 1724.md`;
	v.deliver(`${L}/2026-11-08 1724 recording.webm`, new TextEncoder().encode('one').buffer as ArrayBuffer);
	v.deliver(page, `---\ntitle: Recording\ndate: 2026-11-08\ntime: 17:24\nvisibility: private\nstatus: recorded\nrecordings:\n  - 2026-11-08 1724 recording.webm\n---\n\nbody\n`);
	const log = newLog();
	const base = deps(v, log);
	await reconcile({
		...base,
		transcribe: async (recording: Blob, take) => {
			v.deliver(`${L}/2026-11-08 1724 recording 2.webm`, new TextEncoder().encode('two').buffer as ArrayBuffer);
			v.deliver(page, v.text(page).replace('recording.webm\n', 'recording.webm\n  - 2026-11-08 1724 recording 2.webm\n'));
			return base.transcribe(recording, take);
		},
	});
	assert.ok(v.files.has(page), 'the page stays until everything it lists is in');
	await reconcile(base);
	assert.deepEqual(log.transcribed, ['one', 'two']);
	assert.equal(entryNotes(v).length, 1);
	assert.equal(v.files.has(page), false);
});

test('the timeline shows one card for a session, and none once the entry exists', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one', ['a.png']));
	await saveTake(v.app, J, S, 2, capture('two', ['b.png']));
	let cards = listEntries(v.app, J);
	assert.equal(cards.length, 1);
	assert.equal(cards[0]?.status, 'recorded');
	assert.equal(cards[0]?.duration, '0:10');
	assert.equal(cards[0]?.photos.length, 2);
	await reconcile(deps(v, newLog()));
	cards = listEntries(v.app, J);
	assert.equal(cards.length, 1);
	assert.equal(cards[0]?.status, 'transcribed');
});

test('a take left behind by a failed cleanup does not make a second card', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	v.failOn = (a, p) => a === 'trash' && p.endsWith('01.md');
	await reconcile(deps(v, newLog()));
	assert.ok(v.files.has(`${L}/${S} 01.md`));
	assert.equal(listEntries(v.app, J).length, 1);
});

test('step 5: desktop entries write the same way, and adding twice adds once', async () => {
	const v = new FakeVault();
	const take = { recording: audio('x'), mimeType: 'audio/webm', durationMs: 1000, startedAt: when, transcript: 'Hello there.', segments: [], engine: 'e', language: 'en' };
	const note = await writeEntry(v.app, J, take);
	assert.ok(v.notes().some((f) => f.name.endsWith('(transcript).md')));
	const more = { ...take, transcript: 'More words.', fileName: 'fixed.webm' };
	await addRecording(v.app, note, more);
	await addRecording(v.app, note, more);
	const transcript = v.notes().find((f) => f.name.endsWith('(transcript).md'))!;
	assert.equal(v.text(transcript.path).match(/More words\./g)?.length, 1);
	assert.equal(v.text(note.path).match(/fixed\.webm/g)?.length, 2); // the player and the recordings list
});
