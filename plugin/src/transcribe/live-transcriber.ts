// Live transcript while recording. Listens to the microphone at 16 kHz, splits speech
// into phrases at natural pauses, and asks the worker for words as you talk:
// - partial: the phrase so far, re-read every half second (shown in light ink)
// - final: the whole phrase once you pause (shown in full ink)

import workerCode from './live.worker?worker';
import type { WorkerRequest, WorkerResponse } from './messages';

const SAMPLE_RATE = 16_000;
const PARTIAL_EVERY_MS = 500;
const PAUSE_ENDS_PHRASE_MS = 700;
const LONGEST_PHRASE_MS = 15_000; // Moonshine works best on short stretches
const LEAD_IN_MS = 300; // keep a little audio from just before speech starts

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
	onStage(stage: 'loading' | 'warming'): void;
	onProgress(percent: number): void;
	onReady(device: string, loadMs: number): void;
	onPartial(text: string): void;
	onFinal(text: string): void;
	onTiming(ms: number, audioMs: number): void;
	onError(message: string): void;
}

export class LiveTranscriber {
	private worker: Worker;
	private workerUrl: string;
	private context: AudioContext | null = null;
	private worklet: AudioWorkletNode | null = null;

	private ready = false;
	private busy = false;
	private nextId = 0;
	private pendingFinals: Float32Array[] = [];

	private phrase: Float32Array[] = [];
	private leadIn: Float32Array[] = [];
	private speaking = false;
	private silenceMs = 0;
	private phraseMs = 0;
	private lastPartialAt = 0;
	private noiseFloor = 0.004;

	constructor(private handlers: LiveTranscriptHandlers) {
		this.workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
		this.worker = new Worker(this.workerUrl, { type: 'module' });
		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
		// Errors the worker can't report itself, such as failing to start at all
		this.worker.onerror = (event: ErrorEvent) => this.handlers.onError(event.message || 'The transcription worker stopped unexpectedly');
		this.post({ type: 'load', kind: 'live' });
	}

	async listen(stream: MediaStream): Promise<void> {
		this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
		const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
		await this.context.audioWorklet.addModule(moduleUrl);
		URL.revokeObjectURL(moduleUrl);
		this.worklet = new AudioWorkletNode(this.context, 'jeong-capture');
		this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.onAudio(event.data);
		this.context.createMediaStreamSource(stream).connect(this.worklet);
	}

	/** Stop listening and transcribe whatever was said last. */
	finish(): void {
		if (this.phrase.length) this.endPhrase();
		void this.context?.close();
		this.context = null;
		this.worklet = null;
	}

	dispose(): void {
		this.finish();
		this.worker.terminate();
		URL.revokeObjectURL(this.workerUrl);
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
			this.requestPartial();
		}
	}

	private requestPartial(): void {
		// Skip if the worker is still busy, so it never falls behind; the next one catches up
		if (!this.ready || this.busy || this.pendingFinals.length) return;
		this.lastPartialAt = performance.now();
		this.send(join(this.phrase), false);
	}

	private endPhrase(): void {
		this.pendingFinals.push(join(this.phrase));
		this.phrase = [];
		this.speaking = false;
		this.silenceMs = 0;
		this.phraseMs = 0;
		this.drain();
	}

	private drain(): void {
		if (!this.ready || this.busy) return;
		const next = this.pendingFinals.shift();
		if (next) this.send(next, true);
	}

	private send(audio: Float32Array, final: boolean): void {
		this.busy = true;
		const message: WorkerRequest = { type: 'transcribe', id: this.nextId++, audio, final };
		this.worker.postMessage(message, [audio.buffer]);
	}

	private post(message: WorkerRequest): void {
		this.worker.postMessage(message);
	}

	private onMessage(message: WorkerResponse): void {
		switch (message.type) {
			case 'stage':
				this.handlers.onStage(message.stage);
				break;
			case 'progress':
				this.handlers.onProgress(message.percent);
				break;
			case 'ready':
				this.ready = true;
				this.handlers.onReady(message.device, message.loadMs);
				this.drain();
				break;
			case 'result':
				this.busy = false;
				this.handlers.onTiming(message.ms, message.audioMs);
				if (message.final) this.handlers.onFinal(message.text);
				else if (!this.pendingFinals.length) this.handlers.onPartial(message.text);
				this.drain();
				break;
			case 'error':
				this.busy = false;
				this.handlers.onError(message.message);
				this.drain();
				break;
		}
	}
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
