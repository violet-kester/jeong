// A password on Jeong's own screen, not encryption: the journal's files stay ordinary, readable files.
// Only a salted PBKDF2 verifier is stored, never the password.

export interface LockVerifier {
	salt: string;
	hash: string;
	iterations: number;
}

const ITERATIONS = 600_000;
/** Away from the app for longer than this, the screen locks again. */
const RELOCK_AFTER_MS = 5 * 60 * 1000;

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

async function derive(password: string, salt: string, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations }, key, 256);
	return toHex(new Uint8Array(bits));
}

export async function makeVerifier(password: string): Promise<LockVerifier> {
	const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
	return { salt, iterations: ITERATIONS, hash: await derive(password, salt, ITERATIONS) };
}

export class JournalLock {
	private open = false;
	private revealed = false;
	private awaySince = 0;
	private listeners = new Set<() => void>();

	constructor(
		private verifier: () => LockVerifier | null,
		private store: (verifier: LockVerifier | null) => Promise<void>,
	) {}

	get enabled(): boolean {
		return this.verifier() !== null;
	}

	get locked(): boolean {
		return this.enabled && !this.open;
	}

	/** Hidden entries are on the timeline for now. */
	get showHidden(): boolean {
		return this.revealed && !this.locked;
	}

	async check(password: string): Promise<boolean> {
		const verifier = this.verifier();
		if (!verifier) return true;
		return (await derive(password, verifier.salt, verifier.iterations)) === verifier.hash;
	}

	async unlock(password: string): Promise<boolean> {
		if (!(await this.check(password))) return false;
		this.open = true;
		this.changed();
		return true;
	}

	lock(): void {
		this.open = false;
		this.revealed = false;
		this.changed();
	}

	async setPassword(password: string): Promise<void> {
		await this.store(await makeVerifier(password));
		this.open = true;
		this.changed();
	}

	async remove(): Promise<void> {
		await this.store(null);
		this.revealed = false;
		this.changed();
	}

	setShowHidden(show: boolean): void {
		this.revealed = show;
		this.changed();
	}

	/** The app went out of view, or came back: back after a long time away, it locks. */
	noteVisibility(hidden: boolean): void {
		if (hidden) {
			this.awaySince = Date.now();
			return;
		}
		if (this.awaySince && Date.now() - this.awaySince > RELOCK_AFTER_MS && this.enabled && this.open) this.lock();
		this.awaySince = 0;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		this.listeners.forEach((listener) => listener());
	}
}
