import type { App, TFile } from 'obsidian';
import { newSessionId, saveTake, type Capture } from './capture-store';

// A phone's takes, in the order they were made, each kept until it is safely written. One recording window is
// one session, so Record more joins the same entry. A take that can't be saved blocks the ones after it,
// which is what keeps take numbers without gaps.

export class SaveQueue {
	private session: string | null = null;
	private nextTake = 1;
	private waiting: { take: number; capture: Capture }[] = [];
	private first: TFile | null = null;
	private flushing: Promise<void> = Promise.resolve();
	/** The last attempt failed, and takes are still waiting. Closing the window now would lose them. */
	failed = false;

	constructor(
		private app: App,
		private journalFolder: string,
	) {}

	get hasUnsaved(): boolean {
		return this.waiting.length > 0;
	}

	/** Holds the next take number for a recording that's starting, so a recording cut off keeps its place. */
	reserve(startedAt: Date): { session: string; take: number } {
		this.session ??= newSessionId(startedAt);
		return { session: this.session, take: this.nextTake++ };
	}

	add(capture: Capture, take?: number): void {
		this.session ??= newSessionId(capture.startedAt);
		this.waiting.push({ take: take ?? this.nextTake++, capture });
	}

	/** Writes everything waiting, oldest first. Throws if one can't be written; it and those after it stay waiting. */
	flush(): Promise<TFile | null> {
		const run = this.flushing.then(() => this.writeAll());
		this.flushing = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Gives up on what's waiting, when the person chooses to. */
	discard(): void {
		this.waiting.forEach(({ capture }) => void capture.draft?.remove().catch(() => undefined));
		this.waiting = [];
		this.failed = false;
	}

	private async writeAll(): Promise<TFile | null> {
		try {
			for (let next = this.waiting[0]; next; next = this.waiting[0]) {
				const marker = await saveTake(this.app, this.journalFolder, this.session ?? '', next.take, next.capture);
				this.first ??= marker;
				this.waiting.shift();
				// Only now that the marker exists can the parts behind it go
				await next.capture.draft?.remove().catch((error: unknown) => console.error('Jeong: could not tidy up a recording', error));
			}
			this.failed = false;
			return this.first;
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}
}
