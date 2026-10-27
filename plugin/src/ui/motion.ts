// Jeong's motion: smooth, gentle, and patient. Things arrive by fading in as they rise a little into
// place, and leave by fading as they settle. The timings and easings are the motion tokens in styles.css
// (--jeong-gentle, --jeong-ease, ...), so everything moves as one family.
//
// These use the Web Animations API rather than CSS classes so that an interruption never jumps:
// showing something that's halfway through leaving carries on from where it is, back into place.

const running = new WeakMap<HTMLElement, Animation>();

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A motion token from styles.css, e.g. token(el, 'gentle') → 550 (ms), token(el, 'ease') → "cubic-bezier(…)". */
function token(el: HTMLElement, name: string): string {
	return getComputedStyle(el).getPropertyValue(`--jeong-${name}`).trim();
}

function ms(el: HTMLElement, name: string, fallback: number): number {
	const value = token(el, name);
	const number = parseFloat(value);
	if (Number.isNaN(number)) return fallback;
	return value.endsWith('ms') ? number : number * 1000;
}

/** Where the element is right now (opacity and transform), so a new motion starts from there. */
function current(el: HTMLElement): Keyframe {
	const style = getComputedStyle(el);
	return { opacity: style.opacity, transform: style.transform === 'none' ? 'translateY(0)' : style.transform };
}

function play(el: HTMLElement, from: Keyframe, to: Keyframe, duration: string, easing: string): Animation | null {
	running.get(el)?.cancel();
	if (reducedMotion()) return null;
	const animation = el.animate([from, to], { duration: ms(el, duration, 550), easing: token(el, easing) || 'ease-out', fill: 'both' });
	running.set(el, animation);
	return animation;
}

/** Shows an element: it fades in as it rises a little into place. */
export function arrive(el: HTMLElement): void {
	const hidden = el.style.display === 'none' || el.hasClass('is-hidden');
	const from = hidden ? { opacity: '0', transform: `translateY(${token(el, 'rise') || '10px'})` } : current(el);
	el.removeClass('is-hidden');
	el.show();
	play(el, from, { opacity: '1', transform: 'translateY(0)' }, 'gentle', 'ease');
}

/**
 * Hides an element: it fades as it settles, then is hidden. With `done`, that runs instead and the element
 * stays faded out (for something about to be removed, like a closing window, so it never flashes back).
 */
export function leave(el: HTMLElement, done?: () => void): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			if (done) {
				done();
			} else {
				el.hide();
				running.get(el)?.cancel();
			}
			running.delete(el);
			resolve();
		};
		if (el.style.display === 'none') return finish();
		const animation = play(el, current(el), { opacity: '0', transform: `translateY(calc(${token(el, 'rise') || '10px'} / 2))` }, 'quick', 'ease-in-out');
		if (!animation) return finish();
		animation.onfinish = finish;
		// If something else takes over this element (it arrives again), stop waiting
		animation.oncancel = () => resolve();
	});
}

/** Fades an element in or out without moving it, e.g. the dimmed background behind a window. */
export function fade(el: HTMLElement, to: 'in' | 'out'): Promise<void> {
	return new Promise((resolve) => {
		const from = to === 'in' ? { opacity: '0' } : { opacity: getComputedStyle(el).opacity };
		const animation = play(el, from, { opacity: to === 'in' ? '1' : '0' }, to === 'in' ? 'gentle' : 'quick', 'ease-in-out');
		if (!animation) return resolve();
		animation.onfinish = () => resolve();
		animation.oncancel = () => resolve();
	});
}
