// Demo only (?demo): a pretend microphone, so the recording window works without asking for one.
// It makes a soft, speech-like sound (bursts with pauses) that's analysed but never played aloud.

import type { Recording } from '../src/audio/recorder';

export class Recorder {
	analyser: AnalyserNode | null = null;
	stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private started = 0;

	async start(): Promise<void> {
		const context = new AudioContext();
		this.context = context;
		const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
		const data = noise.getChannelData(0);
		for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
		const source = context.createBufferSource();
		source.buffer = noise;
		source.loop = true;
		// Syllables and pauses: the noise's volume follows two slow waves
		const voice = context.createGain();
		voice.gain.value = 0;
		const syllables = context.createOscillator();
		syllables.frequency.value = 4.2;
		const phrases = context.createOscillator();
		phrases.frequency.value = 0.35;
		const depth = context.createGain();
		depth.gain.value = 0.25;
		syllables.connect(depth).connect(voice.gain);
		phrases.connect(depth);
		source.connect(voice);
		this.analyser = context.createAnalyser();
		this.analyser.fftSize = 2048;
		voice.connect(this.analyser);
		const output = context.createMediaStreamDestination();
		voice.connect(output);
		this.stream = output.stream;
		source.start();
		syllables.start();
		phrases.start();
		this.started = performance.now();
	}

	get elapsedMs(): number {
		return this.started ? performance.now() - this.started : 0;
	}

	async stop(): Promise<Recording> {
		const durationMs = this.elapsedMs;
		await this.context?.close();
		this.context = null;
		this.analyser = null;
		this.stream = null;
		this.started = 0;
		return { blob: new Blob(['demo'], { type: 'audio/webm' }), mimeType: 'audio/webm', durationMs } as Recording;
	}

	release(): void {
		void this.context?.close();
		this.context = null;
	}
}
