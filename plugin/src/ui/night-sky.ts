// Stars for the night part of the timeline: tiny specks in lighter browns, drawn once as SVG tiles.
// Most stars hold still; the rest are split across three layers that styles.css fades in and out on
// different slow rhythms, so they seem to twinkle one by one. Seeded, so the sky is the same every time.

const TILE_WIDTH = 520;
const TILE_HEIGHT = 340;
const STAR_COUNT = 90;
const TWINKLE_LAYERS = 3;

/** Lighter browns for the stars, on walnut paper (light) and on walnut ink (dark). */
const STAR_COLORS = {
	light: ['#F4E8D0', '#FBF3E2', '#E8D6B4'],
	dark: ['#C9A97E', '#E3CDA6', '#B48D63', '#EFE2C6'],
};

/**
 * Sets the star tiles as CSS variables on `el`: --jeong-stars-light and -dark for the still stars,
 * and --jeong-stars-light-1 to -3 (and dark) for the twinkling layers.
 */
export function setNightSky(el: HTMLElement): void {
	for (const mode of ['light', 'dark'] as const) {
		const layers = starLayers(STAR_COLORS[mode]);
		layers.forEach((tile, i) => el.style.setProperty(i === 0 ? `--jeong-stars-${mode}` : `--jeong-stars-${mode}-${i}`, tile));
	}
}

/** The still stars first, then one tile per twinkling layer. */
function starLayers(colors: string[]): string[] {
	let seed = 19;
	const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const layers: string[] = Array.from({ length: TWINKLE_LAYERS + 1 }, () => '');
	for (let i = 0; i < STAR_COUNT; i++) {
		const bright = random() < 0.08;
		const opacity = (bright ? 0.55 + random() * 0.3 : 0.18 + random() * 0.35).toFixed(2);
		const x = (random() * TILE_WIDTH).toFixed(1);
		const y = (random() * TILE_HEIGHT).toFixed(1);
		const radius = (bright ? 1.1 + random() * 0.5 : 0.45 + random() * 0.45).toFixed(2);
		const color = colors[Math.floor(random() * colors.length)] ?? colors[0];
		// About two stars in five twinkle
		const layer = random() < 0.4 ? 1 + Math.floor(random() * TWINKLE_LAYERS) : 0;
		layers[layer] += `<circle cx='${x}' cy='${y}' r='${radius}' fill='${color}' opacity='${opacity}'/>`;
	}
	return layers.map((stars) => {
		const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE_WIDTH}' height='${TILE_HEIGHT}'>${stars}</svg>`;
		return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
	});
}
