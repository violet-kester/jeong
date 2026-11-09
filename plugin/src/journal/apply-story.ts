import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ComposedEntry } from '../compose/composer';
import { parseEntryNote, serializeEntryNote, storyFingerprint } from './entry-note';
import { relatedLine, safeName } from './entry-writer';
import { t } from '../i18n';

// Puts a composed story into an entry:
// - the entry note's text becomes the story (the recording player stays at the top)
// - title and summary go into the frontmatter
// - what the AI wrote, untouched, is kept as "<Title> (AI draft).md", for comparison (full version history comes with editing by voice)
// - the folder and all the entry's notes are renamed to the new title (Obsidian updates links)

/** False, with nothing changed, when the story was edited by hand after `before` was read. */
export async function applyStory(app: App, note: TFile, composed: ComposedEntry, model: string, before: string): Promise<boolean> {
	const folder = note.parent;
	if (!folder) throw new Error('The entry has no folder');
	const name = note.basename;

	// A changed story (aiDraft empty) keeps the AI draft it started from
	const draft = findByKind(app, folder, 'draft');
	if (composed.aiDraft) {
		const draftText =
			`---\nkind: draft\nentry: "[[${name}]]"\nmodel: ${model}\n---\n\n` +
			`> [!note] ${t('files.aiDraft')}\n> ${t('files.draftAbout')} [[${name}|${t('files.yourStory')}]].\n\n` +
			`${composed.aiDraft}\n`;
		if (draft) await app.vault.modify(draft, draftText);
		else await app.vault.create(normalizePath(`${folder.path}/${name} (AI draft).md`), draftText);
	}

	// Without its fingerprint for a moment, so a save cut off halfway reads as unwritten rather than as a hand edit
	await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
		delete fm.storyPrint;
	});

	// The recording player stays above the story; photos stay below it
	let editedMeanwhile = false;
	await app.vault.process(note, (content) => {
		const parsed = parseEntryNote(content);
		editedMeanwhile = parsed.story !== before;
		return editedMeanwhile ? content : serializeEntryNote({ ...parsed, links: relatedLine(name, !!draft || !!composed.aiDraft), notes: [], story: composed.story });
	});
	if (editedMeanwhile) {
		await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
			fm.edited = true;
		});
		return false;
	}

	await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
		if (composed.title) fm.title = composed.title;
		if (composed.summary) fm.summary = composed.summary;
		fm.status = 'written';
		// So a later change made right in the note can be recognized, and a spoken change counts as the person's own
		fm.storyPrint = storyFingerprint(composed.story);
		if (!composed.aiDraft && composed.story) fm.edited = true;
		fm.engine = `${typeof fm.engine === 'string' ? fm.engine.split(' · story ')[0] : ''} · story ${model}`;
	});

	await renameToTitle(app, note, folder, composed.title);
	return true;
}

/** The entry's transcript note, whether it uses the current naming or the older "transcript.md". */
export function findTranscript(app: App, note: TFile): TFile | null {
	const folder = note.parent;
	if (!folder) return null;
	const older = app.vault.getAbstractFileByPath(normalizePath(`${folder.path}/transcript.md`));
	return findByKind(app, folder, 'transcript') ?? (older instanceof TFile ? older : null);
}

function findByKind(app: App, folder: TFolder, kind: string): TFile | null {
	for (const child of folder.children) {
		if (child instanceof TFile && app.metadataCache.getFileCache(child)?.frontmatter?.kind === kind) return child;
	}
	return null;
}

export async function renameToTitle(app: App, note: TFile, folder: TFolder, title: string): Promise<TFile> {
	const newName = safeName(title);
	const oldName = note.basename;
	if (!newName || newName === oldName) return note;

	// The folder is "<date>[ <time>] <old title>"; swap the title part
	if (folder.name.endsWith(oldName)) {
		const prefix = folder.name.slice(0, folder.name.length - oldName.length);
		const target = normalizePath(`${folder.parent?.path ?? ''}/${prefix}${newName}`);
		if (!app.vault.getAbstractFileByPath(target)) await app.fileManager.renameFile(folder, target);
	}
	const parent = note.parent ?? folder;
	for (const [kind, suffix] of [
		['transcript', ' (transcript)'],
		['draft', ' (AI draft)'],
	] as const) {
		const file = findByKind(app, parent, kind);
		const path = normalizePath(`${parent.path}/${newName}${suffix}.md`);
		if (file && !app.vault.getAbstractFileByPath(path)) await app.fileManager.renameFile(file, path);
	}
	const notePath = normalizePath(`${parent.path}/${newName}.md`);
	if (!app.vault.getAbstractFileByPath(notePath)) await app.fileManager.renameFile(note, notePath);
	return note;
}
