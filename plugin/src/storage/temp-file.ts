import { Platform } from 'obsidian';

// Recordings are written to the computer's temp folder first, outside the vault,
// so sync tools like OneDrive don't upload half-written files or make conflict copies.
// Finished recordings get moved into the entry folder later (milestone M4).

const EXTENSIONS: Record<string, string> = { webm: 'webm', mp4: 'm4a', ogg: 'ogg' };

export function extensionFor(mimeType: string): string {
	const container = mimeType.split(';')[0]?.split('/')[1] ?? '';
	return EXTENSIONS[container] ?? 'audio';
}

// Node's require exists only in the desktop app (Electron). A bundled import('fs')
// doesn't work there, so reach for require directly.
function nodeRequire<T>(id: string): T {
	const req = (window as Window & { require?: (id: string) => unknown }).require;
	if (!req) throw new Error('Node modules are not available here');
	return req(id) as T;
}

/** Deletes a temp recording once it's safely in the journal. Never throws. */
export async function deleteTemp(file: string): Promise<void> {
	if (!Platform.isDesktopApp) return;
	try {
		await nodeRequire<typeof import('fs')>('fs').promises.unlink(file);
	} catch {
		// Leaving a temp file behind is harmless; the system cleans its temp folder
	}
}

/** Saves a blob to the temp folder and returns its path, or null where that isn't possible (mobile). */
export async function saveToTemp(blob: Blob, name: string): Promise<string | null> {
	if (!Platform.isDesktopApp) return null;
	const fs = nodeRequire<typeof import('fs')>('fs');
	const os = nodeRequire<typeof import('os')>('os');
	const path = nodeRequire<typeof import('path')>('path');

	const folder = path.join(os.tmpdir(), 'jeong-recordings');
	await fs.promises.mkdir(folder, { recursive: true });
	const file = path.join(folder, name);
	await fs.promises.writeFile(file, new Uint8Array(await blob.arrayBuffer()));
	return file;
}
