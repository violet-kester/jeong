// Your voice along the bottom of the recording window, as a normal filled waveform in the record
// button's persimmon. While you talk it travels into the stop button, newest sound at the button,
// and one clean ring around the button swells gently with your voice. When you stop, it holds your
// whole recording across the bottom, running into the buttons.

const PIXELS_PER_SECOND = 70; // how fast the waveform travels toward the button
const PEAK_GAIN = 1.8; // speech is quiet; lift it so a normal voice fills the waveform
const EASING = 0.16; // 0 to 1, for the ring: lower is calmer
const RING_GAP = 4; // space between the stop button and its ring: close, so the ring hugs the button
const TAKE_GAP = 18; // quiet pixels between one recording and the next ("Record more")

export class VoiceHorizon {
	private ctx: CanvasRenderingContext2D;
	private analyser: AnalyserNode | null = null;
	private samples = new Float32Array(0);
	private level = 0;
	/** The loudest point of each pixel travelled, for everything recorded in this window. */
	private peaks: number[] = [];
	private carry = 0;
	private lastTime = 0;
	private frame = 0;
	/** Watches the layout while not recording, so the waveform stays centred on the buttons as they move. */
	private watch = 0;
	private layout = '';

	constructor(
		private canvas: HTMLCanvasElement,
		private button: HTMLElement,
		/** The Open entry button, once it's showing: the waveform ends where it begins. */
		private openButton: HTMLElement,
		/** line: a waveform running into the button. rings: just rings around the button (when there are no words to show). */
		private mode: 'line' | 'rings' = 'line',
	) {
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas is not available');
		this.ctx = ctx;
		// The window opens with a short zoom, and labels, the Open entry button, and the story pane all move
		// the record button after you stop; redraw whenever it or the canvas has moved
		const watch = () => {
			if (!this.analyser) {
				const rect = this.button.getBoundingClientRect();
				const layout = [rect.left, rect.top, rect.width, canvas.clientWidth, canvas.clientHeight, this.openButton.offsetParent ? 1 : 0].join();
				if (layout !== this.layout) {
					this.layout = layout;
					this.draw();
				}
			}
			this.watch = window.requestAnimationFrame(watch);
		};
		this.watch = window.requestAnimationFrame(watch);
	}

	start(analyser: AnalyserNode): void {
		this.analyser = analyser;
		this.samples = new Float32Array(analyser.fftSize);
		if (this.peaks.length) this.peaks.push(...new Array<number>(TAKE_GAP).fill(0));
		this.lastTime = performance.now();
		const tick = (time: number) => {
			this.listen(time);
			this.draw();
			this.frame = window.requestAnimationFrame(tick);
		};
		this.frame = window.requestAnimationFrame(tick);
	}

	/** Stops listening and holds the whole recording along the bottom. */
	stop(): void {
		window.cancelAnimationFrame(this.frame);
		this.analyser = null;
		this.level = 0;
		this.draw();
	}

	dispose(): void {
		window.cancelAnimationFrame(this.frame);
		window.cancelAnimationFrame(this.watch);
		this.analyser = null;
	}

	private listen(time: number): void {
		if (!this.analyser) return;
		this.analyser.getFloatTimeDomainData(this.samples);
		let sum = 0;
		let peak = 0;
		for (const sample of this.samples) {
			sum += sample * sample;
			peak = Math.max(peak, Math.abs(sample));
		}
		const loudness = Math.min(1, Math.sqrt(sum / Math.max(1, this.samples.length)) * 3.2);
		this.level += (loudness - this.level) * EASING;

		// One peak per pixel travelled, so the speed is the same on every screen
		this.carry += ((time - this.lastTime) / 1000) * PIXELS_PER_SECOND;
		this.lastTime = time;
		while (this.carry >= 1) {
			this.peaks.push(Math.min(1, peak * PEAK_GAIN));
			this.carry -= 1;
		}
	}

