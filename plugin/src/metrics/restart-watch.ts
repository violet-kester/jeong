import type { Plugin } from 'obsidian';
import type { Metrics } from './metrics';

// When a phone runs out of memory it kills the page and reloads it, with no error and nothing to see. So Jeong
// leaves a note on this device while it's on screen and clears it whenever it closes or goes to the background.
// Finding the note at start means the last run ended while it was showing.

const RUNNING = 'jeong-running';

function setRunning(running: boolean): void {
	try {
		if (running) window.localStorage.setItem(RUNNING, '1');
		else window.localStorage.removeItem(RUNNING);
	} catch {
		// Private storage can be blocked; losing this must never break Jeong
	}
}

function wasRunning(): boolean {
	try {
		return window.localStorage.getItem(RUNNING) !== null;
	} catch {
		return false;
	}
}

export function watchRestarts(plugin: Plugin, metrics: Metrics): void {
	metrics.log({ event: 'start', unexpected: wasRunning() });
	const closed = () => {
		if (!wasRunning()) return;
		setRunning(false);
		metrics.log({ event: 'close' });
	};
	setRunning(!document.hidden);
	plugin.registerDomEvent(document, 'visibilitychange', () => {
		if (document.hidden) closed();
		else setRunning(true);
	});
	plugin.registerDomEvent(window, 'pagehide', closed);
	plugin.register(closed);
}
