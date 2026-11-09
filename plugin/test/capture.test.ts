import './dom-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeVault } from './fake-vault';
import { TakeDraft, recoverDrafts, saveTake, readSessions } from '../src/journal/capture-store';
import { Recorder } from '../src/audio/recorder';
import { SaveQueue } from '../src/journal/save-queue';
import { reconcile, takesIn } from '../src/journal/reconcile';
import { entriesWaitingForStory, listEntries } from '../src/journal/entries';
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

const info = (take = 1) => ({ session: S, take, startedAt: when.toISOString(), mimeType: 'audio/webm', language: 'en' });
const DRAFT = `${J}/.jeong/recording/${S} 01`;

test('step 7: a cut-off recording is saved from its parts, in order, then tidied', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	for (const piece of ['aa', 'bb', 'cc']) await draft.writePart(audio(piece), 3);
	draft.release();
	assert.equal(await recoverDrafts(v.app, J), 1);
	const data = v.data.get(`${L}/${S} 01 recording.webm`) as ArrayBuffer;
	assert.equal(new TextDecoder().decode(data), 'aabbcc');
	assert.ok(v.text(`${L}/${S} 01.md`).includes('duration: 0:09'));
	assert.equal([...v.disk.keys()].some((key) => key.startsWith(DRAFT)), false);
	const log = newLog();
	await reconcile(deps(v, log));
	assert.deepEqual(log.transcribed, ['aabbcc']);
});

test('step 7: a recording still going is left alone, and shows nowhere', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('aa'), 3);
	assert.equal(await recoverDrafts(v.app, J), 0);
	assert.deepEqual(v.names(L), []);
	assert.equal(listEntries(v.app, J).length, 0);
	assert.deepEqual(await reconcile(deps(v, newLog())), []);
	assert.equal(v.notes().length, 0);
	draft.release();
});

test('step 7: parts stay until the marker is written', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('aa'), 3);
	const q = new SaveQueue(v.app, J);
	const { take } = q.reserve(when);
	v.failOn = (a, p) => a === 'create' && p.endsWith(' 01.md');
	q.add({ ...capture('aa'), draft }, take);
	await assert.rejects(q.flush());
	assert.ok(v.disk.has(`${DRAFT}/draft.json`));
	v.failOn = null;
	await q.flush();
	assert.equal(v.disk.has(`${DRAFT}/draft.json`), false);
});

test('step 7: killed after the marker, recovery only tidies', async () => {
	const v = new FakeVault();
	const q = new SaveQueue(v.app, J);
	await saveTake(v.app, J, S, 1, capture('whole'));
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('pa'), 3);
	draft.release();
	assert.equal(await recoverDrafts(v.app, J), 0);
	assert.equal(new TextDecoder().decode(v.data.get(`${L}/${S} 01 recording.webm`) as ArrayBuffer), 'whole');
	assert.equal(v.disk.has(`${DRAFT}/draft.json`), false);
	assert.equal(q.hasUnsaved, false);
});

test('step 7: a later take cut off with no audio keeps its number, so the next take is not held up', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	const draft = await TakeDraft.open(v.app, J, info(2));
	draft.release();
	await saveTake(v.app, J, S, 3, capture('three'));
	await recoverDrafts(v.app, J);
	const log = newLog();
	const statuses = await reconcile(deps(v, log));
	assert.equal(statuses[0]?.state, 'done');
	assert.deepEqual(log.transcribed, ['one', 'three']);
	assert.deepEqual(v.names(L), []);
});

test('step 7: a first take with no audio leaves nothing behind', async () => {
	const v = new FakeVault();
	(await TakeDraft.open(v.app, J, info())).release();
	assert.equal(await recoverDrafts(v.app, J), 0);
	assert.deepEqual(v.names(L), []);
	assert.equal(v.disk.size, 0);
});

const picture = (name: string, body: string) => ({ name, type: 'image/jpeg', data: new Blob([body]) });
const decoded = (v: FakeVault, path: string) => new TextDecoder().decode(v.data.get(path) as ArrayBuffer);

