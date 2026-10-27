// Runs a speech model in a background worker so Obsidian never freezes while it listens.
// It receives 16 kHz audio and sends back the words it hears.
//   moonshine-base: small and fast
//   whisper-turbo:  Whisper Large v3 Turbo, larger and much more accurate

import './browser-only';
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { Segment, SpeechModel, WorkerRequest, WorkerResponse } from './messages';

// Models download from Hugging Face once, then live in the browser cache (outside the vault)
env.allowLocalModels = false;
env.useBrowserCache = true;


// Entries are in English for now (each one records language: en); saying so keeps Whisper from guessing or warning
const LANGUAGE = 'en';

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

async function load(requested: SpeechModel, windows: boolean): Promise<void> {
	name = requested;
	// Transformers.js asks for the high-performance graphics card. Chrome can't choose one on Windows (Windows
	// does, in its graphics settings), so it ignores the request and warns every time; there, don't ask.
	const webgpu = (env.backends.onnx as { webgpu?: { powerPreference?: string } }).webgpu;
	if (webgpu && windows) delete webgpu.powerPreference;
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

interface Output {
	text: string;
	chunks?: { timestamp: [number, number | null]; text: string }[];
}

async function transcribe(id: number, audio: Float32Array, final: boolean, timestamps: boolean): Promise<void> {
	if (!transcriber) return;
	const started = performance.now();
	const isWhisper = name === 'whisper-turbo';
	// Whisper reads 30-second windows; long recordings are split with a little overlap
	const output = await transcriber(audio, {
		...(isWhisper ? { chunk_length_s: 30, stride_length_s: 5, language: LANGUAGE, task: 'transcribe' } : {}),
		...(isWhisper && timestamps ? { return_timestamps: true } : {}),
	});
	const outputs: Output[] = Array.isArray(output) ? output : [output];
	const text = outputs.map((o) => o.text).join(' ').trim();
	const audioSeconds = audio.length / 16_000;
	const segments: Segment[] | undefined = timestamps
		? outputs.flatMap((o) => o.chunks ?? []).map((chunk) => ({
				start: chunk.timestamp[0],
				end: chunk.timestamp[1] ?? audioSeconds,
				text: chunk.text.trim(),
			}))
		: undefined;
	send({ type: 'result', id, text, segments, final, ms: performance.now() - started, audioMs: audioSeconds * 1000 });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const message = event.data;
	const work = message.type === 'load' ? load(message.model, message.windows) : transcribe(message.id, message.audio, message.final, message.timestamps ?? false);
	work.catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};
