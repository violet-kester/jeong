// Messages passed between the plugin and a transcription worker.
// The same worker can run any of the speech models below.

/** Moonshine Base is small and fast; Whisper Large v3 Turbo is larger and much more accurate. */
export type SpeechModel = 'moonshine-base' | 'whisper-turbo';

export type WorkerRequest =
	| { type: 'load'; model: SpeechModel }
	| { type: 'transcribe'; id: number; audio: Float32Array; final: boolean; timestamps?: boolean };

/** A stretch of the transcript with its start and end, in seconds from the start of the recording. */
export interface Segment {
	start: number;
	end: number;
	text: string;
}

export type WorkerResponse =
	| { type: 'stage'; stage: 'loading' | 'warming' }
	| { type: 'progress'; file: string; percent: number }
	| { type: 'ready'; device: string; loadMs: number; model: string; precision: string }
	| { type: 'result'; id: number; text: string; segments?: Segment[]; final: boolean; ms: number; audioMs: number }
	| { type: 'error'; message: string };
