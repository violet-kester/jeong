// Paintings are made in black ink, which the model does reliably, and shown in one ink color by an SVG
// filter: the dark lines become the color, and everything light becomes transparent, so the strokes sit
// straight on the card in either theme. The files stay black; changing the color never needs a repaint.

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
		// Only the image itself, no margin around it
		for (const [key, value] of Object.entries({ x: '0', y: '0', width: '1', height: '1' })) filter.setAttribute(key, value);
	}
	filter.empty();

	const [r, g, b] = (rgb(color) ?? [178, 67, 47]).map((v) => (v / 255).toFixed(3));
	// Every pixel becomes the ink color; how dark it was becomes how opaque it is. (Opacity minus lightness, so
	// anything already transparent, like the filter's margin around the image, stays transparent.)
	primitive(filter, 'feColorMatrix', { type: 'matrix', values: `0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  -0.33 -0.33 -0.33 1 0` });
	// The faint grain at the far end would leave a haze; it's cut away, and the strokes kept crisp
	const alpha = primitive(filter, 'feComponentTransfer', {});
	primitive(alpha, 'feFuncA', { type: 'linear', slope: '1.3', intercept: '-0.12' });
}

function primitive(parent: Element, name: string, attributes: Record<string, string>): Element {
	const el = parent.appendChild(document.createElementNS(SVG, name));
	for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
	return el;
}

/** "#B2432F" → [178, 67, 47]. */
function rgb(value: string): number[] | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
	return hex ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null;
}
