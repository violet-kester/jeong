// Word error rate (WER): how many words a transcript got wrong compared with what was
// actually said. 0 is perfect; 0.1 means about one word in ten was wrong, missing, or extra.

/** Lowercase, drop punctuation, and split into words, so "Coca-Cola." and "coca cola" match. */
export function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[’']/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

export function wordErrorRate(reference: string, hypothesis: string): number {
	const ref = words(reference);
	const hyp = words(hypothesis);
	if (!ref.length) return hyp.length ? 1 : 0;

	// Edit distance over words: substitutions, deletions, and insertions all count as errors
	let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
	for (let i = 1; i <= ref.length; i++) {
		const current = [i];
		for (let j = 1; j <= hyp.length; j++) {
			const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
			current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
		}
		previous = current;
	}
	return (previous[hyp.length] ?? 0) / ref.length;
}

// Read aloud for the transcription test. Plain words, so scoring isn't thrown off by
// "twenty-six" vs "26", plus names and brands that small models tend to miss.
export const TEST_SCRIPT =
	'This is a transcription test. I am sitting at my desk drinking a Diet Coke. ' +
	'This morning I had coffee, answered a few emails, ' +
	'and went for a walk around the block. It was colder than I expected. My friend Hannah called, ' +
	'and we talked about her new apartment in Asheville. This is the end of the test.';
