// The final transcript: after you press Stop, the whole recording is read again by the
// accurate model, start to finish, for the transcript that gets saved.

import type { SpeechEngine, Transcript } from './speech-engine';
import { normalizeLoudness } from '../audio/loudness';

const SAMPLE_RATE = 16_000;

/** Transcribe a finished recording with the given engine (shared with the live transcript). */
export async function transcribeRecording(engine: SpeechEngine, recording: Blob): Promise<Transcript> {
	return engine.transcribe(await decodeTo16kHz(recording), { timestamps: true });
}

/** Decodes a recording (WebM, M4A, …) into the 16 kHz mono audio the models expect. Kept in memory only. */
async function decodeTo16kHz(recording: Blob): Promise<Float32Array> {
	const context = new AudioContext({ sampleRate: SAMPLE_RATE });
	try {
		const buffer = await context.decodeAudioData(await recording.arrayBuffer());
		return normalizeLoudness(buffer.getChannelData(0).slice());
	} finally {
		void context.close();
	}
}
