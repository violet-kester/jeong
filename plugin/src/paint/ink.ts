// Paintings are made in black ink, which the model does reliably, and shown in one ink color chosen in
// settings. An SVG filter maps each pixel's lightness from the ink color (dark) to the card's paper (light),
// so every painting is exactly one color, matches the others, and follows light and dark themes.
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

	// Paper is the card's own color; on a dark card the ink is lifted a little so it still reads
	const paper = rgb(getComputedStyle(root).getPropertyValue('--jeong-card').trim()) ?? [251, 246, 236];
	const dark = paper.reduce((sum, v) => sum + v, 0) / paper.length < 128;
	const inkRgb = (rgb(color) ?? [178, 67, 47]).map((v) => (dark ? v + (255 - v) * 0.3 : v));
	filter.querySelectorAll('feComponentTransfer > *').forEach((func, i) => {
		func.setAttribute('tableValues', `${((inkRgb[i] ?? 0) / 255).toFixed(3)} ${((paper[i] ?? 255) / 255).toFixed(3)}`);
	});
}

/** "#B2432F" or "rgb(178, 67, 47)" → [178, 67, 47]. */
function rgb(value: string): number[] | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
	if (hex) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
	const parts = /rgba?\(([^)]+)\)/.exec(value)?.[1]?.split(',').map((part) => parseFloat(part));
	return parts && parts.length >= 3 ? parts.slice(0, 3) : null;
}
