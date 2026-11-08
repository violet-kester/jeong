// The final transcript: after you press Stop, the whole recording is read again by the
// accurate model, start to finish, for the transcript that gets saved.

import type { SpeechEngine, Transcript } from './speech-engine';
import { normalizeLoudness } from '../audio/loudness';
import { splitAtPauses } from './split-at-pauses';

const SAMPLE_RATE = 16_000;

/** Transcribe a finished recording with the given engine (shared with the live transcript). */
export async function transcribeRecording(engine: SpeechEngine, recording: Blob): Promise<Transcript> {
	const pieces = splitAtPauses(await decodeTo16kHz(recording));
	const merged: Transcript = { text: '', segments: [], ms: 0, audioMs: 0 };
	const texts: string[] = [];
	for (const { offset, audio } of pieces) {
		const part = await engine.transcribe(audio, { timestamps: true });
		if (part.text) texts.push(part.text);
		merged.segments?.push(...(part.segments ?? []).map((s) => ({ ...s, start: s.start + offset, end: Math.min(s.end, audio.length / SAMPLE_RATE) + offset })));
		merged.ms += part.ms;
		merged.audioMs += part.audioMs;
	}
	merged.text = texts.join(' ');
	return merged;
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
