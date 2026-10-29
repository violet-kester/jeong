// Paintings come back with a margin of plain paper around the woodcut, which the ink filter turns see-through,
// so on a card it reads as extra padding. This finds where the ink really is, to show just that.

/** How much plain paper is on each side of a painting, as fractions of its width and height. */
export interface InkInset {
	top: number;
	right: number;
	bottom: number;
	left: number;
	/** The whole image's shape, height over width. */
	aspect: number;
}

const SAMPLE = 256; // the painting is looked at this many pixels across, at most
const INK = 0.6; // lighter than this (0 black, 1 white) is paper
const SPECKS = 0.01; // a row or column with less ink than this share of it is still paper (stray specks)

/** Where the ink is in a painting's image data (a PNG or JPEG file); null if it can't be read or is all paper. */
export async function inkInset(data: ArrayBuffer): Promise<InkInset | null> {
	const bitmap = await createImageBitmap(new Blob([data]));
	const scale = Math.min(1, SAMPLE / Math.max(bitmap.width, bitmap.height));
	const width = Math.max(1, Math.round(bitmap.width * scale));
	const height = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = createEl('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(bitmap, 0, 0, width, height);
	const aspect = bitmap.height / bitmap.width;
	bitmap.close();
	const pixels = ctx.getImageData(0, 0, width, height).data;

	const rows = new Array<number>(height).fill(0);
	const columns = new Array<number>(width).fill(0);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const light = (0.2126 * (pixels[i] ?? 255) + 0.7152 * (pixels[i + 1] ?? 255) + 0.0722 * (pixels[i + 2] ?? 255)) / 255;
			if (light < INK) {
				rows[y] = (rows[y] ?? 0) + 1;
				columns[x] = (columns[x] ?? 0) + 1;
			}
		}
	}
	const first = (counts: number[], across: number) => counts.findIndex((n) => n > across * SPECKS);
	const last = (counts: number[], across: number) => counts.length - 1 - [...counts].reverse().findIndex((n) => n > across * SPECKS);
	const top = first(rows, width);
	const left = first(columns, height);
	if (top < 0 || left < 0) return null;
	const bottom = last(rows, width);
	const right = last(columns, height);
	return { top: top / height, left: left / width, bottom: 1 - (bottom + 1) / height, right: 1 - (right + 1) / width, aspect };
}
