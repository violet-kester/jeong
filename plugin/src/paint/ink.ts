// Paintings are made in black ink, which the model does reliably, and shown in one ink color by an SVG
// filter that reads each pixel's lightness. Light theme: the ink becomes the color and the paper vanishes, so
// red strokes sit straight on the card. Dark theme: the other way round, like a woodcut's carved lines: the
// solid ink vanishes into the dark card and the light lines become the color. (Keeping the ink as the color on
// a dark card made solid areas glow and looked like a negative.) The files stay black; nothing is repainted.

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
	}
	filter.empty();

	const card = rgb(getComputedStyle(root).getPropertyValue('--jeong-card').trim());
	const dark = !!card && card.reduce((sum, v) => sum + v, 0) / card.length < 128;
	const [r, g, b] = (rgb(color) ?? [178, 67, 47]).map((v) => (v / 255).toFixed(3));
	// How opaque each pixel is: its darkness in the light theme, its lightness in the dark theme
	const opacity = dark ? '0.33 0.33 0.33 0 0' : '-0.33 -0.33 -0.33 0 1';
	primitive(filter, 'feColorMatrix', { type: 'matrix', values: `0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  ${opacity}` });
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
