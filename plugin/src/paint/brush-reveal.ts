// A new painting appears the way it would on paper: a few wide strokes of a brush sweep across,
// left to right and back, and the picture shows wherever the ink has gone. The strokes have ragged,
// bristly edges (a little turbulence), and each one starts as the last lifts off, so the picture fills
// in one smooth motion over the "ink drying" time (--jeong-drift).
//
// It's an SVG: the painting as an <image>, masked by thick stroked paths whose dash offset is animated.
// With reduced motion the painting just fades in.

const SVG = 'http://www.w3.org/2000/svg';
const STROKES = 4;

let ids = 0;

/** Shows `src` in `container` (which must already have its size), revealed by brush strokes. */
export function brushReveal(container: HTMLElement, src: string): void {
	const { width, height } = container.getBoundingClientRect();
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (!width || !height || reduced) {
		const img = container.createEl('img', { cls: 'is-shown', attr: { src, alt: '' } });
		if (reduced) img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 550, easing: 'ease-out' });
		return;
	}

	const id = `jeong-brush-${++ids}`;
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('class', 'jeong-brush-reveal');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

	const defs = svg.appendChild(document.createElementNS(SVG, 'defs'));
	// Ragged bristle edges: noise pushes the stroke's edge in and out a few pixels
	const filter = defs.appendChild(document.createElementNS(SVG, 'filter'));
	filter.id = `${id}-bristles`;
	filter.setAttribute('x', '-10%');
	filter.setAttribute('y', '-10%');
	filter.setAttribute('width', '120%');
	filter.setAttribute('height', '120%');
	const noise = filter.appendChild(document.createElementNS(SVG, 'feTurbulence'));
	noise.setAttribute('type', 'fractalNoise');
	noise.setAttribute('baseFrequency', '0.035 0.18');
	noise.setAttribute('numOctaves', '2');
	noise.setAttribute('seed', String(Math.floor(Math.random() * 1000)));
	const displace = filter.appendChild(document.createElementNS(SVG, 'feDisplacementMap'));
	displace.setAttribute('in', 'SourceGraphic');
	displace.setAttribute('scale', String(Math.max(8, height * 0.12)));
	displace.setAttribute('xChannelSelector', 'R');
	displace.setAttribute('yChannelSelector', 'G');

	const mask = defs.appendChild(document.createElementNS(SVG, 'mask'));
	mask.id = `${id}-mask`;
	const ink = mask.appendChild(document.createElementNS(SVG, 'g'));
	ink.setAttribute('filter', `url(#${filter.id})`);
	ink.setAttribute('stroke', 'white');
	ink.setAttribute('fill', 'none');
	ink.setAttribute('stroke-linecap', 'round');

	const image = svg.appendChild(document.createElementNS(SVG, 'image'));
	image.setAttribute('href', src);
	image.setAttribute('width', String(width));
	image.setAttribute('height', String(height));
	image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
	image.setAttribute('mask', `url(#${mask.id})`);
	container.appendChild(svg);

	// Strokes overlap a little and run past the edges, so no paper shows once they're all down
	const band = height / STROKES;
	const drift = parseFloat(getComputedStyle(container).getPropertyValue('--jeong-drift')) || 1800;
	const easing = getComputedStyle(container).getPropertyValue('--jeong-ease-in-out').trim() || 'ease-in-out';
	const each = drift / (STROKES * 0.8);
	for (let i = 0; i < STROKES; i++) {
		const y = band * (i + 0.5);
		const tilt = (Math.random() - 0.5) * band * 0.5; // a hand isn't a ruler
		const [from, to] = i % 2 ? [width + band, -band] : [-band, width + band];
		const path = ink.appendChild(document.createElementNS(SVG, 'path'));
		path.setAttribute('d', `M ${from} ${y - tilt} Q ${width / 2} ${y + tilt * 2} ${to} ${y + tilt}`);
		path.setAttribute('stroke-width', String(band * 1.6));
		const length = path.getTotalLength();
		path.setAttribute('stroke-dasharray', String(length));
		path.setAttribute('stroke-dashoffset', String(length));
		path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
			duration: each,
			delay: i * each * 0.75,
			easing,
			fill: 'forwards',
		});
	}
	// The whole picture settles from a touch too dark (wet ink) to itself
	image.animate([{ filter: 'brightness(0.82) contrast(1.08)' }, { filter: 'none' }], { duration: drift * 1.4, easing, fill: 'forwards' });
}
