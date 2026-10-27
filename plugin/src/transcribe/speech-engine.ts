// One speech model running in its own background worker. Requests are handled one at a
// time, in order, so a single loaded copy of a model can be shared by everything that
// needs it (the live transcript and the final transcript both use the same Whisper).

import { Platform } from 'obsidian';
import workerCode from './live.worker?worker';
import type { Segment, SpeechModel, WorkerRequest, WorkerResponse } from './messages';

export interface EngineEvents {
	onStage(stage: 'loading' | 'warming'): void;
	onProgress(percent: number): void;
	onReady(device: string, loadMs: number, model: string, precision: string): void;
	onError(message: string): void;
}

export interface Transcript {
	text: string;
	/** Timed stretches of the transcript, when asked for. */
	segments?: Segment[];
	ms: number;
	audioMs: number;
}

interface Job {
	audio: Float32Array;
	timestamps: boolean;
	resolve(result: Transcript): void;
	reject(error: Error): void;
}

export class SpeechEngine {
	busy = false;
	private ready = false;
	private worker: Worker;
	private workerUrl: string;
	private queue: Job[] = [];
	private current: Job | null = null;
	private nextId = 0;

	constructor(
		model: SpeechModel,
		private events: EngineEvents,
	) {
		this.workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
		this.worker = new Worker(this.workerUrl, { type: 'module' });
		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
		// Errors the worker can't report itself, such as failing to start at all
		this.worker.onerror = (event: ErrorEvent) => this.fail(event.message || 'The transcription worker stopped unexpectedly');
		this.post({ type: 'load', model, windows: Platform.isWin });
	}

	/** Queue audio for transcription. Waits for the model to finish loading if it hasn't yet. */
	transcribe(audio: Float32Array, options: { timestamps?: boolean } = {}): Promise<Transcript> {
		return new Promise((resolve, reject) => {
			this.queue.push({ audio, timestamps: options.timestamps ?? false, resolve, reject });
			this.next();
		});
	}

	dispose(): void {
		this.worker.terminate();
		URL.revokeObjectURL(this.workerUrl);
		for (const job of this.queue) job.reject(new Error('Closed'));
		this.queue = [];
	}

	private next(): void {
		if (!this.ready || this.current) return;
		const job = this.queue.shift();
		if (!job) {
			this.busy = false;
			return;
		}
		this.current = job;
		this.busy = true;
		const message: WorkerRequest = { type: 'transcribe', id: this.nextId++, audio: job.audio, final: true, timestamps: job.timestamps };
		this.worker.postMessage(message, [job.audio.buffer]);
	}

	private fail(message: string): void {
		this.events.onError(message);
		this.current?.reject(new Error(message));
		this.current = null;
		this.next();
	}

	private post(message: WorkerRequest): void {
		this.worker.postMessage(message);
	}

	private onMessage(message: WorkerResponse): void {
		switch (message.type) {
			case 'stage':
				this.events.onStage(message.stage);
				break;
			case 'progress':
				this.events.onProgress(message.percent);
				break;
			case 'ready':
				this.ready = true;
				this.events.onReady(message.device, message.loadMs, message.model, message.precision);
				this.next();
				break;
			case 'result':
				this.current?.resolve({ text: message.text, segments: message.segments, ms: message.ms, audioMs: message.audioMs });
				this.current = null;
				this.next();
				break;
			case 'error':
				this.fail(message.message);
				break;
		}
	}
}
