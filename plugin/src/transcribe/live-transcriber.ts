// Live transcript while recording. Listens to the microphone at 16 kHz, splits speech
// into phrases at natural pauses, and writes words two ways, like ink drying:
// - light ink: a quick guess at the phrase so far, from a small fast model (Moonshine)
// - full ink:  once you pause, an accurate model (Whisper) reads the finished phrase

import type { SpeechEngine } from './speech-engine';
import { normalizeLoudness } from '../audio/loudness';

const SAMPLE_RATE = 16_000;
const PARTIAL_EVERY_MS = 500;
const PAUSE_ENDS_PHRASE_MS = 700;
const LONGEST_PHRASE_MS = 15_000;
const LEAD_IN_MS = 300; // keep a little audio from just before speech starts
const SHORTEST_PHRASE_MS = 400; // anything shorter is a cough, a click, or a breath

// Whisper sometimes "hears" these in near-silence. Ignore them when the phrase was short.
const GHOST_PHRASES = new Set(['mm', 'mhm', 'hmm', 'um', 'uh', 'you', 'bye', 'thank you', 'thanks for watching', 'thank you for watching']);
const GHOST_MAX_SPEECH_MS = 1_500;

// Captures raw audio from the microphone, 128 samples at a time
const CAPTURE_WORKLET = `
class JeongCapture extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (channel) this.port.postMessage(channel.slice(0));
		return true;
	}
}
registerProcessor('jeong-capture', JeongCapture);
`;

export interface LiveTranscriptHandlers {
	onPartial(text: string): void;
	onFinal(text: string): void;
	/** final is true for finished phrases; quick guesses count as work, not as new speech. */
	onTiming(ms: number, audioMs: number, final: boolean): void;
}

export class LiveTranscriber {
	/** Quick guesses skipped because the guessing model was still busy (a sign it can't keep up). */
	skippedPartials = 0;

	private context: AudioContext | null = null;
	private worklet: AudioWorkletNode | null = null;
	private phrase: Float32Array[] = [];
	private phraseNumber = 0;
	private leadIn: Float32Array[] = [];
	private speaking = false;
	private silenceMs = 0;
	private phraseMs = 0;
	private lastPartialAt = 0;
	private noiseFloor = 0.004;
	private finals: Promise<void> = Promise.resolve();

	constructor(
		private handlers: LiveTranscriptHandlers,
		private guesser: SpeechEngine,
		private writer: SpeechEngine,
	) {}

	async listen(stream: MediaStream): Promise<void> {
		this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
		const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
		await this.context.audioWorklet.addModule(moduleUrl);
		URL.revokeObjectURL(moduleUrl);
		this.worklet = new AudioWorkletNode(this.context, 'jeong-capture');
		this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.onAudio(event.data);
		this.context.createMediaStreamSource(stream).connect(this.worklet);
	}

	/** Stop listening, write whatever was said last, and resolve once every phrase is in full ink. */
	async finish(): Promise<void> {
		if (this.phrase.length) this.endPhrase();
		void this.context?.close();
		this.context = null;
		this.worklet = null;
		await this.finals;
	}

	private onAudio(chunk: Float32Array): void {
		const chunkMs = (chunk.length / SAMPLE_RATE) * 1000;
		let sum = 0;
		for (const sample of chunk) sum += sample * sample;
		const loudness = Math.sqrt(sum / chunk.length);
		const isSpeech = loudness > Math.max(0.008, this.noiseFloor * 3);
		if (!isSpeech) this.noiseFloor = this.noiseFloor * 0.995 + loudness * 0.005;

		if (!this.speaking) {
			// Keep a short lead-in so the first syllable isn't clipped
			this.leadIn.push(chunk);
			while (this.leadIn.length * chunkMs > LEAD_IN_MS) this.leadIn.shift();
			if (!isSpeech) return;
			this.speaking = true;
			this.phrase = [...this.leadIn];
			this.leadIn = [];
			this.phraseMs = this.phrase.length * chunkMs;
			this.silenceMs = 0;
			return;
		}

		this.phrase.push(chunk);
		this.phraseMs += chunkMs;
		this.silenceMs = isSpeech ? 0 : this.silenceMs + chunkMs;

		if (this.silenceMs >= PAUSE_ENDS_PHRASE_MS || this.phraseMs >= LONGEST_PHRASE_MS) {
			this.endPhrase();
		} else if (performance.now() - this.lastPartialAt >= PARTIAL_EVERY_MS) {
			this.guess();
		}
	}

	/** Light ink: a quick guess at the phrase so far. Skipped if the guesser is still busy. */
	private guess(): void {
		if (this.guesser.busy) {
			this.skippedPartials++;
			return;
		}
		this.lastPartialAt = performance.now();
		const phraseNumber = this.phraseNumber;
		this.guesser
			.transcribe(normalizeLoudness(join(this.phrase)))
			.then((result) => {
				this.handlers.onTiming(result.ms, result.audioMs, false);
				// Only show it if that phrase is still being spoken
				if (phraseNumber === this.phraseNumber) this.handlers.onPartial(result.text);
			})
			.catch(() => undefined);
	}

	/** Full ink: the accurate model reads the finished phrase. Phrases are written in order. */
	private endPhrase(): void {
		const speechMs = this.phraseMs - this.silenceMs;
		const audio = normalizeLoudness(join(this.phrase));
		this.phrase = [];
		this.phraseNumber++;
		this.speaking = false;
		this.silenceMs = 0;
		this.phraseMs = 0;
		if (speechMs < SHORTEST_PHRASE_MS) {
			this.handlers.onPartial('');
			return;
		}
		const written = this.writer.transcribe(audio);
		this.finals = this.finals.then(async () => {
			try {
				const result = await written;
				this.handlers.onTiming(result.ms, result.audioMs, true);
				this.handlers.onFinal(isGhost(result.text, speechMs) ? '' : result.text);
			} catch {
				this.handlers.onFinal('');
			}
		});
	}
}

function isGhost(text: string, speechMs: number): boolean {
	const normalized = text.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim();
	return !normalized || (speechMs < GHOST_MAX_SPEECH_MS && GHOST_PHRASES.has(normalized));
}

function join(chunks: Float32Array[]): Float32Array {
	const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
	const audio = new Float32Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		audio.set(chunk, offset);
		offset += chunk.length;
	}
	return audio;
}