	draw(): void {
		const { canvas, ctx } = this;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		if (!width || !height) return;
		const ratio = window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const colors = getComputedStyle(canvas);
		const ink = colors.getPropertyValue('--jeong-persimmon').trim() || '#B2432F';
		const hairline = colors.getPropertyValue('--jeong-hairline').trim() || 'rgba(128,128,128,0.3)';

		// Where the buttons sit on the canvas. On-screen positions are scaled while the window zooms open,
		// so divide that scale back out to get exact canvas coordinates.
		const box = canvas.getBoundingClientRect();
		const scale = box.width / width || 1;
		const rect = this.button.getBoundingClientRect();
		const radius = rect.width / scale / 2;
		const cx = (rect.left - box.left) / scale + radius;
		const cy = (rect.top - box.top) / scale + radius;
		const ring = radius + RING_GAP + this.level * 4;
		const open = this.openButton.offsetParent ? this.openButton.getBoundingClientRect() : null;
		const end = open ? (open.left - box.left) / scale + open.width / scale / 2 : cx - ring;
		const amplitude = Math.min(46, height * 0.32);

		if (this.mode === 'rings') {
			this.drawRings(cx, cy, radius, ink, hairline);
			return;
		}

		if (this.analyser) {
			this.drawLive(end, cy, amplitude, ink);
			this.drawRing(cx, cy, ring + 2, 4 + this.level * 2, ink);
		} else if (this.peaks.length) {
			this.drawHeld(end, cy, amplitude, ink);
		} else {
			// Waiting: a still, faint line and ring
			ctx.strokeStyle = hairline;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(0, Math.round(cy) + 0.5);
			ctx.lineTo(cx - radius - RING_GAP, Math.round(cy) + 0.5);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(cx, cy, radius + RING_GAP, 0, Math.PI * 2);
			ctx.stroke();
		}
	}

	/** While recording: the newest sound at the button, older sound drifting off to the left. */
	private drawLive(end: number, cy: number, amplitude: number, ink: string): void {
		const { peaks } = this;
		this.fillWave(end, cy, ink, (x) => {
			const index = peaks.length - 1 - Math.round(end - x);
			return index >= 0 ? (peaks[index] ?? 0) * amplitude : 0;
		});
	}

	/** After recording: everything you said, fitted to the width, running into the buttons. */
	private drawHeld(end: number, cy: number, amplitude: number, ink: string): void {
		const { peaks } = this;
		const per = peaks.length / Math.max(1, end);
		this.fillWave(end, cy, ink, (x) => {
			const from = Math.floor(x * per);
			const to = Math.max(from + 1, Math.floor((x + 1.5) * per));
			let max = 0;
			for (let i = from; i < to && i < peaks.length; i++) max = Math.max(max, peaks[i] ?? 0);
			return max * amplitude;
		});
	}

	/** A normal filled waveform: mirrored around the centre line, solid persimmon. */
	private fillWave(end: number, cy: number, ink: string, heightAt: (x: number) => number): void {
		const { ctx } = this;
		if (end < 2) return;
		const top: [number, number][] = [];
		for (let x = 0; x <= end; x += 1.5) top.push([x, Math.max(0.6, heightAt(x))]);
		ctx.fillStyle = ink;
		ctx.beginPath();
		top.forEach(([x, a], i) => (i ? ctx.lineTo(x, cy - a) : ctx.moveTo(x, cy - a)));
		for (let i = top.length - 1; i >= 0; i--) {
			const point = top[i];
			if (point) ctx.lineTo(point[0], cy + point[1]);
		}
		ctx.closePath();
		ctx.fill();
	}

	/** Two rings around the button: faint and still while waiting; swelling with your voice while recording. */
	private drawRings(cx: number, cy: number, radius: number, ink: string, hairline: string): void {
		const { ctx } = this;
		if (!this.analyser) {
			ctx.strokeStyle = hairline;
			ctx.lineWidth = 1;
			for (const gap of [16, 44]) {
				ctx.beginPath();
				ctx.arc(cx, cy, radius + gap, 0, Math.PI * 2);
				ctx.stroke();
			}
			return;
		}
		this.drawRing(cx, cy, radius + RING_GAP + 2 + this.level * 10, 4 + this.level * 2, ink);
		ctx.globalAlpha = 0.45;
		this.drawRing(cx, cy, radius + 40 + this.level * 26, 1.5, ink);
		ctx.globalAlpha = 1;
	}

	private drawRing(cx: number, cy: number, radius: number, width: number, ink: string): void {
		const { ctx } = this;
		ctx.strokeStyle = ink;
		ctx.lineWidth = width;
		ctx.beginPath();
		ctx.arc(cx, cy, radius, 0, Math.PI * 2);
		ctx.stroke();
	}
}
