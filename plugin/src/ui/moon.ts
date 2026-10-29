import type { moment } from 'obsidian';
import { t } from '../i18n';

// The moon's phase on a day, drawn small under the day's name on the timeline: a faint ring, with the lit
// part filled in, waxing from the right and waning to the left, as seen from the northern hemisphere.

const SYNODIC_DAYS = 29.530588853; // new moon to new moon
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
const NAMES = ['new', 'waxingCrescent', 'firstQuarter', 'waxingGibbous', 'full', 'waningGibbous', 'lastQuarter', 'waningCrescent'] as const;

/** Draws the moon on `day` (at its evening) into `el`. */
export function moonPhase(el: HTMLElement, day: moment.Moment): void {
	const days = (day.clone().hour(21).valueOf() - NEW_MOON) / 86_400_000;
	const phase = (((days / SYNODIC_DAYS) % 1) + 1) % 1; // 0 new, 0.5 full
	const name = NAMES[Math.round(phase * 8) % 8] ?? 'new';
	el.setAttribute('role', 'img');
	el.setAttribute('aria-label', t(`moon.${name}`));
	el.setAttribute('title', t(`moon.${name}`));

	const r = 5;
	const svg = el.createSvg('svg', { attr: { viewBox: '-6 -6 12 12', 'aria-hidden': 'true' } });
	svg.createSvg('circle', { cls: 'jeong-moon-ring', attr: { r } });
	// The lit part: half the disc on its bright side, closed by the terminator, an ellipse as wide as the light is uneven
	const waxing = phase < 0.5;
	const k = Math.cos(phase * 2 * Math.PI);
	const rx = Math.abs(k) * r;
	const outer = waxing ? 1 : 0;
	const inner = waxing === k > 0 ? 0 : 1;
	svg.createSvg('path', { cls: 'jeong-moon-lit', attr: { d: `M0 ${-r}A${r} ${r} 0 0 ${outer} 0 ${r}A${rx.toFixed(2)} ${r} 0 0 ${inner} 0 ${-r}Z` } });
}
