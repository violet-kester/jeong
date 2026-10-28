import { App, Platform, normalizePath } from 'obsidian';

// Local performance metrics: one line of JSON per event, in <journal>/.jeong/metrics/YYYY-MM.jsonl.
// Numbers and model names only. Never the words someone said: those stay in the journal.

export type MetricEvent =
	| { event: 'model_load'; kind: 'live' | 'final'; model: string; device: string; precision: string; loadMs: number }
	| {
			event: 'transcribe';
			kind: 'live' | 'final';
			model: string;
			audioMs: number;
			ms: number;
			speed: number;
			phrases?: number;
			skippedPartials?: number;
	  }
	| { event: 'recording'; durationMs: number; bytes: number; kbps: number; mimeType: string }
	| { event: 'entry_saved'; durationMs: number; words: number; ms: number }
	| { event: 'llm'; task: string; model: string; promptTokens: number; outputTokens: number; ms: number; tokensPerSecond: number }
	| { event: 'paint'; painter: string; model: string; sceneMs: number; unloadMs: number; paintMs: number; saveMs: number; ms: number }
	| { event: 'quality'; kind: 'live' | 'final'; model: string; wer: number; referenceWords: number }
	| { event: 'error'; where: string; message: string };

export type MetricRecord = MetricEvent & { ts: string; session: string; version: string; platform: string };

export class Metrics {
	private session = Math.random().toString(36).slice(2, 10);

	constructor(
		private app: App,
		private folder: () => string,
		readonly version: string,
	) {}

	get directory(): string {
		return normalizePath(`${this.folder()}/.jeong/metrics`);
	}

	/** Record an event. Never throws: losing a metric must never break recording. */
	log(event: MetricEvent): void {
		const record: MetricRecord = {
			ts: new Date().toISOString(),
			session: this.session,
			version: this.version,
			platform: Platform.isDesktopApp ? 'desktop' : 'mobile',
			...event,
		};
		void this.append(JSON.stringify(record) + '\n').catch((error: unknown) => console.warn('Jeong metrics:', error));
	}

	/** Every record logged so far, oldest first. */
	async readAll(): Promise<MetricRecord[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.directory))) return [];
		const { files } = await adapter.list(this.directory);
		const records: MetricRecord[] = [];
		for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
			for (const line of (await adapter.read(file)).split('\n')) {
				if (!line.trim()) continue;
				try {
					records.push(JSON.parse(line) as MetricRecord);
				} catch {
					// Skip a damaged line rather than losing the rest
				}
			}
		}
		return records;
	}

	private async append(line: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.directory))) await adapter.mkdir(this.directory);
		const month = new Date().toISOString().slice(0, 7);
		await adapter.append(normalizePath(`${this.directory}/${month}.jsonl`), line);
	}
}
