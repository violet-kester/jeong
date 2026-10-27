// Demo only (?demo): stands in for the speech models, so the recording window can be tried without
// downloading them. Words arrive as if someone were talking: a quick guess first, then the phrase written.

import type { EngineEvents, Transcript } from '../src/transcribe/speech-engine';
import type { LiveTranscriptHandlers } from '../src/transcribe/live-transcriber';

const SCRIPT = [
	'Blake is in the kitchen while I sit in the dining room.',
	'It’s cold outside and the light around the mirror is on.',
	'We’re making his grandmother’s soup tonight, the one with the little dumplings.',
	'I think I’ll remember this one.',
];

/** The phrases "said" in this window so far, in order, for the final transcript. */
const spoken: string[] = [];
let said = 0;

export class SpeechEngine {
	constructor(_model: string, events: EngineEvents) {
		window.setTimeout(() => events.onReady('demo', 300, 'demo-speech', 'none'), 300);
	}
	dispose(): void {}
}

export class LiveTranscriber {
	skippedPartials = 0;
	private timer = 0;
	private words: string[] = [];
	private phrase = '';

	constructor(private handlers: LiveTranscriptHandlers) {}

	async listen(_stream: MediaStream): Promise<void> {
		this.timer = window.setInterval(() => this.next(), 260);
	}

	private next(): void {
		if (!this.words.length) {
			const line = SCRIPT[said % SCRIPT.length] ?? '';
			said++;
			this.words = line.split(' ');
			this.phrase = '';
		}
		this.phrase = `${this.phrase} ${this.words.shift() ?? ''}`.trim();
		this.handlers.onPartial(this.phrase);
		if (!this.words.length) {
			// As with the real models: the phrase ends, and its final words arrive while the next is being spoken
			const phrase = this.phrase;
			this.handlers.onPhraseEnd();
			window.setTimeout(() => this.write(phrase), 1400);
		}
	}

	private write(phrase: string): void {
		if (!phrase) return;
		spoken.push(phrase);
		this.handlers.onFinal(phrase);
		this.handlers.onTiming(40, 3000, true);
	}

	async finish(): Promise<void> {
		window.clearInterval(this.timer);
		if (this.words.length && this.phrase) {
			this.words = [];
			this.handlers.onPhraseEnd();
			this.write(this.phrase);
		}
	}
}

export async function transcribeRecording(_engine: SpeechEngine, _recording: Blob): Promise<Transcript> {
	await new Promise((resolve) => window.setTimeout(resolve, 700));
	const phrases = spoken.splice(0);
	return { text: phrases.join(' '), segments: phrases.map((text, i) => ({ start: i * 4, end: i * 4 + 4, text })), ms: 700, audioMs: phrases.length * 4000 };
}
