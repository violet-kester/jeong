import { App, Modal, Platform, TFile, moment, setIcon } from 'obsidian';
import { t } from '../i18n';
import { Recorder, type Recording } from '../audio/recorder';
import { VoiceHorizon } from './voice-horizon';
import { arrive, fade, leave } from './motion';
import { checkWebGpu } from '../diagnostics/webgpu';
import { deleteTemp, extensionFor, saveToTemp } from '../storage/temp-file';
import { addRecording, writeEntry } from '../journal/entry-writer';
import { saveLoosePage } from '../journal/loose-pages';
import { PhotoTray } from './photo-tray';
import { openButtonRound } from './open-button';
import { writeStory } from '../compose/write-story';
import type { Ollama } from '../compose/ollama';
import { paintMessage, storyMessage } from './story-messages';
import { LiveTranscriber } from '../transcribe/live-transcriber';
import { transcribeRecording } from '../transcribe/final-transcriber';
import { SpeechEngine, type EngineEvents, type Transcript } from '../transcribe/speech-engine';
import type { Metrics } from '../metrics/metrics';
import { TEST_SCRIPT, wordErrorRate } from '../metrics/word-error-rate';
import type { LiveMode } from '../settings';
import type { Painter } from '../paint/painter';
import { applyInk, type InkName } from '../paint/ink';
import { brushReveal } from '../paint/brush-reveal';

export interface RecordModalOptions {
	/** How the live transcript is written. */
	liveMode: LiveMode;
	/** Where entries are saved, inside the vault. */
	journalFolder: string;
	/** The local language model that writes stories and summaries. */
	ollama: Ollama;
	/** Show the test script and score both transcripts against it. */
	test?: boolean;
	/** Paints a picture for an entry without photos (on a computer), shown in `paintInk`. */
	painter?: Painter;
	paintInk?: InkName;
}

// The recording window, laid out like a letter: the date and photos down the left, and on the right
// a ruled page where your words appear as you talk. The words still being heard are in persimmon and
// settle into ink once they're written. Your voice runs along the bottom as a filled waveform into the
// big record button. When you stop, the page becomes the final transcript, and Open entry appears beside
// the button, which becomes Record more: talk again and it's added to the same entry.
export class RecordModal extends Modal {
	private recorder = new Recorder();
	private horizon: VoiceHorizon | null = null;
	private transcriber: LiveTranscriber | null = null;
	private moonshine: SpeechEngine | null = null;
	private whisper: SpeechEngine | null = null;
	private timerFrame = 0;
	private startedAt = new Date();
	private live = { ms: 0, audioMs: 0, phrases: 0, text: [] as string[] };
	private models = { live: '', final: '' };

	private button!: HTMLButtonElement;
	private status!: HTMLElement;
	private timer!: HTMLElement;
	private heading!: HTMLElement;
	private transcript!: HTMLElement;
	private partial!: HTMLElement;
	/** Phrases that have ended but whose final words haven't arrived yet, oldest first. */
	private wet: HTMLElement[] = [];
	private details!: HTMLElement;
	private modelRow!: HTMLElement;
	private speedRow!: HTMLElement;
	private finalRow!: HTMLElement;
	private comparison!: HTMLElement;
	/** The saved entry: Open entry opens it, and Record more adds to it. */
	private savedNote: TFile | null = null;
	private openButton!: HTMLButtonElement;
	private openAction!: HTMLElement;
	/** What's been said in this recording, on the page; each "Record more" starts a new one after it. */
	private take!: HTMLElement;
	private note: HTMLElement | null = null;
	/** The story, in its own pane beside your words, once the entry is saved. */
	private storyPane: HTMLElement | null = null;
	/** The entry's title, at the top of the page once the story has named it. */
	private title: HTMLElement | null = null;
	private totalMs = 0;
	private photosSaved = 0;
	/** The left column: the date, then the photos, then (once saved, without photos) Illustrate. */
	private side: HTMLElement | null = null;
	private photos!: PhotoTray;

