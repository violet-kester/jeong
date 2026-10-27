// Brings quiet speech up to a steady level before a model reads it. Soft voices and
// far-away microphones are a common cause of missed words.

const TARGET_LOUDNESS = 0.1; // average level of the spoken parts, on a 0–1 scale
const MAX_GAIN = 8; // never boost more than this, so background hiss isn't blown up
const SPEECH_FLOOR = 0.01; // samples quieter than this are treated as silence when measuring

/** Returns a louder copy of the audio if it's quiet; leaves already-loud audio alone. */
export function normalizeLoudness(audio: Float32Array): Float32Array {
	let sum = 0;
	let count = 0;
	for (const sample of audio) {
		if (Math.abs(sample) < SPEECH_FLOOR) continue;
		sum += sample * sample;
		count++;
	}
	if (!count) return audio;
	const loudness = Math.sqrt(sum / count);
	const gain = Math.min(MAX_GAIN, TARGET_LOUDNESS / loudness);
	if (gain <= 1) return audio;

	const out = new Float32Array(audio.length);
	for (let i = 0; i < audio.length; i++) {
		out[i] = Math.max(-1, Math.min(1, (audio[i] ?? 0) * gain));
	}
	return out;
}
