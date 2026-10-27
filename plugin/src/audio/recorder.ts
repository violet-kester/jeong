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

export class Recorder {
	analyser: AnalyserNode | null = null;
	mimeType = '';

	stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;

	async start(): Promise<void> {
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
		// Collect audio every second, so a crash loses at most a moment
		this.mediaRecorder.ondataavailable = (event) => {
			if (event.data.size > 0) this.chunks.push(event.data);
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
		const recording = { blob: new Blob(this.chunks, { type: this.mimeType }), mimeType: this.mimeType, durationMs };
		this.release();
		return recording;
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
	}
}
