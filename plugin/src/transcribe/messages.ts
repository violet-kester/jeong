// Messages passed between the plugin and a transcription worker.
// The same worker runs either model: Moonshine for the live preview, Whisper for the final transcript.

export type ModelKind = 'live' | 'final';

export type WorkerRequest =
	| { type: 'load'; kind: ModelKind }
	| { type: 'transcribe'; id: number; audio: Float32Array; final: boolean };

export type WorkerResponse =
	| { type: 'stage'; stage: 'loading' | 'warming' }
	| { type: 'progress'; file: string; percent: number }
	| { type: 'ready'; device: string; loadMs: number }
	| { type: 'result'; id: number; text: string; final: boolean; ms: number; audioMs: number }
	| { type: 'error'; message: string };
