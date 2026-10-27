import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

// Build steps shared by the Obsidian plugin (esbuild.config.mjs) and Jeong in the browser (web/build.mjs).

// Fonts are bundled into styles.css so they work offline (all SIL Open Font License; see assets/fonts).
// Hahmlet and Gowun are subset to Latin + Korean; IBM Plex Mono ships unmodified (its name is reserved).
const FONTS = [
	{ family: 'Jeong Hahmlet', file: 'Hahmlet-Latin.woff2', weight: '100 900' },
	{ family: 'Jeong Gowun Batang', file: 'GowunBatang-Regular.woff2', weight: '400' },
	{ family: 'Jeong Gowun Batang', file: 'GowunBatang-Bold.woff2', weight: '700' },
	{ family: 'Jeong Gowun Dodum', file: 'GowunDodum-Regular.woff2', weight: '400' },
	{ family: 'IBM Plex Mono', file: 'IBMPlexMono-Regular.ttf', weight: '400' },
	{ family: 'IBM Plex Mono', file: 'IBMPlexMono-Medium.ttf', weight: '500' },
];

export function fontFaces() {
	return FONTS.map(({ family, file, weight }) => {
		const data = fs.readFileSync(path.join(import.meta.dirname, 'assets/fonts', file)).toString('base64');
		const format = file.endsWith('.woff2') ? 'woff2' : 'truetype';
		const mime = file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';
		return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: normal; font-display: swap; src: url(data:${mime};base64,${data}) format("${format}"); }`;
	}).join('\n');
}

// Files imported as "./something?worker" are bundled on their own (as an ES module)
// and inlined into main.js as text, because a plugin ships as one main.js file.
// The plugin then starts them as Web Workers from a blob URL.
export const inlineWorker = (prod) => ({
	name: 'inline-worker',
	setup(build) {
		build.onResolve({ filter: /\?worker$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path.replace(/\?worker$/, '') + '.ts'),
			namespace: 'inline-worker',
		}));
		build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => {
			const result = await esbuild.build({
				entryPoints: [args.path],
				bundle: true,
				write: false,
				format: 'esm',
				platform: 'browser',
				target: 'es2022',
				minify: prod,
				logLevel: 'warning',
				metafile: true,
			});
			return {
				contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
				loader: 'js',
				watchFiles: Object.keys(result.metafile.inputs).map((file) => path.resolve(file)),
			};
		});
	},
});
