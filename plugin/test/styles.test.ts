import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const css = fs.readFileSync('styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('sizes use the one unit, because rem follows the font setting in Obsidian', () => {
	const uses = css.split('\n').filter((line) => /\d+rem\b/.test(line) && !line.includes('--jeong-u:'));
	assert.deepEqual(uses, []);
});

test('font sizes come from the type scale', () => {
	const raw = css.split('\n').filter((line) => /font-size:\s*[\d.]+(em|px)\b/.test(line));
	assert.deepEqual(raw.filter((line) => !line.includes('16px')), []);
});
