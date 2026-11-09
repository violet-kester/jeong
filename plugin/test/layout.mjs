// Opens the demo in a real browser at the root font sizes people have in Obsidian, and checks the layouts hold.
// CHROME_PATH picks the browser; otherwise Playwright's cached Chromium.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOTS = [10, 12, 16, 22];
const URL = 'http://localhost:8780/';
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1.5, `${label}: ${a} vs ${b}`);

function browserPath() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
	for (const dir of fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name))) {
		for (const sub of fs.readdirSync(path.join(cache, dir))) {
			const chrome = path.join(cache, dir, sub, 'chrome');
			if (fs.existsSync(chrome)) return chrome;
		}
	}
	throw new Error('No Chromium found: set CHROME_PATH');
}

async function waitForServer() {
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(URL)).ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error('The demo did not start');
}

const box = (page, selector) => page.locator(selector).first().evaluate((el) => {
	const r = el.getBoundingClientRect();
	return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
});

async function checkRecording(browser, root) {
	const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
	await page.goto(`${URL}?demo&phone&root=${root}`);
	await page.locator('.jeong-timeline-record').click();
	await page.waitForSelector('.jeong-voice-orb');
	const idle = await box(page, '.jeong-record-button');
	await page.locator('.jeong-record input[type=file]').first().setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
	await page.waitForSelector('.jeong-photos-item');
	const withPhoto = await box(page, '.jeong-record-button');
	await page.locator('.jeong-record-button').click();
	await page.waitForSelector('.jeong-record-button.is-recording');
	await page.waitForTimeout(400);
	const recording = await box(page, '.jeong-record-button');
	near(recording.top, withPhoto.top, 'starting to record must not move the button');
	const timer = await box(page, '.jeong-record-timer');
	const heading = await box(page, '.jeong-entry-heading');
	assert.ok(timer.bottom <= heading.top, `timer overlaps the status at root ${root}`);
	await page.locator('.jeong-record-button').click();
	await page.waitForSelector('.jeong-record.has-entry');
	await page.waitForTimeout(400);
	const after = await box(page, '.jeong-record-button');
	const open = await box(page, '.jeong-open-button');
	near(after.width, idle.width, 'Record more matches the record button');
	near(open.width, idle.width, 'Open entry matches the record button');
	await page.close();
	return idle.width;
}

async function checkPreview(browser, root) {
	const page = await browser.newPage({ viewport: { width: 430, height: 620 } });
	await page.goto(`${URL}?demo&root=${root}`);
	const card = page.locator('.jeong-timeline-entry:has(img)').first();
	await card.waitFor();
	await card.hover({ force: true });
	await page.waitForSelector('.jeong-timeline-card-actions', { timeout: 5000 });
	await page.waitForTimeout(500);
	const preview = await box(page, '.jeong-timeline-card');
	const actions = await box(page, '.jeong-timeline-card-actions');
	assert.ok(actions.bottom <= preview.bottom + 1, `preview hides its buttons at root ${root}`);
	assert.ok(preview.bottom <= 620, `preview runs off the pane at root ${root}`);
	await page.getByText('Read the story', { exact: true }).click();
	await page.waitForSelector('.jeong-story-actions');
	await page.waitForTimeout(400);
	const story = await box(page, '.modal.jeong-story');
	const words = await box(page, '.jeong-story-scroll');
	const buttons = await box(page, '.jeong-story-actions');
	assert.ok(words.bottom <= buttons.top + 1, `the story runs under its buttons at root ${root}`);
	near(buttons.bottom, story.bottom, `nothing shows below the story's buttons at root ${root}`);
	await page.close();
}

const server = spawn(process.execPath, ['web/build.mjs', '--serve'], { stdio: 'ignore' });
let failed = false;
const browser = await chromium.launch({ executablePath: browserPath() });
try {
	await waitForServer();
	const widths = {};
	for (const root of ROOTS) {
		widths[root] = await checkRecording(browser, root);
		await checkPreview(browser, root);
		console.log(`ok root ${root}: record button ${Math.round(widths[root])}px`);
	}
	near(widths[10], widths[16], 'a small font setting must not shrink Jeong');
	assert.ok(widths[22] > widths[16], 'a large font setting still enlarges Jeong');
} catch (error) {
	failed = true;
	console.error(error);
} finally {
	await browser.close();
	server.kill();
}
process.exit(failed ? 1 : 0);
