import { addIcon } from 'obsidian';

/**
 * Jeong's own icons, drawn like Obsidian's (Lucide: 100×100, round strokes in the text color).
 * jeong-brush: a calligraphy brush (붓): a long slim handle, its band, a small tuft, and the stroke of ink it leaves.
 */
export function addIcons(): void {
	addIcon(
		'jeong-brush',
		'<g fill="none" stroke="currentColor" stroke-width="6.25" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M87.5 12.5 56.7 43.3"/>' +
			'<path d="M52.5 39.2 60.8 47.5 55 53.3 46.7 45Z"/>' +
			'<path d="M46.7 45C40 50.8 34.2 59.2 30 69.2c10-4.2 18.3-9.2 25-15.9"/>' +
			'<path d="M30 69.2c-5 7.5-10.8 12.5-17.5 15.8"/>' +
			'</g>',
	);
}
