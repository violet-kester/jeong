import { Platform } from 'obsidian';

// Starts ComfyUI when a painting needs it and it isn't running, with the command from settings, and stops it
// again once Jeong is done painting. Only ComfyUI that Jeong started itself is ever stopped. Computers only.

/** The little of Node's child_process and process that Jeong uses, loaded only on a computer. */
interface ChildProcess {
	pid?: number;
	on(event: 'exit', listener: () => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
}
interface Node {
	spawn(command: string, args: string[] | { shell: boolean; windowsHide: boolean; detached: boolean; stdio: 'ignore' }, options?: { windowsHide: boolean; stdio: 'ignore' }): ChildProcess;
	kill(pid: number): void;
}

const READY_MS = 3 * 60 * 1000; // ComfyUI takes a while to start, longer the first time
const CHECK_MS = 2000;

export class ComfyLauncher {
	private process: ChildProcess | null = null;

	constructor(
		private command: () => string,
		private isReady: () => Promise<boolean>,
	) {}

	/** True when there's a command to start ComfyUI with, on a computer. */
	get canStart(): boolean {
		return Platform.isDesktopApp && !!this.command().trim();
	}

	/** Starts ComfyUI and waits until it answers. False if it couldn't be started or didn't come up in time. */
	async start(): Promise<boolean> {
		if (!this.canStart) return false;
		if (!this.process) {
			const child = node().spawn(this.command(), { shell: true, windowsHide: true, detached: !Platform.isWin, stdio: 'ignore' });
			child.on('exit', () => {
				if (this.process === child) this.process = null;
			});
			child.on('error', (error) => console.error('Jeong: could not start ComfyUI', error));
			this.process = child;
		}
		const started = Date.now();
		while (Date.now() - started < READY_MS) {
			if (await this.isReady()) return true;
			if (!this.process) return false; // it quit
			await new Promise((resolve) => window.setTimeout(resolve, CHECK_MS));
		}
		this.stop();
		return false;
	}

	/** Stops ComfyUI, if Jeong started it, with everything it started (the shell runs it as a child). */
	stop(): void {
		const child = this.process;
		this.process = null;
		if (!child?.pid) return;
		try {
			if (Platform.isWin) {
				node().spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			} else node().kill(-child.pid); // the whole group it started
		} catch {
			// Already gone
		}
	}

	/** True while ComfyUI is running because Jeong started it. */
	get started(): boolean {
		return !!this.process;
	}
}

/** Node's child_process and process, from Obsidian on a computer (the browser and phone builds never reach this). */
function node(): Node {
	if (!Platform.isDesktopApp) throw new Error('ComfyUI can only be started on a computer');
	const childProcess = (window as unknown as { require: (id: string) => { spawn: Node['spawn'] } }).require('child_process');
	const process = (window as unknown as { process: { kill: Node['kill'] } }).process;
	return { spawn: childProcess.spawn, kill: (pid) => process.kill(pid) };
}