test('a killed recording brings back its photos, in the tray order, and they reach the entry', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('aa'), 3);
	const first = picture('IMG_1.HEIC', 'one');
	const second = picture('IMG_2.jpg', 'two');
	await draft.keepPhotos([first]);
	await draft.keepPhotos([second, first]);
	draft.release();
	assert.equal(await recoverDrafts(v.app, J), 1);
	assert.equal(decoded(v, `${L}/${S} 01 photo 1.jpg`), 'two');
	assert.equal(decoded(v, `${L}/${S} 01 photo 2.heic`), 'one');
	assert.equal([...v.disk.keys()].some((key) => key.startsWith(DRAFT)), false);
	assert.deepEqual((await reconcile(deps(v, newLog())))[0]?.state, 'done');
	assert.equal(v.notes().some((note) => v.text(note.path).includes('photo 2')), true);
});

test('a photo removed during the recording does not come back', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('aa'), 3);
	const gone = picture('gone.jpg', 'gone');
	const kept = picture('kept.jpg', 'kept');
	await draft.keepPhotos([gone, kept]);
	await draft.keepPhotos([kept]);
	draft.release();
	await recoverDrafts(v.app, J);
	assert.equal(decoded(v, `${L}/${S} 01 photo 1.jpg`), 'kept');
	assert.equal(v.data.has(`${L}/${S} 01 photo 2.jpg`), false);
});

test('killed before the photo list or mid-photo: whole photos survive, half-written ones do not', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('aa'), 3);
	await draft.keepPhotos([picture('a.jpg', 'whole')]);
	v.disk.delete(`${DRAFT}/photos.json`);
	v.disk.set(`${DRAFT}/photo-002.jpg.tmp`, new TextEncoder().encode('ha').buffer);
	draft.release();
	await recoverDrafts(v.app, J);
	assert.equal(decoded(v, `${L}/${S} 01 photo 1.jpg`), 'whole');
	assert.deepEqual(v.names(L).filter((name) => name.includes('photo')), [`${S} 01 photo 1.jpg`]);
});

test('a photo that cannot be copied does not stop the recording, and the next change tries again', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	const photo = picture('a.jpg', 'pic');
	v.failOn = (a, p) => a === 'writeBinary' && p.endsWith('.tmp');
	await draft.keepPhotos([photo]);
	v.failOn = null;
	await draft.writePart(audio('aa'), 3);
	await draft.keepPhotos([photo]);
	draft.release();
	await recoverDrafts(v.app, J);
	assert.equal(decoded(v, `${L}/${S} 01 photo 1.jpg`), 'pic');
});

test('saving normally clears the kept photos, even with a copy still going', async () => {
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	await draft.writePart(audio('aa'), 3);
	const adapter = v.app.vault.adapter;
	const write = adapter.writeBinary.bind(adapter);
	let finishCopy = () => {};
	const copying = new Promise<void>((resolve) => (finishCopy = resolve));
	adapter.writeBinary = async (path, data) => {
		await copying;
		await write(path, data);
	};
	void draft.keepPhotos([picture('a.jpg', 'pic')]);
	const q = new SaveQueue(v.app, J);
	const { take } = q.reserve(when);
	q.add({ ...capture('aa'), draft }, take);
	const saved = q.flush();
	await new Promise((resolve) => setTimeout(resolve, 5));
	finishCopy();
	await saved;
	assert.equal([...v.disk.keys()].some((key) => key.startsWith(DRAFT)), false);
});

function fakeMicrophone() {
	const globals = globalThis as unknown as Record<string, unknown>;
	let current: { ondataavailable: (e: { data: Blob }) => void; onstop: () => void; mimeType: string } | null = null;
	class MR {
		static isTypeSupported = () => true;
		mimeType = 'audio/webm';
		ondataavailable = (_e: { data: Blob }) => {};
		onstop = () => {};
		constructor() {
			current = this as never;
		}
		start() {}
		stop() {
			this.onstop();
		}
	}
	globals.MediaRecorder = MR;
	globals.AudioContext = class {
		createMediaStreamSource() {
			return { connect() {} };
		}
		createAnalyser() {
			return {};
		}
		async close() {}
	};
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'test', mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } } });
	return (text: string) => current?.ondataavailable({ data: new Blob([text]) });
}

