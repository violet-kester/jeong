import { requestUrl } from 'obsidian';

// Talks to ComfyUI, which runs the image model (FLUX.2 klein) on this computer.
// Like Ollama, requests only go to the local address in settings, never to the internet.

/** A ComfyUI workflow in its API format: node id → { class_type, inputs }. */
export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

interface HistoryEntry {
	status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
	outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
}

const POLL_MS = 1000;
const TIMEOUT_MS = 10 * 60 * 1000; // the first painting also loads the model, which can take a few minutes
const REQUEST_MS = 2_000; // ComfyUI can't answer while it loads a model; a check that gets no answer is given up and asked again soon

export class ComfyUI {
	constructor(private url: () => string) {}

	private address(path: string): string {
		return `${this.url().replace(/\/$/, '')}${path}`;
	}

	/** True when ComfyUI is running. */
	async isReady(): Promise<boolean> {
		try {
			const response = await requestUrl({ url: this.address('/system_stats'), throw: false });
			return response.status === 200;
		} catch {
			return false;
		}
	}

	/**
	 * Asks ComfyUI to let go of its models, from the graphics card and from memory. ComfyUI otherwise keeps
	 * them loaded for good, holding many gigabytes long after the last painting.
	 */
	async free(): Promise<void> {
		try {
			await requestUrl({
				url: this.address('/free'),
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify({ unload_models: true, free_memory: true }),
				throw: false,
			});
		} catch {
			// Not running, or already freed
		}
	}

	/** Runs a workflow and returns the first image it saves, as PNG bytes. */
	async paint(workflow: Workflow): Promise<ArrayBuffer> {
		const queued = await requestUrl({
			url: this.address('/prompt'),
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({ prompt: workflow, client_id: 'jeong' }),
		});
		const id = (queued.json as { prompt_id?: string }).prompt_id;
		if (!id) throw new Error('ComfyUI did not accept the workflow');

		const started = Date.now();
		while (Date.now() - started < TIMEOUT_MS) {
			await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
			const history = await withTimeout(requestUrl({ url: this.address(`/history/${id}`) }), REQUEST_MS).catch(() => null);
			const entry = (history?.json as Record<string, HistoryEntry> | undefined)?.[id];
			if (!entry) continue;
			if (entry.status?.status_str === 'error') throw new Error(`ComfyUI could not paint: ${JSON.stringify(entry.status.messages ?? []).slice(0, 300)}`);
			const image = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])[0];
			if (image) {
				const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
				return (await requestUrl({ url: this.address(`/view?${query.toString()}`) })).arrayBuffer;
			}
			if (entry.status?.completed) throw new Error('ComfyUI finished without an image');
		}
		throw new Error('ComfyUI took too long');
	}
}

/** The promise, or a rejection once `ms` have passed without an answer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error('No answer')), ms);
		promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
	});
}
