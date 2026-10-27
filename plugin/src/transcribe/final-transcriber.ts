// The final transcript: after you press Stop, the whole recording is read by Whisper,
// which is slower than the live preview but much more accurate.

import workerCode from './live.worker?worker';
import type { WorkerRequest, WorkerResponse } from './messages';

const SAMPLE_RATE = 16_000;

export interface FinalTranscriptHandlers {
	onStage(stage: 'loading' | 'warming'): void;
	onProgress(percent: number): void;
	onReady(device: string, loadMs: number): void;
	onResult(text: string, ms: number, audioMs: number): void;
	onError(message: string): void;
}

export class FinalTranscriber {
	private worker: Worker;
	private workerUrl: string;
	private ready = false;
	private waiting: Float32Array | null = null;

	constructor(private handlers: FinalTranscriptHandlers) {
		this.workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
		this.worker = new Worker(this.workerUrl, { type: 'module' });
		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
		this.worker.onerror = (event: ErrorEvent) => this.handlers.onError(event.message || 'The transcription worker stopped unexpectedly');
		this.post({ type: 'load', kind: 'final' });
	}

	/** Transcribe a finished recording. If the model is still loading, it starts as soon as it's ready. */
	async transcribe(recording: Blob): Promise<void> {
		const audio = await decodeTo16kHz(recording);
		if (this.ready) this.send(audio);
		else this.waiting = audio;
	}

	dispose(): void {
		this.worker.terminate();
		URL.revokeObjectURL(this.workerUrl);
	}

	private send(audio: Float32Array): void {
		const message: WorkerRequest = { type: 'transcribe', id: 0, audio, final: true };
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
				if (this.waiting) {
					this.send(this.waiting);
					this.waiting = null;
				}
				break;
			case 'result':
				this.handlers.onResult(message.text, message.ms, message.audioMs);
				break;
			case 'error':
				this.handlers.onError(message.message);
				break;
		}
	}
}

/** Decodes a recording (WebM, M4A, …) into the 16 kHz mono audio the models expect. Kept in memory only. */
async function decodeTo16kHz(recording: Blob): Promise<Float32Array> {
	const context = new AudioContext({ sampleRate: SAMPLE_RATE });
	try {
		const buffer = await context.decodeAudioData(await recording.arrayBuffer());
		return buffer.getChannelData(0).slice();
	} finally {
		void context.close();
	}
}