	constructor(
		app: App,
		private metrics: Metrics,
		private options: RecordModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('jeong', 'jeong-record');
		// The window rises gently into place over a softly dimming background
		arrive(this.modalEl);
		const background = this.containerEl.querySelector<HTMLElement>('.modal-bg');
		if (background) void fade(background, 'in');
		const { contentEl } = this;
		const now = moment();
		// With no live words to show (on a phone), the window is just the button
		if (this.onPhone) {
			this.buildVoiceOnly(now);
			return;
		}

		// Left: the date, like the top of a letter, and the photos
		const side = (this.side = contentEl.createDiv({ cls: 'jeong-entry-side' }));
		side.createDiv({ cls: 'jeong-entry-day', text: now.format('D') });
		side.createDiv({ cls: 'jeong-entry-month', text: now.format('MMMM') });
		side.createDiv({ cls: 'jeong-entry-when', text: now.format('dddd · LT') });
		this.photos = new PhotoTray(side);
		side.createDiv({ cls: 'jeong-entry-label', text: t('record.photos') });

		// Right: the page
		const main = contentEl.createDiv({ cls: 'jeong-entry-main' });
		if (this.options.test) {
			main.createDiv({ cls: 'jeong-test-intro', text: t('test.intro') });
			main.createDiv({ cls: 'jeong-test-script', text: TEST_SCRIPT });
		}
		this.heading = main.createDiv({ cls: 'jeong-entry-heading', text: t(this.options.test ? 'test.title' : 'record.prompt') });
		const hint = t(this.onPhone ? 'record.transcriptHintPhone' : 'record.transcriptHint');
		this.transcript = main.createDiv({ cls: 'jeong-transcript is-empty', attr: { 'data-placeholder': hint } });
		this.take = this.transcript.createSpan({ cls: 'jeong-take' });
		this.partial = this.take.createSpan({ cls: 'jeong-transcript-partial' });
		// Fade the page's edges only where there's more to scroll to
		this.registerFades();
		this.comparison = main.createDiv({ cls: 'jeong-comparison' });

		// The bottom: your voice running into the buttons, with the status underneath
		const foot = main.createDiv({ cls: 'jeong-entry-foot' });
		const voice = foot.createEl('canvas', { cls: 'jeong-entry-voice' });
		this.status = foot.createDiv({ cls: 'jeong-record-status', text: t(this.onPhone ? 'record.readyPhone' : 'record.ready') });
		const control = foot.createDiv({ cls: 'jeong-entry-control' });
		// Open entry: shown once the entry is saved
		({ action: this.openAction, button: this.openButton } = openButtonRound(control, () => this.openSaved()));
		// Record, stop, and Record more; the time shows under it while recording
		const recordAction = control.createDiv({ cls: 'jeong-entry-action' });
		this.button = recordAction.createEl('button', { cls: 'jeong-record-button' });
		this.timer = recordAction.createDiv({ cls: 'jeong-record-timer', text: '0:00' });
		this.setButton(false);
		this.button.addEventListener('click', () => void this.toggle());
		this.horizon = new VoiceHorizon(voice, this.button, this.openButton);
		window.requestAnimationFrame(() => this.horizon?.draw());

		// The technical details are useful for testing, so they're one click away but folded up
		const more = main.createEl('details', { cls: 'jeong-record-more' });
		more.createEl('summary', { text: t('record.details') });
		this.details = more.createDiv({ cls: 'jeong-record-details' });
		// Phones can't run the speech models: record only, and write it up on a computer later
		if (this.onPhone) return;
		this.modelRow = this.addDetail(t('check.liveModel'), t('check.loading'));
		this.speedRow = this.addDetail(t('check.speed'), '—');
		this.finalRow = this.addDetail(t('check.finalModel'), t('check.loading'));
		void this.showSystemCheck();
		this.startTranscribers();
	}

