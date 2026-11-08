// Whisper reads 30 seconds at a time. Past that, its overlapping windows begin mid-sentence
// and the seams can repeat or garble words, so long recordings are cut at pauses instead.

const SAMPLE_RATE = 16_000;
const WHOLE_UP_TO_S = 30; // fits one Whisper window, so it needs no cutting
const LONGEST_PIECE_S = 28;
const SHORTEST_PIECE_S = 10; // don't cut so early that the next piece has to be short again
const LISTEN_S = 0.2; // how long a stretch has to stay quiet to count as a pause
const STEP_S = 0.05;
const QUIET = 0.025; // average level of a pause, once loudness has been evened out

export interface Piece {
	/** Where this piece begins in the whole recording, in seconds. */
	offset: number;
	audio: Float32Array;
}

/** Cuts audio into pieces that each fit one window, at the quietest pause, or at the longest length if nobody paused. */
export function splitAtPauses(audio: Float32Array): Piece[] {
	if (audio.length <= WHOLE_UP_TO_S * SAMPLE_RATE) return [{ offset: 0, audio }];

	const longest = LONGEST_PIECE_S * SAMPLE_RATE;
	const pieces: Piece[] = [];
	let start = 0;
	while (audio.length - start > longest) {
		const cut = quietestPoint(audio, start + SHORTEST_PIECE_S * SAMPLE_RATE, start + longest) ?? start + longest;
		pieces.push({ offset: start / SAMPLE_RATE, audio: audio.slice(start, cut) });
		start = cut;
	}
	pieces.push({ offset: start / SAMPLE_RATE, audio: audio.slice(start) });
	return pieces;
}

/** The middle of the quietest stretch between two points, or null if none of it is quiet enough to be a pause. */
function quietestPoint(audio: Float32Array, from: number, to: number): number | null {
	const listen = Math.round(LISTEN_S * SAMPLE_RATE);
	const step = Math.round(STEP_S * SAMPLE_RATE);
	let best: number | null = null;
	let bestLevel = QUIET;
	for (let at = from; at + listen <= to; at += step) {
		const level = levelOf(audio, at, listen);
		if (level < bestLevel) {
			bestLevel = level;
			best = at + Math.floor(listen / 2);
		}
	}
	return best;
}

function levelOf(audio: Float32Array, from: number, length: number): number {
	let sum = 0;
	for (let i = from; i < from + length; i++) {
		const sample = audio[i] ?? 0;
		sum += sample * sample;
	}
	return Math.sqrt(sum / length);
}
