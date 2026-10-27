// Builds Jeong in the browser from the plugin's own code, and serves it on this computer:
//   npm run web        build, watch for changes, and serve at http://localhost:8780
//   npm run web:build  build once
// Two bundles: jeong.js opens your vault folder; demo.js (?demo) runs a sample journal with pretend speech.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fontFaces, inlineWorker } from '../build-tools.mjs';

const here = import.meta.dirname;
const serve = process.argv.includes('--serve');
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });

// "obsidian" is the stand-in in obsidian.ts
const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(here, 'obsidian.ts') }));
	},
};

// The demo swaps the speech models, the story writer, and the microphone for pretend ones
const DEMO_SWAPS = {
	'transcribe/live-transcriber': 'fake-speech.ts',
	'transcribe/final-transcriber': 'fake-speech.ts',
	'transcribe/speech-engine': 'fake-speech.ts',
	'compose/write-story': 'fake-story.ts',
	'audio/recorder': 'fake-recorder.ts',
};
const demoSwaps = {
	name: 'demo-swaps',
	setup(build) {
		build.onResolve({ filter: /^\.\.?\// }, (args) => {
			if (args.importer.startsWith(here)) return undefined;
			for (const [module, swap] of Object.entries(DEMO_SWAPS)) {
				if (args.path.endsWith(module)) return { path: path.join(here, swap) };
			}
			return undefined;
		});
	},
};

// Jeong's styles with the fonts inside, as in the plugin
const styles = {
	name: 'styles',
	setup(build) {
		build.onEnd(() => {
			fs.writeFileSync(path.join(dist, 'jeong.css'), `${fontFaces()}\n\n${fs.readFileSync(path.join(here, '..', 'styles.css'), 'utf8')}`);
		});
	},
};

const common = {
	entryPoints: [path.join(here, 'main.ts')],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	sourcemap: 'inline',
	logLevel: 'info',
};

const real = await esbuild.context({ ...common, outfile: path.join(dist, 'jeong.js'), define: { JEONG_DEMO: 'false' }, plugins: [obsidianShim, inlineWorker(false), styles] });
const demo = await esbuild.context({ ...common, outfile: path.join(dist, 'demo.js'), define: { JEONG_DEMO: 'true' }, plugins: [obsidianShim, demoSwaps, inlineWorker(false)] });

if (serve) {
	await real.watch();
	await demo.watch();
	// styles.css isn't imported by the code, so watch it directly
	fs.watch(path.join(here, '..', 'styles.css'), () => fs.writeFileSync(path.join(dist, 'jeong.css'), `${fontFaces()}\n\n${fs.readFileSync(path.join(here, '..', 'styles.css'), 'utf8')}`));
	const { port } = await real.serve({ servedir: here, port: 8780, host: '127.0.0.1' });
	console.log(`Jeong in the browser: http://localhost:${port}   (sample journal: http://localhost:${port}/?demo   phone layout: add &phone)`);
} else {
	await real.rebuild();
	await demo.rebuild();
	await real.dispose();
	await demo.dispose();
}