	/**
	 * Just the button: for when there are no live words (on a phone). The date, one big round button with
	 * rings that swell with your voice, the time, and Add photos and Details waiting quietly at the bottom.
	 */
	private buildVoiceOnly(now: moment.Moment): void {
		this.modalEl.addClass('is-voice-only');
		const main = this.contentEl.createDiv({ cls: 'jeong-voice' });
		// Today, so no year: short enough to sit on one line, clear of the close button
		main.createDiv({ cls: 'jeong-voice-date', text: now.format('ddd, MMM D · LT') });

		const orb = main.createDiv({ cls: 'jeong-voice-orb' });
		const voice = orb.createEl('canvas', { cls: 'jeong-entry-voice' });
		const control = orb.createDiv({ cls: 'jeong-entry-control' });
		({ action: this.openAction, button: this.openButton } = openButtonRound(control, () => this.openSaved()));
		const recordAction = control.createDiv({ cls: 'jeong-entry-action' });
		this.button = recordAction.createEl('button', { cls: 'jeong-record-button' });
		this.timer = recordAction.createDiv({ cls: 'jeong-record-timer', text: '0:00' });

		this.heading = main.createDiv({ cls: 'jeong-entry-heading', text: t('record.tapToStart') });
		this.status = main.createDiv({ cls: 'jeong-record-status', text: t('record.voiceOnlyHint') });
		// Not shown here, but recording still keeps its place in them
		this.transcript = main.createDiv({ cls: 'jeong-transcript is-hidden' });
		this.take = this.transcript.createSpan({ cls: 'jeong-take' });
		this.partial = this.take.createSpan({ cls: 'jeong-transcript-partial' });
		this.comparison = main.createDiv({ cls: 'jeong-comparison is-hidden' });

		const foot = main.createDiv({ cls: 'jeong-voice-foot' });
		this.photos = new PhotoTray(foot, t('photos.addShort'));
		const more = foot.createEl('details', { cls: 'jeong-record-more' });
		const summary = more.createEl('summary');
		setIcon(summary.createSpan({ cls: 'jeong-voice-pill-icon' }), 'align-left');
		summary.createSpan({ text: t('record.details') });
		this.details = more.createDiv({ cls: 'jeong-record-details' });

		this.setButton(false);
		this.button.addEventListener('click', () => void this.toggle());
		this.horizon = new VoiceHorizon(voice, this.button, this.openButton, 'rings');
		window.requestAnimationFrame(() => this.horizon?.draw());
	}

	private get voiceOnly(): boolean {
		return this.modalEl.hasClass('is-voice-only');
	}

	/** The big button: a microphone to start, a square to stop. */
	private setButton(recording: boolean): void {
		const more = !recording && this.savedNote !== null;
		this.button.empty();
		this.button.toggleClass('is-recording', recording);
		this.button.toggleClass('is-more', more);
		this.button.setAttribute('aria-label', t(recording ? 'record.stop' : more ? 'record.more' : 'record.start'));
		setIcon(this.button.createSpan({ cls: 'jeong-record-button-icon' }), recording ? 'square' : 'mic');
		this.timer.toggleClass('is-label', more);
		if (more) this.timer.setText(t('record.more'));
		this.heading.toggleClass('is-recording', recording);
		if (recording) {
			this.heading.removeClass('is-saved');
			this.heading.setText(t('record.recording.heading'));
		} else if (!this.savedNote && !this.options.test) {
			this.heading.setText(t(this.voiceOnly ? 'record.tapToStart' : 'record.prompt'));
		}
	}

	private openSaved(): void {
		if (!this.savedNote) return;
		void this.app.workspace.getLeaf(false).openFile(this.savedNote);
		this.close();
	}

	/** Closing: the window settles and fades, and the background lightens, before it goes. */
	close(): void {
		if (this.closing) return;
		this.closing = true;
		const background = this.containerEl.querySelector<HTMLElement>('.modal-bg');
		void Promise.all([leave(this.modalEl, () => undefined), background ? fade(background, 'out') : Promise.resolve()]).then(() => super.close());
	}

	private closing = false;

	private get onPhone(): boolean {
		return Platform.isMobile;
	}

	onClose(): void {
		this.horizon?.dispose();
		window.cancelAnimationFrame(this.timerFrame);
		this.recorder.release();
		this.photos?.dispose();
		this.moonshine?.dispose();
		this.whisper?.dispose();
		this.contentEl.empty();
	}

