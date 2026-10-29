// A sample journal for the demo (?demo), kept in the browser's private storage, never in your vault.
// It's rebuilt fresh each time, dated around today, so there's always something on the timeline.

import { moment } from './obsidian';

interface Sample {
	daysAgo: number;
	time: string;
	title: string;
	summary: string;
	story: string;
	/** Sky and ground colors; 'tall' for a portrait photo. */
	photos?: [string, string, 'tall'?][];
}

const SAMPLES: Sample[] = [
	{ daysAgo: 0, time: '07:40', title: 'Coffee on the Porch', summary: 'I had my coffee outside before anyone was up and watched the fog lift off the field.', story: 'I had my coffee outside before anyone was up. The fog was still sitting on the field, and by the time I finished it had lifted.', photos: [['#C9D3D4', '#7E8C6E'], ['#F2C9A0', '#6E7F5A'], ['#B9C6D8', '#5D6B52']] },
	{ daysAgo: 0, time: '19:15', title: 'Soup on a Cold Night', summary: 'Blake cooked while I sat in the dining room, and we made his grandmother’s soup.', story: 'Blake is in the kitchen while I sit in the dining room. It’s cold outside and the light around the mirror is on. We’re making his grandmother’s soup.' },
	{ daysAgo: 1, time: '13:05', title: 'Lunch with Mom', summary: 'Mom and I had lunch downtown and she told me about the house she grew up in.', story: 'Mom and I had lunch downtown. She told me about the house she grew up in, the one with the blue door.', photos: [['#E8D9B5', '#B27A4F', 'tall'], ['#D8C3E0', '#8A6E5A']] },
	{ daysAgo: 4, time: '21:30', title: 'Fireworks from the Roof', summary: 'We climbed onto the roof to watch the fireworks over the lake.', story: 'We climbed onto the roof to watch the fireworks over the lake. The neighbors cheered at every big one.' },
	{ daysAgo: 12, time: '10:20', title: 'Paper from Maguey', summary: 'I pulled my first sheets of paper from agave fibre; rough, warm, and full of flecks.', story: 'I pulled my first sheets of paper from agave fibre today. They came out rough and warm, full of flecks.', photos: [['#F1E8D6', '#A98A66']] },
	{ daysAgo: 30, time: '18:05', title: 'Mountains at Dusk', summary: 'On the drive back the mountains turned orange and then blue.', story: 'On the drive back the light turned everything orange, and then the mountains went blue.' },
];

export async function seedDemo(): Promise<FileSystemDirectoryHandle> {
	const storage = await navigator.storage.getDirectory();
	await storage.removeEntry('demo-vault', { recursive: true }).catch(() => undefined);
	const vault = await storage.getDirectoryHandle('demo-vault', { create: true });
	for (const sample of SAMPLES) {
		const when = moment().subtract(sample.daysAgo, 'days').hour(Number(sample.time.slice(0, 2))).minute(Number(sample.time.slice(3)));
		const day = when.format('YYYY-MM-DD');
		const stamp = when.format('YYYY-MM-DD HHmm');
		const folderPath = ['spaces', 'jeong', when.format('YYYY'), when.format('MM MMMM'), `${stamp} ${sample.title}`];
		let folder = vault;
		for (const part of folderPath) folder = await folder.getDirectoryHandle(part, { create: true });
		const photos = (sample.photos ?? []).map((_, i) => `${stamp} photo ${i + 1}.svg`);
		for (const [i, [sky, ground, tall]] of (sample.photos ?? []).entries()) await write(folder, photos[i] ?? '', landscape(sky, ground, tall));
		const lines = [
			'---',
			`title: ${sample.title}`,
			`date: ${day}`,
			`time: "${sample.time}"`,
			'duration: "1:12"',
			`summary: ${JSON.stringify(sample.summary)}`,
			'visibility: private',
			'status: written',
			...(photos.length ? ['photos:', ...photos.map((photo) => `  - ${photo}`)] : []),
			'---',
			'',
			sample.story,
			'',
		];
		await write(folder, `${sample.title}.md`, lines.join('\n'));
	}
	return vault;
}

async function write(folder: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
	const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
	await writable.write(text);
	await writable.close();
}

/** A simple landscape picture: sky, horizon, ground; wide, or tall like a phone photo. */
function landscape(sky: string, ground: string, tall?: 'tall'): string {
	const [width, height] = tall ? [400, 600] : [600, 400];
	const horizon = Math.round(height * 0.575);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#F3E6C8"/></linearGradient></defs><rect width="${width}" height="${horizon}" fill="url(#s)"/><rect y="${horizon}" width="${width}" height="${height - horizon}" fill="${ground}"/></svg>`;
}
