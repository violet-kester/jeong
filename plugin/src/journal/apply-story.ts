import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ComposedEntry } from '../compose/composer';
import { relatedLine, safeName } from './entry-writer';
import { t } from '../i18n';

// Puts a composed story into an entry:
// - the entry note's text becomes the story (the recording player stays at the top)
// - title, summary, and anything to review go into the frontmatter
// - what the AI wrote, untouched, is kept as "<Title> (AI draft).md", for comparison (full version history comes with editing by voice)
// - the folder and all the entry's notes are renamed to the new title (Obsidian updates links)

export async function applyStory(app: App, note: TFile, composed: ComposedEntry, model: string): Promise<TFile> {
	const folder = note.parent;
	if (!folder) throw new Error('The entry has no folder');
	const name = note.basename;

	const draft = findByKind(app, folder, 'draft');
	const draftText =
		`---\nkind: draft\nentry: "[[${name}]]"\nmodel: ${model}\n---\n\n` +
		`> [!note] ${t('files.aiDraft')}\n> ${t('files.draftAbout')} [[${name}|${t('files.yourStory')}]].\n\n` +
		`${composed.aiDraft}\n`;
	if (draft) await app.vault.modify(draft, draftText);
	else await app.vault.create(normalizePath(`${folder.path}/${name} (AI draft).md`), draftText);

	// The recording player stays above the story; photos stay below it
	const photos: unknown = app.metadataCache.getFileCache(note)?.frontmatter?.photos;
	const photoNames = Array.isArray(photos) ? photos.map(String) : [];
	const isPhoto = (line: string) => photoNames.some((photo) => line.endsWith(`/${photo}]]`) || line === `![[${photo}]]`);
	await app.vault.process(note, (content) => {
		const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(content)?.[0] ?? '';
		const body = content.slice(frontmatter.length);
		const embeds = body.match(/^!\[\[[^\]]+\]\]$/gm) ?? [];
		const top = embeds.filter((line) => !isPhoto(line));
		const bottom = embeds.filter(isPhoto);
		return (
			`${frontmatter}\n${top.join('\n')}${top.length ? '\n\n' : ''}${relatedLine(name, true)}\n\n${composed.story}\n` +
			(bottom.length ? `\n${bottom.join('\n')}\n` : '')
		);
	});

	await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
		if (composed.title) fm.title = composed.title;
		fm.summary = composed.summary;
		fm.status = 'written';
		if (composed.flagged.length) fm.review = composed.flagged;
		else delete fm.review;
		fm.engine = `${typeof fm.engine === 'string' ? fm.engine.split(' · story ')[0] : ''} · story ${model}`;
	});

	return renameToTitle(app, note, folder, composed.title);
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

async function renameToTitle(app: App, note: TFile, folder: TFolder, title: string): Promise<TFile> {
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

/** The spoken words from a transcript note, without frontmatter, labels, embeds, or timestamps. */
export function transcriptText(content: string): string {
	return content
		.replace(/^---\n[\s\S]*?\n---\n/, '')
		.replace(/^>.*$/gm, '')
		.replace(/^!\[\[[^\]]+\]\]$/gm, '')
		.replace(/\*\*\[\d+(?::\d+)+\]\*\*\s*/g, '')
		.split(/\n\s*\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join(' ');
}