	// Load both models as soon as the panel opens, so they're ready by the time you talk.
	// Moonshine makes quick guesses; one shared Whisper writes each phrase and the final transcript.
	private startTranscribers(): void {
		this.moonshine = new SpeechEngine('moonshine-base', this.engineEvents('live', this.modelRow));
		this.whisper = new SpeechEngine('whisper-turbo', this.engineEvents('final', this.finalRow));
		const writer = this.options.liveMode === 'hybrid' ? this.whisper : this.moonshine;

		this.transcriber = new LiveTranscriber(
			{
				onPartial: (text) => {
					this.partial.setText(text);
					this.transcript.scrollTop = this.transcript.scrollHeight;
					if (text) this.transcript.removeClass('is-empty');
				},
				// A finished phrase keeps its guessed words, still wet, in place while the next phrase is
				// guessed after it; when its final words arrive they replace the guess there and dry to ink
				onPhraseEnd: () => {
					const wet = createSpan({ cls: 'jeong-transcript-partial', text: this.partial.getText() ? `${this.partial.getText()} ` : '' });
					this.take.insertBefore(wet, this.partial);
					this.wet.push(wet);
					this.partial.setText('');
				},
				onFinal: (text) => {
					const wet = this.wet.shift();
					if (text) {
						this.live.text.push(text);
						const final = inkWords(text);
						if (wet?.isConnected) wet.replaceWith(final);
						else this.take.insertBefore(final, this.partial);
						this.transcript.removeClass('is-empty');
					} else {
						wet?.remove();
					}
					this.live.phrases++;
					this.transcript.scrollTop = this.transcript.scrollHeight;
				},
				onTiming: (ms, audioMs, final) => {
					// All the models' work counts, but only finished phrases count as speech heard
					this.live.ms += ms;
					if (final) this.live.audioMs += audioMs;
					const factor = this.live.audioMs / Math.max(1, this.live.ms);
					this.speedRow.setText(`${factor.toFixed(1)}× ${t('check.fasterThanSpeech')} · ${Math.round(ms)} ms ${t('check.lastPhrase')}`);
				},
			},
			this.moonshine,
			writer,
		);
	}

	private engineEvents(kind: 'live' | 'final', row: HTMLElement): EngineEvents {
		return {
			onStage: (stage) => row.setText(t(stage === 'loading' ? 'check.loading' : 'check.warming')),
			onProgress: (percent) => row.setText(`${t('check.downloading')} ${percent}%`),
			onReady: (device, loadMs, model, precision) => {
				this.models[kind] = model;
				row.setText(`${shortName(model)} · ${device} · ${t('check.readyIn')} ${(loadMs / 1000).toFixed(1)} s`);
				this.metrics.log({ event: 'model_load', kind, model, device, precision, loadMs: Math.round(loadMs) });
			},
			onError: (message) => {
				console.error(`Jeong ${kind} transcript:`, message);
				row.setText(`${t('check.error')}: ${message}`);
				this.metrics.log({ event: 'error', where: `${kind}-transcript`, message });
			},
		};
	}

	/** The name logged for the live transcript, e.g. "moonshine-base-ONNX + whisper-large-v3-turbo". */
	private get liveLabel(): string {
		const guesser = shortName(this.models.live);
		return this.options.liveMode === 'hybrid' ? `${guesser} + ${shortName(this.models.final)}` : guesser;
	}

	private async toggle(): Promise<void> {
		if (this.recorder.analyser) await this.stop();
		else await this.start();
	}

