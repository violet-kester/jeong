// The live waveform, drawn like a brush stroke: it moves at a steady, unhurried pace,
// eases between levels instead of jittering, and flattens gently in silence.

const PIXELS_PER_SECOND = 60; // how fast the stroke travels left
const EASING = 0.12; // 0 to 1: lower is calmer
const GAIN = 3.2; // speech is quiet; lift it so a normal voice fills the space

export class Waveform {
	private ctx: CanvasRenderingContext2D;
	private levels: number[] = [];
	private level = 0;
	private samples: Float32Array<ArrayBuffer>;
	private frame = 0;
	private lastTime = 0;
	private carry = 0;
	private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	constructor(
		private canvas: HTMLCanvasElement,
		private analyser: AnalyserNode,
	) {
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas is not available');
		this.ctx = ctx;
		this.samples = new Float32Array(analyser.fftSize);
	}

	start(): void {
		this.lastTime = performance.now();
		const tick = (time: number) => {
			this.update(time);
			this.draw();
			this.frame = window.requestAnimationFrame(tick);
		};
		this.frame = window.requestAnimationFrame(tick);
	}

	stop(): void {
		window.cancelAnimationFrame(this.frame);
	}

	private update(time: number): void {
		this.analyser.getFloatTimeDomainData(this.samples);
		let sum = 0;
		for (const sample of this.samples) sum += sample * sample;
		const loudness = Math.min(1, Math.sqrt(sum / this.samples.length) * GAIN);
		this.level += (loudness - this.level) * EASING;

		// Add one point per pixel travelled, so the speed is the same on every screen
		this.carry += ((time - this.lastTime) / 1000) * PIXELS_PER_SECOND;
		this.lastTime = time;
		while (this.carry >= 1) {
			this.levels.push(this.level);
			this.carry -= 1;
		}
		const width = this.canvas.clientWidth;
		if (this.levels.length > width) this.levels.splice(0, this.levels.length - width);
	}

	private draw(): void {
		const { canvas, ctx } = this;
		const ratio = window.devicePixelRatio || 1;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
			canvas.width = width * ratio;
			canvas.height = height * ratio;
		}
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const ink = getComputedStyle(canvas).getPropertyValue('--jeong-ink').trim() || 'currentColor';
		const middle = height / 2;

		// A faint hairline across the middle, like a ruled line on paper
		ctx.globalAlpha = 0.2;
		ctx.fillStyle = ink;
		ctx.fillRect(0, middle - 0.5, width, 1);
		ctx.globalAlpha = 1;

		if (this.reducedMotion) {
			// No movement: a single level bar that grows and shrinks
			const bar = Math.max(1, this.level * (height - 8));
			ctx.fillRect(width / 2 - 2, middle - bar / 2, 4, bar);
			return;
		}

		// The newest point sits at the right edge; older ones drift left
		const points = this.levels;
		const start = width - points.length;
		ctx.beginPath();
		ctx.moveTo(start, middle);
		points.forEach((value, i) => ctx.lineTo(start + i, middle - Math.max(0.5, value * (middle - 4))));
		for (let i = points.length - 1; i >= 0; i--) {
			ctx.lineTo(start + i, middle + Math.max(0.5, (points[i] ?? 0) * (middle - 4)));
		}
		ctx.closePath();
		ctx.globalAlpha = 0.85;
		ctx.fill();
		ctx.globalAlpha = 1;
	}
}
