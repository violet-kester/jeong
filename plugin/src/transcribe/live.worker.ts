// Runs a speech model in a background worker so Obsidian never freezes while it listens.
// It receives 16 kHz audio and sends back the words it hears.
//   moonshine-base: small and fast
//   whisper-turbo:  Whisper Large v3 Turbo, larger and much more accurate

import './browser-only';
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { SpeechModel, WorkerRequest, WorkerResponse } from './messages';

// Models download from Hugging Face once, then live in the browser cache (outside the vault)
env.allowLocalModels = false;
env.useBrowserCache = true;

type Precision = 'fp32' | 'fp16' | 'q8' | 'q4';

const MODELS: Record<SpeechModel, { id: string; gpu: Record<string, Precision>; cpu: Record<string, Precision> }> = {
	'moonshine-base': {
		id: 'onnx-community/moonshine-base-ONNX',
		gpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
		cpu: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
	},
	'whisper-turbo': {
		id: 'onnx-community/whisper-large-v3-turbo',
		gpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
		cpu: { encoder_model: 'q8', decoder_model_merged: 'q8' },
	},
};

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let name: SpeechModel = 'moonshine-base';

function send(message: WorkerResponse): void {
	self.postMessage(message);
}

async function load(requested: SpeechModel): Promise<void> {
	name = requested;
	const model = MODELS[name];
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
	const precision = Object.entries(hasGpu ? model.gpu : model.cpu).map(([part, p]) => `${part}=${p}`).join(',');
	send({ type: 'ready', device, loadMs: performance.now() - started, model: model.id, precision });
}

async function transcribe(id: number, audio: Float32Array, final: boolean): Promise<void> {
	if (!transcriber) return;
	const started = performance.now();
	// Whisper reads 30-second windows; long recordings are split with a little overlap
	const output = await transcriber(audio, name === 'whisper-turbo' ? { chunk_length_s: 30, stride_length_s: 5 } : {});
	const outputs: { text: string }[] = Array.isArray(output) ? output : [output];
	const text = outputs.map((o) => o.text).join(' ').trim();
	send({ type: 'result', id, text, final, ms: performance.now() - started, audioMs: (audio.length / 16_000) * 1000 });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const message = event.data;
	const work = message.type === 'load' ? load(message.model) : transcribe(message.id, message.audio, message.final);
	work.catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};
