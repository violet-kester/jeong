// Runs a speech model in a background worker so Obsidian never freezes while it listens.
// It receives 16 kHz audio and sends back the words it hears.
//   live:  Moonshine Base, small and fast, for the preview while you talk
//   final: Whisper Large v3 Turbo, larger and more accurate, for the real transcript

import './browser-only';
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { ModelKind, WorkerRequest, WorkerResponse } from './messages';

// Models download from Hugging Face once, then live in the browser cache (outside the vault)
env.allowLocalModels = false;
env.useBrowserCache = true;

type Precision = 'fp32' | 'fp16' | 'q8' | 'q4';

const MODELS: Record<ModelKind, { id: string; gpu: Record<string, Precision>; cpu: Record<string, Precision> }> = {
	live: {
		id: 'onnx-community/moonshine-base-ONNX',
		gpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
		cpu: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
	},
	final: {
		id: 'onnx-community/whisper-large-v3-turbo',
		gpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
		cpu: { encoder_model: 'q8', decoder_model_merged: 'q8' },
	},
};

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let kind: ModelKind = 'live';

function send(message: WorkerResponse): void {
	self.postMessage(message);
}

async function load(requested: ModelKind): Promise<void> {
	kind = requested;
	const model = MODELS[kind];
	const started = performance.now();
	send({ type: 'stage', stage: 'loading' });
	const hasGpu = 'gpu' in navigator;
	const device = hasGpu ? 'webgpu' : 'wasm';
	transcriber = await pipeline('automatic-speech-recognition', model.id, {
		device,
		dtype: hasGpu ? model.gpu : model.cpu,
		progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
			if (progress.status === 'progress' && progress.file) {
				send({ type: 'progress', file: progress.file, percent: Math.round(progress.progress ?? 0) });
			}
		},
	});
	// Warm up once, so the first real words don't wait for the graphics card to get ready
	send({ type: 'stage', stage: 'warming' });
	await transcriber(new Float32Array(16_000));
	send({ type: 'ready', device, loadMs: performance.now() - started });
}

async function transcribe(id: number, audio: Float32Array, final: boolean): Promise<void> {
	if (!transcriber) return;
	const started = performance.now();
	// Whisper reads 30-second windows; long recordings are split with a little overlap
	const output = await transcriber(audio, kind === 'final' ? { chunk_length_s: 30, stride_length_s: 5 } : {});
	const outputs: { text: string }[] = Array.isArray(output) ? output : [output];
	const text = outputs.map((o) => o.text).join(' ').trim();
	send({ type: 'result', id, text, final, ms: performance.now() - started, audioMs: (audio.length / 16_000) * 1000 });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const message = event.data;
	const work = message.type === 'load' ? load(message.kind) : transcribe(message.id, message.audio, message.final);
	work.catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};