	private async start(): Promise<void> {
		try {
			await this.recorder.start();
		} catch {
			this.status.setText(t('record.noMicrophone'));
			this.metrics.log({ event: 'error', where: 'microphone', message: 'Could not start the microphone' });
			return;
		}
		if (!this.recorder.analyser || !this.recorder.stream) return;
		this.startedAt = new Date();
		// Record more: what you say now goes on the page after what's already there
		if (this.savedNote) {
			this.take = this.transcript.createSpan({ cls: 'jeong-take' });
			this.take.appendChild(this.partial);
		}
		void leave(this.openAction);
		this.horizon?.start(this.recorder.analyser);
		await this.transcriber?.listen(this.recorder.stream);
		this.setButton(true);
		this.status.setText(t('record.recording'));
		const tick = () => {
			const seconds = Math.floor(this.recorder.elapsedMs / 1000);
			this.timer.setText(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
			this.timerFrame = window.requestAnimationFrame(tick);
		};
		tick();
	}

	private async stop(): Promise<void> {
		this.horizon?.stop();
		window.cancelAnimationFrame(this.timerFrame);
		const liveDone = this.transcriber?.finish() ?? Promise.resolve();
		const recording = await this.recorder.stop();
		this.totalMs += recording.durationMs;
		this.setButton(false);
		this.button.disabled = true;
		this.heading.removeClass('is-saved');
		this.heading.setText(t('record.writingDown'));
		this.status.setText(t('record.saving'));
		this.addDetail(t('check.format'), recording.mimeType || t('check.unknown'));
		this.metrics.log({
			event: 'recording',
			durationMs: Math.round(recording.durationMs),
			bytes: recording.blob.size,
			kbps: Math.round((recording.blob.size * 8) / Math.max(1, recording.durationMs)),
			mimeType: recording.mimeType,
		});

		if (this.onPhone) {
			await this.saveLoose(recording);
			return;
		}

		// Keep a safe copy first, outside the vault, so nothing is lost if anything below fails
		const tempPath = await this.saveTemp(recording.blob, recording.mimeType);

		// Whisper finishes the live phrases first (same queue), then reads the whole recording
		this.status.setText(t('compare.reading'));
		let result: Transcript | null = null;
		try {
			if (this.whisper) result = await transcribeRecording(this.whisper, recording.blob);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.status.setText(`${t('check.error')}: ${message}`);
			this.metrics.log({ event: 'error', where: 'final-transcript', message });
		}
		await liveDone;
		this.logLive();
		this.button.disabled = false;
		if (!result) {
			this.status.setText(t('record.keptInTemp'));
			return;
		}
		this.showFinal(result.text, result.ms, result.audioMs);

		if (this.options.test) {
			this.status.setText(t('record.saved'));
			return;
		}
		if (this.savedNote) await this.addToEntry(this.savedNote, recording, result, tempPath);
		else await this.saveEntry(recording, result, tempPath);
	}

	/** Record more: adds this recording to the entry already saved, then writes the story again from everything. */
	private async addToEntry(note: TFile, recording: Recording, result: Transcript, tempPath: string | null): Promise<void> {
		this.status.setText(t('record.writing'));
		try {
			await addRecording(this.app, note, {
				recording: recording.blob,
				mimeType: recording.mimeType,
				durationMs: recording.durationMs,
				startedAt: this.startedAt,
				transcript: result.text,
				segments: result.segments ?? [],
				engine: `jeong-plugin ${this.metrics.version} · ${shortName(this.models.final)}`,
				language: this.language,
				photos: this.photoFiles().slice(this.photosSaved),
			});
			this.photosSaved = this.photos.photos.length;
			if (tempPath) await deleteTemp(tempPath);
			this.status.setText(t('record.savedEntry'));
			this.showSaved(note);
			this.showStoryPane();
			const written = await writeStory(this.app, this.options.ollama, this.metrics, note, (progress) => this.status.setText(storyMessage(progress)));
			await this.fillStory(note, written);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not add the recording', error);
			this.status.setText(t('record.entryFailed'));
			this.button.disabled = false;
			this.metrics.log({ event: 'error', where: 'add-recording', message });
		}
	}

	private async saveEntry(recording: Recording, result: Transcript, tempPath: string | null): Promise<void> {
		this.status.setText(t('record.writing'));
		const started = performance.now();
		try {
			const note = await writeEntry(this.app, this.options.journalFolder, {
				recording: recording.blob,
				mimeType: recording.mimeType,
				durationMs: recording.durationMs,
				startedAt: this.startedAt,
				transcript: result.text,
				segments: result.segments ?? [],
				engine: `jeong-plugin ${this.metrics.version} · ${shortName(this.models.final)}`,
				language: this.language,
				photos: this.photoFiles(),
			});
			this.metrics.log({
				event: 'entry_saved',
				durationMs: Math.round(recording.durationMs),
				words: result.text.split(/\s+/).filter(Boolean).length,
				ms: Math.round(performance.now() - started),
			});
			if (tempPath) await deleteTemp(tempPath);
			this.photosSaved = this.photos.photos.length;
			this.status.setText(t('record.savedEntry'));
			this.showSaved(note);
			// Turn the transcript into a story, in the background; the entry is already safe
			this.showStoryPane();
			const written = await writeStory(this.app, this.options.ollama, this.metrics, note, (progress) => this.status.setText(storyMessage(progress)));
			await this.fillStory(note, written);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not write the entry', error);
			this.status.setText(t('record.entryFailed'));
			this.metrics.log({ event: 'error', where: 'write-entry', message });
		}
	}

	private photoFiles() {
		return this.photos.photos.map(({ file }) => ({ name: file.name, type: file.type, data: file }));
	}

	/** On a phone: save the recording to Loose pages, to be written up on a computer later. */
	private async saveLoose(recording: Recording): Promise<void> {
		try {
			const note = await saveLoosePage(this.app, this.options.journalFolder, {
				recording: recording.blob,
				mimeType: recording.mimeType,
				durationMs: recording.durationMs,
				startedAt: this.startedAt,
				language: this.language,
				photos: this.photoFiles(),
			});
			this.status.setText(t('record.savedLoose'));
			this.showSaved(note);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Jeong: could not save the recording', error);
			this.status.setText(t('record.saveFailed'));
			this.button.disabled = false;
			this.metrics.log({ event: 'error', where: 'save-loose', message });
		}
	}

	/** Saves the recording to the temp folder and shows where. Returns the path, or null if that isn't possible. */
	private async saveTemp(blob: Blob, mimeType: string): Promise<string | null> {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		try {
			const path = await saveToTemp(blob, `recording-${stamp}.${extensionFor(mimeType)}`);
			this.addDetail(t('check.saved'), path ? `${path} (${Math.round(blob.size / 1024)} KB)` : t('check.savedLater'));
			return path;
		} catch (error) {
			console.error('Jeong: could not save the recording', error);
			this.metrics.log({ event: 'error', where: 'save', message: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	private logLive(): void {
		if (!this.live.audioMs) return;
		this.metrics.log({
			event: 'transcribe',
			kind: 'live',
			model: this.liveLabel,
			audioMs: Math.round(this.live.audioMs),
			ms: Math.round(this.live.ms),
			speed: round(this.live.audioMs / Math.max(1, this.live.ms)),
			phrases: this.live.phrases,
			skippedPartials: this.transcriber?.skippedPartials ?? 0,
		});
	}

	/** Best guess at the spoken language until the models detect it: Obsidian's display language. */
	private get language(): string {
		return moment.locale().split('-')[0] ?? 'en';
	}

	private registerFades(): void {
		const update = () => {
			const { scrollTop, scrollHeight, clientHeight } = this.transcript;
			this.transcript.toggleClass('more-above', scrollTop > 2);
			this.transcript.toggleClass('more-below', scrollTop + clientHeight < scrollHeight - 2);
		};
		this.transcript.addEventListener('scroll', update);
		new ResizeObserver(update).observe(this.transcript);
		new MutationObserver(update).observe(this.transcript, { childList: true, subtree: true, characterData: true });
	}

	/** The entry is saved: the heading says so, and the big button opens it. */
	private showSaved(note: TFile): void {
		this.savedNote = note;
		this.heading.setText(t('record.savedHeading'));
		this.heading.addClass('is-saved');
		this.button.disabled = false;
		this.setButton(false);
		arrive(this.openAction);
		window.requestAnimationFrame(() => this.horizon?.draw());
		// Illustrate, under the photos (once; Record more keeps the same one)
		if (this.side && !this.side.querySelector('.jeong-entry-painting')) this.illustration(this.side, note);
	}

	/** Opens the story pane beside the page (or clears it for a new story), saying it's being written. */
	private showStoryPane(): void {
		if (!this.storyPane) {
			this.storyPane = this.contentEl.createDiv({ cls: 'jeong-entry-story' });
			this.modalEl.addClass('has-story');
			arrive(this.storyPane);
		}
		this.storyPane.empty();
		this.storyPane.createDiv({ cls: 'jeong-entry-story-label', text: t('record.yourStory') });
		this.storyPane.createDiv({ cls: 'jeong-entry-story-waiting', text: t('record.writingStory') });
	}

	/** Fills the story pane from the saved entry: its title, summary, and story. */
	private async fillStory(note: TFile, written: boolean): Promise<void> {
		const pane = this.storyPane;
		if (!pane) return;
		pane.empty();
		pane.createDiv({ cls: 'jeong-entry-story-label', text: t('record.yourStory') });
		if (!written) {
			pane.createDiv({ cls: 'jeong-entry-story-waiting', text: t('record.storyLater') });
			return;
		}
		const content = await this.app.vault.read(note);
		const summary = /^summary:\s*(.+)$/m.exec(content)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
		this.showTitle(note.basename);
		if (summary) pane.createDiv({ cls: 'jeong-entry-story-summary', text: summary });
		const body = pane.createDiv({ cls: 'jeong-entry-story-body' });
		for (const paragraph of storyText(content).split(/\n\s*\n/)) {
			if (paragraph.trim()) body.createEl('p', { text: paragraph.trim() });
		}
	}

	/**
	 * In the left column, once the entry is saved: Illustrate paints a picture for it, on this
	 * computer, and brushes it in. An entry that already has a painting shows it, and Illustrate paints it again.
	 */
	private illustration(column: HTMLElement, note: TFile): void {
		const painter = this.options.painter;
		if (!painter || Platform.isMobile) return;
		applyInk(column, this.options.paintInk ?? 'black');
		const art = column.createDiv({ cls: 'jeong-entry-painting' });
		arrive(art);
		const frame = art.createDiv({ cls: 'jeong-entry-painting-frame jeong-painting' });
		const brush = art.createEl('button', { cls: 'jeong-entry-illustrate' });
		setIcon(brush.createSpan({ cls: 'jeong-entry-illustrate-icon' }), 'paintbrush');
		const label = brush.createSpan({ text: t('paint.illustrate') });

		const painted = () => {
			const name: unknown = this.app.metadataCache.getFileCache(note)?.frontmatter?.painting;
			const file = typeof name === 'string' && note.parent ? this.app.vault.getAbstractFileByPath(`${note.parent.path}/${name}`) : null;
			return file instanceof TFile ? file : null;
		};
		const existing = painted();
		if (existing) {
			frame.addClass('is-open');
			frame.createEl('img', { attr: { src: this.app.vault.getResourcePath(existing), alt: '' } });
			label.setText(t('paint.illustrateAgain'));
		}

		brush.addEventListener('click', () => {
			if (painter.isPainting(note)) return;
			brush.disabled = true;
			brush.addClass('is-painting');
			label.setText(t('paint.painting'));
			art.addClass('is-painting');
			void painter
				.paint(note, (progress) => this.status.setText(paintMessage(progress)))
				.then((done) => {
					art.removeClass('is-painting');
					brush.removeClass('is-painting');
					brush.disabled = false;
					const file = done ? painted() : null;
					label.setText(t(file || existing ? 'paint.illustrateAgain' : 'paint.illustrate'));
					if (!file) return;
					// Shown here, so the timeline behind doesn't brush it in a second time
					painter.takeFresh(note);
					frame.empty();
					frame.addClass('is-open');
					// The frame opens first; the strokes start once it has its size
					window.setTimeout(() => brushReveal(frame, this.app.vault.getResourcePath(file)), 560);
				});
		});
	}

	/** The title settles in at the top of the page, above "Saved to your journal". */
	private showTitle(text: string): void {
		if (!this.title) {
			this.title = createDiv({ cls: 'jeong-entry-title' });
			this.heading.before(this.title);
		}
		this.title.setText(text);
		// Restart the arrival each time (a story rewritten after Record more may bring a new title)
		this.title.removeClass('is-arriving');
		void this.title.offsetWidth;
		this.title.addClass('is-arriving');
	}

	/** The page becomes the final transcript, word for word, drying from persimmon to ink. */
	private showWritten(text: string): void {
		const seconds = Math.round(this.totalMs / 1000);
		if (!this.note) {
			this.note = createDiv({ cls: 'jeong-entry-note' });
			this.heading.after(this.note);
		}
		this.note.setText(`${t('record.wordForWord')} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
		// This recording's live words are replaced by the final ones; earlier recordings stay above
		this.take.empty();
		this.wet = [];
		this.take.createSpan({ cls: 'jeong-transcript-final', text: `${text} ` });
		this.take.appendChild(this.partial);
		this.transcript.removeClass('is-empty');
		this.transcript.scrollTop = this.take.offsetTop - this.transcript.offsetTop;
	}

	private showFinal(text: string, ms: number, audioMs: number): void {
		const speed = `${(ms / 1000).toFixed(1)} s ${t('compare.toRead')} ${(audioMs / 1000).toFixed(0)} s · ${(audioMs / Math.max(1, ms)).toFixed(1)}× ${t('check.fasterThanSpeech')}`;
		this.addDetail(t('check.finalSpeed'), speed);
		// The test compares both transcripts side by side; a real entry just shows the final words on the page
		if (this.options.test) {
			this.comparison.empty();
			this.comparison.createDiv({ cls: 'jeong-comparison-label', text: t('compare.whisper') });
			this.comparison.createDiv({ cls: 'jeong-comparison-text', text: text || '—' });
		} else {
			this.showWritten(text || '—');
		}
		this.metrics.log({
			event: 'transcribe',
			kind: 'final',
			model: this.models.final,
			audioMs: Math.round(audioMs),
			ms: Math.round(ms),
			speed: round(audioMs / Math.max(1, ms)),
		});

		if (!this.options.test) return;
		const liveText = this.live.text.join(' ');
		const liveWer = wordErrorRate(TEST_SCRIPT, liveText);
		const finalWer = wordErrorRate(TEST_SCRIPT, text);
		const referenceWords = TEST_SCRIPT.split(/\s+/).length;
		this.metrics.log({ event: 'quality', kind: 'live', model: this.liveLabel, wer: round(liveWer), referenceWords });
		this.metrics.log({ event: 'quality', kind: 'final', model: this.models.final, wer: round(finalWer), referenceWords });
		this.comparison.createDiv({
			cls: 'jeong-comparison-score',
			text: `${t('test.wordsWrong')}: ${t('test.live')} ${percent(liveWer)} · ${t('test.final')} ${percent(finalWer)}`,
		});
	}

	private async showSystemCheck(): Promise<void> {
		const gpu = await checkWebGpu();
		this.addDetail(t('check.webgpu'), gpu.available ? gpu.adapter ?? t('check.yes') : t('check.no'));
	}

	/** Adds a label/value row to the details and returns the value element, so it can be updated. */
	private addDetail(label: string, value: string): HTMLElement {
		const row = this.details.createDiv({ cls: 'jeong-record-detail' });
		row.createSpan({ cls: 'jeong-record-detail-label', text: label });
		return row.createSpan({ text: value });
	}
}

/** The story from an entry note: without the frontmatter, players, photos, links line, or notes. */
function storyText(content: string): string {
	return content
		.replace(/^---\n[\s\S]*?\n---\n/, '')
		.split('\n')
		.filter((line) => !/^\s*(!\[\[|\*\[\[|>)/.test(line))
		.join('\n')
		.trim();
}

/** "onnx-community/whisper-large-v3-turbo" → "whisper-large-v3-turbo" */
export function shortName(model: string): string {
	return model.split('/').pop() ?? model;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** A finished live phrase, one span per word, so the ink can dry word by word (see .jeong-ink-word). */
function inkWords(text: string): HTMLElement {
	const phrase = createSpan({ cls: 'jeong-transcript-final is-words' });
	text.split(/\s+/).filter(Boolean).forEach((word, i) => {
		phrase.createSpan({ cls: 'jeong-ink-word', text: `${word} ` }).style.setProperty('--i', String(i));
	});
	return phrase;
}
