// Microphone capture. One stream feeds both the file recording (MediaRecorder)
// and live analysis (an AnalyserNode for the waveform, later the live transcript).

// The first format the browser supports wins. Desktop Obsidian (Chromium) records
// WebM/Opus; the iPhone app (Safari's engine) records MP4/M4A.
const PREFERRED_FORMATS = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

// Speech needs far less than music. Opus at 32 kbps mono sounds clear for voice and
// takes about 14 MB an hour, against about 58 MB at the browser's usual 128 kbps.
const BITS_PER_SECOND = 32_000;

export interface Recording {
	blob: Blob;
	mimeType: string;
	durationMs: number;
}

/** Somewhere on disk for the audio while it's being recorded, so a killed app loses seconds rather than the take. */
export interface ChunkStore {
	/** Saves the next piece of the recording; pieces only make a playable file together, in order. */
	writePart(data: Blob, chunks: number): Promise<void>;
	/** Everything written so far, as one file. */
	assemble(): Promise<Blob>;
}

/** MediaRecorder gives a chunk a second; a part on disk holds this many, so a kill loses a few seconds at most. */
const CHUNKS_PER_PART = 3;

export class Recorder {
	analyser: AnalyserNode | null = null;
	mimeType = '';

	stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	/** What hasn't reached the disk yet, or all of it when there's nowhere to put it. */
	private chunks: Blob[] = [];
	private startedAt = 0;
	private store: Promise<ChunkStore | null> = Promise.resolve(null);
	private writing: Promise<void> = Promise.resolve();

	async start(openStore?: (mimeType: string) => Promise<ChunkStore>): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});

		this.context = new AudioContext();
		const source = this.context.createMediaStreamSource(this.stream);
		this.analyser = this.context.createAnalyser();
		this.analyser.fftSize = 2048;
		source.connect(this.analyser);

		this.mimeType = PREFERRED_FORMATS.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
		this.mediaRecorder = new MediaRecorder(this.stream, {
			audioBitsPerSecond: BITS_PER_SECOND,
			...(this.mimeType ? { mimeType: this.mimeType } : {}),
		});
		this.mimeType = this.mediaRecorder.mimeType;
		this.chunks = [];
		this.writing = Promise.resolve();
		// No store (or one that can't open) just means holding the audio in memory, as a computer does
		this.store = openStore
			? openStore(this.mimeType).catch((error: unknown) => {
					console.error('Jeong: could not keep the recording on disk as it goes', error);
					return null;
				})
			: Promise.resolve(null);
		const keeping = openStore !== undefined;
		this.mediaRecorder.ondataavailable = (event) => {
			if (event.data.size > 0) this.chunks.push(event.data);
			if (keeping && this.chunks.length >= CHUNKS_PER_PART) this.writeParts();
		};
		this.mediaRecorder.start(1000);
		this.startedAt = performance.now();
	}

	get elapsedMs(): number {
		return this.startedAt ? performance.now() - this.startedAt : 0;
	}

	async stop(): Promise<Recording> {
		const mediaRecorder = this.mediaRecorder;
		if (!mediaRecorder) throw new Error('Not recording');
		const durationMs = this.elapsedMs;
		await new Promise<void>((resolve) => {
			mediaRecorder.onstop = () => resolve();
			mediaRecorder.stop();
		});
		this.writeParts();
		await this.writing;
		const store = await this.store;
		// Anything that couldn't be written yet still follows what was
		const blob = new Blob(store ? [await store.assemble(), ...this.chunks] : this.chunks, { type: this.mimeType });
		const recording = { blob, mimeType: this.mimeType, durationMs };
		this.release();
		return recording;
	}

	/** Moves what's waiting to disk, in order; a failed write stays in memory and goes with the next. */
	private writeParts(): void {
		this.writing = this.writing.then(async () => {
			const store = await this.store;
			const batch = [...this.chunks];
			if (!store || !batch.length) return;
			try {
				await store.writePart(new Blob(batch, { type: this.mimeType }), batch.length);
				this.chunks.splice(0, batch.length);
			} catch (error) {
				console.error('Jeong: could not write part of the recording', error);
			}
		});
	}

	/** Stop the microphone and free audio resources, whether or not a recording finished. */
	release(): void {
		this.stream?.getTracks().forEach((track) => track.stop());
		void this.context?.close();
		this.stream = null;
		this.context = null;
		this.analyser = null;
		this.mediaRecorder = null;
		this.startedAt = 0;
		this.chunks = [];
	}
}
