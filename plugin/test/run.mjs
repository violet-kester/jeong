// Bundles test/*.test.ts with the same "obsidian" stand-in the browser build uses, then runs them with Node's test runner.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const outdir = path.join(here, '..', 'build', 'test');
fs.rmSync(outdir, { recursive: true, force: true });
const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(here, '..', 'web', 'obsidian.ts') }));
	},
};
const entryPoints = fs.readdirSync(here).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(here, name));
await esbuild.build({ entryPoints, outdir, bundle: true, format: 'cjs', outExtension: { '.js': '.cjs' }, platform: 'node', target: 'node20', loader: { '.svg': 'text' }, logLevel: 'warning', plugins: [obsidianShim] });
const files = fs.readdirSync(outdir).filter((name) => name.endsWith('.cjs')).map((name) => path.join(outdir, name));
process.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1);