test('step 7: the recorder moves audio to disk, keeps little in memory, and gives back all of it in order', async () => {
	const speak = fakeMicrophone();
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	const recorder = new Recorder();
	await recorder.start(async () => draft);
	const written = () => (recorder as unknown as { writing: Promise<void> }).writing;
	for (const c of ['a', 'b', 'c']) speak(c);
	await written();
	for (const c of ['d', 'e', 'f']) speak(c);
	await written();
	assert.equal((recorder as unknown as { chunks: Blob[] }).chunks.length, 0);
	assert.equal([...v.disk.keys()].filter((key) => key.endsWith('.part')).length, 2);
	speak('g');
	const recording = await recorder.stop();
	assert.equal(await recording.blob.text(), 'abcdefg');
});

test('step 7: a failed disk write keeps the audio and stays in order', async () => {
	const speak = fakeMicrophone();
	const v = new FakeVault();
	const draft = await TakeDraft.open(v.app, J, info());
	const recorder = new Recorder();
	await recorder.start(async () => draft);
	let fail = true;
	v.failOn = (a) => a === 'writeBinary' && fail;
	for (const c of ['a', 'b', 'c']) speak(c);
	await (recorder as unknown as { writing: Promise<void> }).writing;
	assert.equal((recorder as unknown as { chunks: Blob[] }).chunks.length, 3);
	fail = false;
	for (const c of ['d', 'e', 'f']) speak(c);
	const recording = await recorder.stop();
	assert.equal(await recording.blob.text(), 'abcdef');
});

test('the first take note plays every take', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	await saveTake(v.app, J, S, 2, capture('two'));
	await saveTake(v.app, J, S, 3, capture('three'));
	const note = v.text(`${L}/${S} 01.md`);
	for (const n of ['01', '02', '03']) assert.match(note, new RegExp(`${n} recording\\.webm\\]\\]`));
	assert.equal(readSessions(v.app, J)[0]?.takes[0]?.recording?.name, `${S} 01 recording.webm`);
});

test('a photo added to an old page during write-up reaches the entry', async () => {
	const v = new FakeVault();
	const page = `${L}/2026-11-08 1724.md`;
	v.deliver(`${L}/2026-11-08 1724 recording.webm`, new TextEncoder().encode('one').buffer as ArrayBuffer);
	v.deliver(page, `---\ntitle: Recording\ndate: 2026-11-08\ntime: 17:24\nvisibility: private\nstatus: recorded\nrecordings:\n  - 2026-11-08 1724 recording.webm\n---\n\nbody\n`);
	const base = deps(v, newLog());
	await reconcile({
		...base,
		transcribe: async (recording: Blob, take) => {
			v.deliver(`${L}/2026-11-08 1724 photo 1.png`, new TextEncoder().encode('p').buffer as ArrayBuffer);
			v.deliver(page, v.text(page).replace('---\n\nbody', 'photos:\n  - 2026-11-08 1724 photo 1.png\n---\n\nbody'));
			return base.transcribe(recording, take);
		},
	});
	assert.match(v.text(entryNotes(v)[0]!.path), /photo 1\.png/);
	assert.equal(v.files.has(page), false);
	assert.equal(v.files.has(`${L}/2026-11-08 1724 photo 1.png`), false);
});

test('a recent entry with no story waits for one; a written or old entry does not', async () => {
	const v = new FakeVault();
	await saveTake(v.app, J, S, 1, capture('one'));
	await reconcile(deps(v, newLog()));
	const soon = new Date(2026, 10, 9);
	const [entry] = entriesWaitingForStory(v.app, J, soon);
	assert.ok(entry, 'the transcribed entry waits for its story');
	assert.equal(entriesWaitingForStory(v.app, J, new Date(2027, 0, 9)).length, 0, 'an old entry is left alone');
	await v.app.fileManager.processFrontMatter(entry.file, (fm: Record<string, unknown>) => {
		fm.status = 'written';
	});
	assert.equal(entriesWaitingForStory(v.app, J, soon).length, 0, 'a written entry is done');
});

test('a waiting recording is named for when it was made', async () => {
	const v = new FakeVault();
	const marker = await saveTake(v.app, J, S, 1, capture('one'));
	assert.match(await v.app.vault.read(marker), /^title: Sunday evening recording$/m);
});
