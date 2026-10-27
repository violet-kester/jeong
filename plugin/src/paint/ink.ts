// Paintings are made in black ink, which the model does reliably, and shown in one ink color chosen in
// settings. An SVG filter maps each pixel's lightness from the ink color (dark) to paper (light), so every
// painting is exactly one color and matches the others. The paper stays light in dark mode too: a painting is
// a print on paper, like a photo, and mapping it onto the dark card would turn it into a negative.
// The files stay black; changing the color never needs a repaint.

export type InkName = 'cinnabar' | 'vermilion' | 'crimson' | 'oxblood' | 'black';

export const INKS: Record<InkName, string> = {
	cinnabar: '#B2432F',
	vermilion: '#C9452A',
	crimson: '#8E2A2E',
	oxblood: '#5E1F1F',
	black: '', // as painted
};

const SVG = 'http://www.w3.org/2000/svg';
export const INK_FILTER_ID = 'jeong-ink';
/** Hanji: the light paper paintings are printed on, in both themes. */
const PAPER = [251, 246, 236];

/** Puts (or updates) the ink filter in `root`, and marks it so paintings inside use it. */
export function applyInk(root: HTMLElement, ink: InkName): void {
	const color = INKS[ink];
	root.toggleClass('jeong-inked', !!color);
	if (!color) return;

	let filter = root.querySelector<SVGFilterElement>(`#${INK_FILTER_ID}`);
	if (!filter) {
		const svg = root.appendChild(document.createElementNS(SVG, 'svg'));
		svg.setAttribute('class', 'jeong-ink-defs');
		svg.setAttribute('aria-hidden', 'true');
		filter = svg.appendChild(document.createElementNS(SVG, 'filter'));
		filter.id = INK_FILTER_ID;
		filter.setAttribute('color-interpolation-filters', 'sRGB');
		const gray = filter.appendChild(document.createElementNS(SVG, 'feColorMatrix'));
		gray.setAttribute('type', 'matrix');
		gray.setAttribute('values', '0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0');
		const transfer = filter.appendChild(document.createElementNS(SVG, 'feComponentTransfer'));
		for (const channel of ['R', 'G', 'B']) {
			const func = transfer.appendChild(document.createElementNS(SVG, `feFunc${channel}`));
			func.setAttribute('type', 'table');
		}
	}

	const inkRgb = rgb(color) ?? [178, 67, 47];
	filter.querySelectorAll('feComponentTransfer > *').forEach((func, i) => {
		func.setAttribute('tableValues', `${((inkRgb[i] ?? 0) / 255).toFixed(3)} ${((PAPER[i] ?? 255) / 255).toFixed(3)}`);
	});
}

/** "#B2432F" → [178, 67, 47]. */
function rgb(value: string): number[] | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
	return hex ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null;
}
