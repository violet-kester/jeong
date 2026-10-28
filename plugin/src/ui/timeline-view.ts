import { ItemView, Notice, Platform, WorkspaceLeaf, debounce, moment, setIcon } from 'obsidian';
import type JeongPlugin from '../main';
import { t } from '../i18n';
import { listEntries, type EntryInfo } from '../journal/entries';
import { setNightSky } from './night-sky';
import { arrive, leave } from './motion';
import { openButtonPill } from './open-button';
import { paintMessage } from './story-messages';
import { brushReveal } from '../paint/brush-reveal';
import { storyText } from '../journal/story-text';
import { StoryModal } from './story-modal';
import { applyInk } from '../paint/ink';

export const TIMELINE_VIEW = 'jeong-timeline';

// A timeline of the journal, a year, a month, a week, or a day at a time, in the style of the printed-chart
// sketch: huge numerals (months in a year, days in a month or week, hours in a day), entries as small cards
// standing on one line, and a red line for now. Hover a card for a larger preview; click to open the entry.
// Drag to move around; pinch, Ctrl + wheel, or the − and + buttons stretch the period out or squeeze it in.
// A numeral takes you one step closer: a month to that month, a day to its week, a day in a week to that day.

const NUMERALS_HEIGHT = 170;
const PHOTO_TURN_MS = 4000; // how long each picture shows before the next one fades in
const MAX_CARDS_PER_DAY = 8; // more than this on one day fold into "+N"
const MIN_HEIGHT = 420; // the numerals plus a row of cards above and below the line
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;
/** How wide a day is at least, in month, week, and day views, in card widths, so cards have room to stand side by side. */
const DAY_WIDTH: Record<Scale, number> = { year: 0, month: 0.4, week: 1.2, day: 12 };
/** Zooming in brings the cards closer as fast as it stretches time, up to max; zooming out never shrinks them. */
const CARD_SCALE = { min: 1, max: 4, power: 1 };

/**
 * The sizes cards are laid out with, in pixels. They come from styles.css (Jeong's fluid scale, so they
 * follow the pane's width), times the zoom's card scale.
 */
interface Layout {
	cardWidth: number;
	/** A card with no picture: date, title, and two lines of summary. */
	cardHeight: number;
	/** What a picture adds to a card. */
	photoHeight: number;
	/** Between cards. */
	gap: number;
	/** Between the line and the nearest cards. */
	stem: number;
	/** How far into the card its stem sits. */
	stemOffset: number;
}
const PREVIEW_REST_MS = 300; // the pointer rests this long on a card before its preview shows, so passing over doesn't flash it

type Scale = 'year' | 'month' | 'week' | 'day';
const SCALES: Scale[] = ['year', 'month', 'week', 'day'];
/** What each view's columns are, and where its numerals take you. */
const COLUMN: Record<Scale, 'month' | 'day' | 'hour'> = { year: 'month', month: 'day', week: 'day', day: 'hour' };
const CLOSER: Record<Scale, Scale | null> = { year: 'month', month: 'week', week: 'day', day: null };

export class TimelineView extends ItemView {
	private scale: Scale = 'week';
	/** The first day of the year, month, or week shown. */
	private start = moment().startOf('week');
	private scalePicker!: HTMLSelectElement;
	private periodPicker!: HTMLElement;
	private selected: string | null = null;
	private scroller!: HTMLElement;
	private track!: HTMLElement;
	private preview!: HTMLElement;
	private showTimer = 0;
	private hideTimer = 0;
	private bar!: HTMLElement;
	private top = 0; // the header and bar float over the top of the timeline; the year is laid out below them
	private yearLabel!: HTMLElement;
	private dragging = { active: false, moved: false, x: 0, y: 0, left: 0, top: 0 };
	private zoom = 1;
	private themeButton?: HTMLButtonElement;
	private layout: Layout = { cardWidth: 220, cardHeight: 92, photoHeight: 132, gap: 10, stem: 18, stemOffset: 14 };
	private zoomFrame = 0;
	private axisY = 0;
	/** Centre on today once the pane has its real size (a new pane can open before it has one). */
	private pendingToday = true;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: JeongPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return TIMELINE_VIEW;
	}

	getDisplayText(): string {
		return t('timeline.title');
	}

	getIcon(): string {
		return 'history';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('jeong', 'jeong-timeline');
		// Jeong's colors on the whole tab, so the paper runs up through Obsidian's header strip too
		this.containerEl.addClass('jeong');
		setNightSky(root);

		const bar = (this.bar = root.createDiv({ cls: 'jeong-timeline-bar' }));
		// Two soft pills. The first picks what to look at: a kind of period on one side (Year, Month, Week, Day),
		// and on the other, which one, with arrows, or by tapping it for a picker. The second has zoom and Today.
		const period = bar.createDiv({ cls: 'jeong-timeline-pill jeong-timeline-period' });
		const scaleSlot = period.createDiv({ cls: 'jeong-timeline-scale' });
		this.scalePicker = scaleSlot.createEl('select', { attr: { 'aria-label': t('timeline.view') } });
		for (const scale of SCALES) this.scalePicker.createEl('option', { text: t(`timeline.${scale}`), attr: { value: scale } });
		setIcon(scaleSlot.createSpan({ cls: 'jeong-timeline-scale-icon' }), 'chevron-down');
		this.scalePicker.addEventListener('change', () => this.setScale(this.scalePicker.value as Scale));
		period.createSpan({ cls: 'jeong-timeline-pill-divider' });
		const earlier = period.createEl('button', { attr: { 'aria-label': t('timeline.earlier') } });
		const which = period.createDiv({ cls: 'jeong-timeline-which' });
		this.yearLabel = which.createDiv({ cls: 'jeong-timeline-year' });
		this.periodPicker = which.createDiv({ cls: 'jeong-timeline-picker' });
		const later = period.createEl('button', { attr: { 'aria-label': t('timeline.later') } });
		const views = bar.createDiv({ cls: 'jeong-timeline-pill' });
		const zoomOut = views.createEl('button', { attr: { 'aria-label': t('timeline.zoomOut') } });
		const zoomIn = views.createEl('button', { attr: { 'aria-label': t('timeline.zoomIn') } });
		setIcon(earlier, 'chevron-left');
		setIcon(later, 'chevron-right');
		setIcon(zoomOut, 'minus');
		setIcon(zoomIn, 'plus');
		const today = views.createEl('button', { cls: 'jeong-timeline-today' });
		setIcon(today.createSpan({ cls: 'jeong-timeline-today-icon' }), 'locate-fixed');
		today.createSpan({ text: t('timeline.today') });
		// Light and dark, one tap away at the end of the bar; the theme in settings is the default
		this.themeButton = views.createEl('button', { cls: 'jeong-timeline-theme' });
		this.themeButton.addEventListener('click', () => this.plugin.showTheme(isDark() ? 'light' : 'dark'));
		this.showThemeButton();
		// Following Obsidian, the button changes when Obsidian's own theme does
		this.registerEvent(this.app.workspace.on('css-change', () => this.showThemeButton()));
		zoomOut.addEventListener('click', () => this.setZoom(this.zoom / 1.6));
		zoomIn.addEventListener('click', () => this.setZoom(this.zoom * 1.6));
		earlier.addEventListener('click', () => this.showPeriod(this.start.clone().subtract(1, this.scale)));
		later.addEventListener('click', () => this.showPeriod(this.start.clone().add(1, this.scale)));
		today.addEventListener('click', () => this.goToToday());

		this.scroller = root.createDiv({ cls: 'jeong-timeline-scroller' });
		this.track = this.scroller.createDiv({ cls: 'jeong-timeline-track' });
		// Recording a new entry is always one big, clear button away
		const record = root.createEl('button', { cls: 'jeong-timeline-record', attr: { 'aria-label': t('ribbon.record') } });
		setIcon(record.createSpan({ cls: 'jeong-timeline-record-icon' }), 'mic');
		record.createSpan({ text: t('timeline.record') });
		record.addEventListener('click', () => this.plugin.openRecorder());

		this.preview = root.createDiv({ cls: 'jeong-timeline-card' });
		this.preview.hide();
		// Keep the preview open while the pointer is on it
		this.preview.addEventListener('pointerenter', () => window.clearTimeout(this.hideTimer));
		this.preview.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') this.scheduleHide();
		});
		this.enablePanning();
		this.cyclePhotos();

		// Redraw when entries change
		this.registerEvent(this.app.metadataCache.on('changed', this.refresh));
		this.registerEvent(this.app.vault.on('delete', this.refresh));
		this.registerEvent(this.app.vault.on('rename', this.refresh));
		// A card shows its brush moving while its picture is painted
		this.register(this.plugin.painter.onChange(this.refresh));
		this.applyInk();

		this.goToToday();
	}

	/** The light and dark button offers whichever the timeline isn't showing. */
	showThemeButton(): void {
		if (!this.themeButton) return;
		const dark = isDark();
		setIcon(this.themeButton, dark ? 'sun' : 'moon');
		this.themeButton.setAttribute('aria-label', t(dark ? 'timeline.lightTheme' : 'timeline.darkTheme'));
	}

	/** Shows paintings in the ink color from settings. */
	applyInk(): void {
		applyInk(this.contentEl, this.plugin.settings.paintInk);
	}

	// Redraw when the pane changes size, including when it first gets one (a new pane can open at 0 height)
	onResize(): void {
		if (this.track) this.refresh();
	}

	private refresh = debounce(() => this.redraw(), 300, true);

	/** Shows the year, month, or week with today in it, with now in the middle. */
	goToToday(): void {
		this.showPeriod(moment(), moment());
		this.pendingToday = this.scroller.clientWidth === 0;
	}

	/** Draws again after a change, keeping the same date in the middle of the view. */
	private redraw(): void {
		if (this.pendingToday) return this.goToToday();
		const anchor = this.scroller.clientWidth / 2;
		const at = (this.scroller.scrollLeft + anchor) / this.track.clientWidth;
		const top = this.scroller.scrollTop;
		this.render();
		this.scroller.scrollLeft = at * this.track.clientWidth - anchor;
		this.scroller.scrollTop = top;
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/**
	 * Switches between Year, Month, Week, and Day, staying with `at`; otherwise with today, if it's in the
	 * period shown; otherwise with the date in the middle of the view.
	 */
	private setScale(scale: Scale, at?: moment.Moment): void {
		const now = moment();
		const showingToday = !now.isBefore(this.start) && now.isBefore(this.end());
		const middle = at ?? (showingToday ? now : this.dateAt(this.scroller.scrollLeft + this.scroller.clientWidth / 2));
		this.scale = scale;
		this.zoom = 1;
		this.showPeriod(middle, middle);
	}

	/** Shows the year, month, or week that `date` falls in; `focus`, if it's in that period, goes in the middle. */
	private showPeriod(date: moment.Moment, focus?: moment.Moment): void {
		this.start = date.clone().startOf(this.scale);
		this.render();
		const inside = focus && !focus.isBefore(this.start) && focus.isBefore(this.end());
		const target = inside ? this.x(this.offset(focus)) : 0;
		this.scroller.scrollLeft = Math.max(0, target - this.scroller.clientWidth / 2);
		// The line sits a little below the middle, as on a short day, even when busy mornings push it down
		this.scroller.scrollTop = Math.max(0, this.axisY - this.top - (this.scroller.clientHeight - this.top) * 0.56);
	}

	/**
	 * How much of the view's top the floating header and bar cover. The timeline runs up under them (they're
	 * see-through), and the numerals and cards start below them.
	 */
	private measureTop(): void {
		// Only the part of the header that actually lies over the timeline counts: on phones Obsidian draws its
		// own header above the view, so nothing overlaps there
		const header = this.containerEl.querySelector<HTMLElement>('.view-header');
		const overlap = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom - this.contentEl.getBoundingClientRect().top)) : 0;
		this.bar.style.top = `${overlap}px`;
		this.top = overlap + this.bar.offsetHeight;
		this.contentEl.style.setProperty('--jeong-timeline-top', `${this.top}px`);
	}

	/** Zooms the year in or out, keeping the day under `anchor` (pixels from the view's left edge) in place. */
	private setZoom(zoom: number, anchor = this.scroller.clientWidth / 2): void {
		const at = (this.scroller.scrollLeft + anchor) / this.track.clientWidth;
		this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
		window.cancelAnimationFrame(this.zoomFrame);
		this.zoomFrame = window.requestAnimationFrame(() => {
			this.render();
			this.scroller.scrollLeft = at * this.track.clientWidth - anchor;
		});
	}

	/** The day after the period shown. */
	private end(): moment.Moment {
		return this.start.clone().add(1, this.scale);
	}

	/** How many days the period shown has. */
	private days(): number {
		return this.end().diff(this.start, 'days');
	}

	/** Days (with fractions for the time of day) from the start of the period shown. */
	private offset(date: moment.Moment): number {
		return date.diff(this.start, 'days', true);
	}

	/**
	 * Where an entry stands on the line: in a day, at its time; in a week, just inside its day's column so
	 * its cards stand within it; otherwise, the middle of its day.
	 */
	private dayX(entry: EntryInfo): number {
		if (this.scale === 'day') return this.x(this.offset(moment(`${entry.date} ${timeOf(entry)}`)));
		const day = this.offset(moment(entry.date));
		return this.scale === 'week' ? this.x(day) + this.layout.stemOffset + this.layout.gap : this.x(day + 0.5);
	}

	/** Pixels from the left edge for a number of days into the period. */
	private x(days: number): number {
		return 40 + (days / this.days()) * (this.track.clientWidth - 80);
	}

	/** The date at a number of pixels from the left edge. */
	private dateAt(x: number): moment.Moment {
		const days = ((x - 40) / Math.max(1, this.track.clientWidth - 80)) * this.days();
		return this.start.clone().add(Math.min(this.days() - 1, Math.max(0, Math.floor(days))), 'days');
	}

	/** The period's name in the bar: 2026, October 2026, Oct 25 – 31, or Tuesday, Oct 27. */
	private periodLabel(): string {
		if (this.scale === 'year') return this.start.format('YYYY');
		if (this.scale === 'month') return this.start.format(Platform.isMobile ? 'MMM YYYY' : 'MMMM YYYY');
		if (this.scale === 'day') return this.start.format(Platform.isMobile ? 'ddd, MMM D' : 'dddd, MMM D');
		const last = this.end().subtract(1, 'day');
		return `${this.start.format('MMM D')} – ${last.format(last.month() === this.start.month() ? 'D' : 'MMM D')}`;
	}

	/**
	 * Tapping the period's name opens the device's own picker for that kind of period: a list of years, a month
	 * calendar, or a date calendar (for a week, any day in it). It sits invisibly over the name.
	 */
	private buildPeriodPicker(): void {
		const slot = this.periodPicker;
		slot.empty();
		if (this.scale === 'year') {
			const select = slot.createEl('select', { attr: { 'aria-label': t('timeline.pickYear') } });
			const now = moment().year();
			const first = Math.min(this.start.year(), ...listEntries(this.app, this.plugin.settings.journalFolder).map((e) => Number(e.date.slice(0, 4))), now);
			for (let year = Math.max(this.start.year(), now) + 1; year >= first; year--) select.createEl('option', { text: String(year), attr: { value: String(year) } });
			select.value = String(this.start.year());
			select.addEventListener('change', () => this.showPeriod(moment({ year: Number(select.value) })));
			return;
		}
		const month = this.scale === 'month';
		const input = slot.createEl('input', { type: month ? 'month' : 'date', attr: { 'aria-label': t(month ? 'timeline.pickMonth' : 'timeline.pickDay') } });
		input.value = this.start.format(month ? 'YYYY-MM' : 'YYYY-MM-DD');
		// A click on the name opens the calendar (a hidden date field otherwise only opens from its own icon)
		input.addEventListener('click', () => {
			try {
				input.showPicker();
			} catch {
				// Older browsers open it themselves
			}
		});
		input.addEventListener('change', () => {
			if (!input.value) return;
			const picked = moment(month ? `${input.value}-01` : input.value);
			this.showPeriod(picked, picked);
		});
	}

	private render(): void {
		const from = this.start.format('YYYY-MM-DD');
		const to = this.end().format('YYYY-MM-DD');
		const entries = listEntries(this.app, this.plugin.settings.journalFolder).filter((e) => e.date >= from && e.date < to);
		this.yearLabel.setText(this.periodLabel());
		this.yearLabel.toggleClass('is-long', this.scale !== 'year');
		this.scalePicker.value = this.scale;
		this.buildPeriodPicker();
		this.track.empty();
		this.layout = this.measureLayout();
		const width =
			this.scale === 'year'
				? Math.max(this.scroller.clientWidth * 2.2, 1800)
				: Math.max(this.scroller.clientWidth, this.days() * DAY_WIDTH[this.scale] * this.layout.cardWidth + 80);
		this.track.style.width = `${width * this.zoom}px`;

		// The day, top to bottom, brightest at the line: the page darkens toward the top and down to a walnut
		// night with stars, and the sky ruler down the left edge runs midnight to midnight, with noon at the line
		this.track.createDiv({ cls: 'jeong-timeline-sky' });
		// Stars at night: at the bottom, behind everything, and a fainter few at the top, over the blur under the
		// dates, where behind it they'd blur away to nothing
		for (const cls of ['jeong-timeline-stars', 'jeong-timeline-stars is-top']) {
			const stars = this.track.createDiv({ cls });
			for (let i = 0; i < 3; i++) stars.createDiv({ cls: 'jeong-timeline-twinkle' });
		}

		// Columns with huge numerals: the months of a year, the days of a month or week, or the hours of a day.
		// A numeral takes you one step closer: a month to that month, a day to its week, or a week's day to that day.
		const unit = COLUMN[this.scale];
		const today = moment().startOf('day');
		for (let day = this.start.clone(); day.isBefore(this.end()); day.add(1, unit)) {
			const left = this.x(this.offset(day));
			const right = this.x(this.offset(day.clone().add(1, unit)));
			const column = this.track.createDiv({ cls: `jeong-timeline-month${unit === 'day' ? ' is-day' : ''}` });
			column.style.left = `${left}px`;
			column.style.width = `${right - left}px`;
			column.style.setProperty('--jeong-month-width', `${right - left}px`);
			if (unit === 'day' && day.isSame(today)) column.addClass('is-today');
			// The numeral and its name stay at the top together while a busy stretch scrolls up and down
			const head = column.createDiv({ cls: 'jeong-timeline-month-head' });
			const numeral = head.createEl('b', { text: day.format(unit === 'month' ? 'MM' : unit === 'day' ? 'D' : 'h') });
			head.createEl('small', { text: day.format(unit === 'month' ? 'MMMM' : unit === 'hour' ? 'A' : this.scale === 'week' ? 'dddd' : 'ddd') });
			const closer = CLOSER[this.scale];
			if (closer) {
				const at = day.clone();
				numeral.addClass('is-link');
				numeral.setAttribute('role', 'button');
				numeral.setAttribute('aria-label', unit === 'month' ? at.format('MMMM YYYY') : at.format('LL'));
				numeral.addEventListener('click', () => {
					if (!this.dragging.moved) this.setScale(closer, at);
				});
			}
		}

		// Cards scrolling up under the dates go blurry beneath them, more and more, in layers; full blur reaches the bottom of the dates
		const veil = createDiv({ cls: 'jeong-timeline-veil' });
		for (let i = 0; i < 6; i++) veil.createDiv({ cls: 'jeong-timeline-veil-layer' });
		this.track.prepend(veil);

		const axis = this.track.createDiv({ cls: 'jeong-timeline-axis' });

		// Now: a red line at today, at this hour
		const now = moment();
		if (!now.isBefore(this.start) && now.isBefore(this.end())) {
			const line = this.track.createDiv({ cls: 'jeong-timeline-now' });
			line.style.left = `${this.x(this.offset(now))}px`;
			line.createSpan({ text: `${t('timeline.today')} · ${now.format('ll')}` });
		}

		// Entries as small cards standing on the line, each with a stem to its day.
		// Keep the newest 8 entries of each day; older ones fold into "+N".
		const shown: EntryInfo[] = [];
		const perDay = new Map<number, number>();
		const hidden = new Map<number, EntryInfo[]>();
		for (const entry of [...entries].reverse()) {
			const day = Math.round(this.dayX(entry));
			const count = perDay.get(day) ?? 0;
			if (count < MAX_CARDS_PER_DAY) {
				perDay.set(day, count + 1);
				shown.push(entry);
			} else hidden.set(day, [...(hidden.get(day) ?? []), entry]);
		}

		// Mornings above the line, afternoons and evenings below, so each day reads top to bottom like a clock:
		// the earliest morning at the top, noon at the line, the latest night at the bottom. Cards stack as far
		// up or down as a busy day needs (the timeline scrolls both ways).
		const morning = shown.filter((e) => timeOf(e) < '12:00').sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
		const afternoon = shown.filter((e) => timeOf(e) >= '12:00').sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
		const above = stack(morning, (e) => this.dayX(e), this.layout);
		const below = stack(afternoon, (e) => this.dayX(e), this.layout);
		const reach = (cards: StackedCard[]) => Math.max(0, ...cards.map((card) => card.offset + card.height));

		this.measureTop();
		// Where the dates end, for the band under them (on the track, so the faint stars at the top fade out
		// just below it too); cards at rest stand clear of the band, which fades out a little further down
		const head = this.track.querySelector<HTMLElement>('.jeong-timeline-month-head');
		const datesBottom = head ? Math.round(head.getBoundingClientRect().bottom - this.scroller.getBoundingClientRect().top) : this.top + NUMERALS_HEIGHT;
		this.track.setCssProps({ '--jeong-veil': `${datesBottom}px` });
		const clear = datesBottom + this.cssLength('--jeong-veil-fade');
		const height = Math.max(this.scroller.clientHeight, this.top + MIN_HEIGHT);
		const axisY = Math.max(this.top + Math.round((height - this.top) * 0.56), clear + this.layout.stem + reach(above));
		this.axisY = axisY;
		axis.style.top = `${axisY}px`;
		this.track.style.setProperty('--jeong-axis', `${axisY}px`);

		for (const { entry, x, offset, height: cardHeight, isAbove } of [...above.map((c) => ({ ...c, isAbove: true })), ...below.map((c) => ({ ...c, isAbove: false }))]) {
			const top = isAbove ? axisY - this.layout.stem - offset - cardHeight : axisY + this.layout.stem + offset;

			const stem = this.track.createDiv({ cls: 'jeong-timeline-stem' });
			stem.style.left = `${x}px`;
			stem.style.top = `${isAbove ? top + cardHeight : axisY}px`;
			stem.style.height = `${isAbove ? axisY - top - cardHeight : top - axisY}px`;
			const dot = this.track.createDiv({ cls: 'jeong-timeline-dot' });
			dot.style.left = `${x}px`;
			dot.style.top = `${axisY}px`;

			this.entryCard(entry, x - this.layout.stemOffset, top, cardHeight);
		}

		// Days with more entries than fit get a small "+N"
		for (const [x, folded] of hidden) {
			const more = this.track.createEl('button', { cls: 'jeong-timeline-more', text: `+${folded.length}`, attr: { 'aria-label': t('timeline.moreEntries') } });
			more.style.left = `${x}px`;
			more.style.top = `${axisY}px`;
			more.addEventListener('click', () => this.showList(folded));
		}

		// Tall enough for the lowest card, with room under it for the Record button (and, on phones, Obsidian's toolbar)
		this.track.style.height = `${Math.max(height, axisY + this.layout.stem + reach(below) + (Platform.isMobile ? 200 : 96))}px`;

		if (!entries.length) {
			this.track.createDiv({ cls: 'jeong-timeline-empty', text: t('timeline.empty') });
			this.preview.hide();
		}
	}

	/** How much bigger or smaller cards are drawn at this zoom. */
	private get cardScale(): number {
		return Math.min(CARD_SCALE.max, Math.max(CARD_SCALE.min, this.zoom ** CARD_SCALE.power));
	}

	/** A length token from styles.css, in pixels, at this pane's width. */
	private cssLength(token: string): number {
		const ruler = this.track.createDiv({ cls: 'jeong-timeline-probe' });
		ruler.setCssProps({ width: `var(${token})` });
		const width = ruler.getBoundingClientRect().width;
		ruler.remove();
		return width;
	}

	/** Measures a sample card and the card tokens in styles.css, at this pane's width, for laying out cards. */
	private measureLayout(): Layout {
		const probe = this.track.createDiv({ cls: 'jeong-timeline-entry jeong-timeline-probe' });
		const text = probe.createDiv({ cls: 'jeong-timeline-entry-text' });
		text.createDiv({ cls: 'jeong-timeline-entry-meta', text: 'Oct 27 · 12:00 AM' });
		text.createDiv({ cls: 'jeong-timeline-entry-title', text: 'Title' });
		// Long enough to fill both of the summary's lines on any card
		text.createDiv({ cls: 'jeong-timeline-entry-snippet', text: 'A summary that runs on and on. '.repeat(12) });
		const card = probe.getBoundingClientRect();
		const size = (token: string) => this.cssLength(token);
		const scale = this.cardScale;
		const layout = {
			cardWidth: card.width * scale,
			cardHeight: Math.ceil(card.height) * scale,
			photoHeight: size('--jeong-card-photo') * scale,
			gap: size('--jeong-card-gap') * scale,
			stem: size('--jeong-card-stem') * scale,
			stemOffset: size('--jeong-card-stem-offset') * scale,
		};
		probe.remove();
		return layout;
	}

	/** A small card: main photo, date and time, title, and a short snippet. */
	private entryCard(entry: EntryInfo, left: number, top: number, height: number): void {
		// No aria-label: Obsidian turns those into tooltips, which would cover the card below. Screen readers read the card's text.
		const card = this.track.createDiv({ cls: 'jeong-timeline-entry', attr: { role: 'button', tabindex: '0', 'data-path': entry.file.path } });
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		// Laid out at its zoomed size, drawn at its own size and scaled up or down to that
		const scale = this.cardScale;
		card.style.width = `${this.layout.cardWidth / scale}px`;
		card.style.height = `${height / scale}px`;
		card.style.setProperty('--jeong-card-scale', String(scale));
		if (entry.status === 'recorded') card.addClass('is-waiting');
		if (entry.file.path === this.selected) card.addClass('is-selected');

		const text = card.createDiv({ cls: 'jeong-timeline-entry-text' });
		text.createDiv({ cls: 'jeong-timeline-entry-meta', text: moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'MMM D · LT' : 'MMM D') });
		text.createDiv({ cls: 'jeong-timeline-entry-title', text: entry.title });
		const snippet = text.createDiv({ cls: 'jeong-timeline-entry-snippet' });
		if (entry.status === 'recorded') snippet.setText(t('timeline.waiting'));
		else if (entry.summary) snippet.setText(entry.summary);
		else void this.excerpt(entry).then((excerpt) => snippet.setText(excerpt));
		// The pictures, large, under the summary: the painting first, then the photos, taking turns
		if (entry.painting || entry.photos.length) {
			const pictures = card.createDiv({ cls: 'jeong-timeline-entry-photo' });
			// Each card turns at a slightly different moment, so they don't all change at once
			pictures.style.setProperty('--jeong-turn-delay', `${(Math.random() * 1.4).toFixed(2)}s`);
			if (entry.painting) {
				const src = this.app.vault.getResourcePath(entry.painting);
				// One just finished is brushed onto the card
				if (this.plugin.painter.takeFresh(entry.file)) {
					brushReveal(pictures, src);
					pictures.lastElementChild?.addClass('is-shown', 'jeong-painting');
				} else pictures.createEl('img', { cls: 'is-shown jeong-painting', attr: { src, alt: '' } });
			}
			entry.photos.forEach((photo, i) =>
				pictures.createEl('img', { cls: i === 0 && !entry.painting ? 'is-shown' : '', attr: { src: this.app.vault.getResourcePath(photo), alt: '' } }),
			);
		}
		// A brush to illustrate the entry (on a computer, where the painting model runs)
		if (this.canIllustrate(entry)) this.brushButton(card, entry);

		// Mouse: hover for a larger preview, click to open. Touch: tap for the preview.
		card.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') this.hoverPreview(entry);
		});
		// Still moving means passing over; the wait starts again until the pointer settles
		card.addEventListener('pointermove', (e) => {
			if (e.pointerType === 'mouse' && !this.preview.isShown()) this.hoverPreview(entry);
		});
		card.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') this.scheduleHide();
		});
		card.addEventListener('click', (e) => {
			if (this.dragging.moved) return;
			if (e.pointerType === 'mouse' || e.detail === 0) this.readStory(entry);
			else void this.showPreview(entry);
		});
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.readStory(entry);
		});
	}

	/** Any written entry can be illustrated, with or without photos; only on a computer. */
	private canIllustrate(entry: EntryInfo): boolean {
		return entry.status !== 'recorded' && !Platform.isMobile;
	}

	/** Paints a picture for the entry; when it's done, an open preview of it shows the painting. */
	private illustrate(entry: EntryInfo): void {
		if (this.plugin.painter.isPainting(entry.file)) return;
		void this.plugin.painter
			.paint(entry.file, (progress) => {
				if (progress === 'not-ready' || progress === 'failed') new Notice(paintMessage(progress));
			})
			.then((done) => {
				if (!done || this.selected !== entry.file.path || !this.preview.isShown()) return;
				const updated = listEntries(this.app, this.plugin.settings.journalFolder).find((e) => e.file === entry.file);
				if (updated) void this.showPreview(updated);
			});
	}

	/** The brush in the corner of a card: illustrates the entry, or illustrates it again. */
	private brushButton(card: HTMLElement, entry: EntryInfo): void {
		const painting = this.plugin.painter.isPainting(entry.file);
		const brush = card.createEl('button', {
			cls: `jeong-timeline-brush${painting ? ' is-painting' : ''}`,
			attr: { 'aria-label': painting ? t('paint.painting') : t(entry.painting ? 'paint.again' : 'paint.button') },
		});
		setIcon(brush, 'paintbrush');
		if (painting) {
			card.addClass('is-painting');
			// A faint brush rides the wash of ink across the card while it paints
			const rider = card.createDiv({ cls: 'jeong-brush-rider', attr: { 'aria-hidden': 'true' } });
			setIcon(rider.createSpan({ cls: 'jeong-brush-rider-icon' }), 'jeong-brush');
		}
		brush.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!this.dragging.moved) this.illustrate(entry);
		});
	}

	private hoverPreview(entry: EntryInfo): void {
		window.clearTimeout(this.hideTimer);
		window.clearTimeout(this.showTimer);
		this.showTimer = window.setTimeout(() => void this.showPreview(entry), PREVIEW_REST_MS);
	}

	private scheduleHide(): void {
		window.clearTimeout(this.showTimer);
		this.hideTimer = window.setTimeout(() => void leave(this.preview), 350);
	}

	/** A short list of entries that didn't fit on the timeline; pick one to preview it. */
	private showList(entries: EntryInfo[]): void {
		const card = this.preview;
		card.empty();
		arrive(card);
		card.createDiv({ cls: 'jeong-timeline-card-meta', text: t('timeline.moreEntries') });
		for (const entry of entries) {
			const item = card.createEl('button', { cls: 'jeong-timeline-list-item' });
			item.createSpan({ cls: 'jeong-timeline-entry-meta', text: moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'MMM D · LT' : 'MMM D') });
			item.createSpan({ cls: 'jeong-timeline-entry-title', text: entry.title });
			item.addEventListener('click', () => void this.showPreview(entry));
		}
	}

	/** Opens the entry's story to read, with its picture; from there, its note or raw transcript open in Obsidian. */
	private readStory(entry: EntryInfo): void {
		new StoryModal(this.app, entry, this.plugin.settings.paintInk, (mode) => this.plugin.openRecorder({ note: entry.file, mode })).open();
	}

	/** The larger preview: the painting or first photo, the strip of other photos, the full summary, Open entry, and Illustrate. */
	private async showPreview(entry: EntryInfo): Promise<void> {
		this.selected = entry.file.path;
		this.track.querySelectorAll('.jeong-timeline-entry.is-selected').forEach((el) => el.removeClass('is-selected'));
		this.track.querySelector(`[data-path="${CSS.escape(entry.file.path)}"]`)?.addClass('is-selected');
		const card = this.preview;
		card.empty();
		arrive(card);
		const meta = [moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'LLLL' : 'LL'), entry.duration]
			.filter(Boolean)
			.join(' · ');
		// The painting leads; the photos follow in the strip
		const rest = entry.painting ? entry.photos : entry.photos.slice(1);
		const main = entry.painting ?? entry.photos[0];
		if (main) {
			card.createEl('img', {
				cls: `jeong-timeline-card-photo${entry.painting ? ' jeong-painting' : ''}`,
				attr: { src: this.app.vault.getResourcePath(main), alt: '' },
			});
		}
		if (rest.length) {
			const strip = card.createDiv({ cls: 'jeong-timeline-card-strip' });
			for (const photo of rest.slice(0, 4)) strip.createEl('img', { attr: { src: this.app.vault.getResourcePath(photo), alt: '' } });
			if (rest.length > 4) strip.createSpan({ cls: 'jeong-timeline-card-more', text: `+${rest.length - 4}` });
		}
		card.createDiv({ cls: 'jeong-timeline-card-meta', text: meta });
		card.createEl('h2', { text: entry.title });
		const excerpt = entry.status === 'recorded' ? t('timeline.waiting') : entry.summary || (await this.excerpt(entry));
		if (excerpt) card.createEl('p', { text: excerpt });
		const actions = card.createDiv({ cls: 'jeong-timeline-card-actions' });
		openButtonPill(actions, () => this.readStory(entry), t('story.read'));
		if (this.canIllustrate(entry)) this.illustrateButton(actions, entry);
	}

	/** Illustrate, beside Open entry in the preview. */
	private illustrateButton(parent: HTMLElement, entry: EntryInfo): void {
		const painting = this.plugin.painter.isPainting(entry.file);
		const button = parent.createEl('button', { cls: `jeong-open-button is-pill jeong-illustrate-button${painting ? ' is-painting' : ''}` });
		setIcon(button.createSpan({ cls: 'jeong-open-button-icon' }), 'paintbrush');
		const label = button.createSpan({ text: t(painting ? 'paint.painting' : entry.painting ? 'paint.illustrateAgain' : 'paint.illustrate') });
		button.disabled = painting;
		button.addEventListener('click', () => {
			button.disabled = true;
			button.addClass('is-painting');
			label.setText(t('paint.painting'));
			this.illustrate(entry);
		});
	}

	/** The first couple of sentences of the entry, without frontmatter, labels, links line, or embeds. */
	private async excerpt(entry: EntryInfo): Promise<string> {
		const body = storyText(await this.app.vault.cachedRead(entry.file));
		return body.length > 280 ? `${body.slice(0, 280).trimEnd()}…` : body;
	}

	/** Entries with several photos cross-fade to the next one every few seconds (not when motion is reduced). */
	private cyclePhotos(): void {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const turn = window.setInterval(() => {
			this.track.querySelectorAll('.jeong-timeline-entry-photo').forEach((photos) => {
				const images = Array.from(photos.children);
				if (images.length < 2) return;
				const shown = images.findIndex((image) => image.hasClass('is-shown'));
				images[shown]?.removeClass('is-shown');
				images[(shown + 1) % images.length]?.addClass('is-shown');
			});
		}, PHOTO_TURN_MS);
		this.register(() => window.clearInterval(turn));
	}

	// Drag to move through the year (and up and down a busy stretch); the mouse wheel scrolls sideways
	private enablePanning(): void {
		this.registerDomEvent(this.scroller, 'pointerdown', (e: PointerEvent) => {
			if (e.pointerType !== 'mouse') return;
			this.dragging = { active: true, moved: false, x: e.clientX, y: e.clientY, left: this.scroller.scrollLeft, top: this.scroller.scrollTop };
		});
		this.registerDomEvent(window, 'pointermove', (e: PointerEvent) => {
			if (!this.dragging.active) return;
			const dx = e.clientX - this.dragging.x;
			const dy = e.clientY - this.dragging.y;
			if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.dragging.moved = true;
			this.scroller.scrollLeft = this.dragging.left - dx;
			this.scroller.scrollTop = this.dragging.top - dy;
		});
		this.registerDomEvent(window, 'pointerup', () => {
			this.dragging.active = false;
			window.setTimeout(() => (this.dragging.moved = false), 0);
		});
		this.registerDomEvent(
			this.scroller,
			'wheel',
			(e: WheelEvent) => {
				// Pinch on a trackpad arrives as Ctrl + wheel
				if (e.ctrlKey) {
					e.preventDefault();
					this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - this.scroller.getBoundingClientRect().left);
					return;
				}
				if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
				this.scroller.scrollLeft += e.deltaY;
				e.preventDefault();
			},
			{ passive: false },
		);
	}
}

interface StackedCard {
	entry: EntryInfo;
	x: number;
	/** How far the card sits from the line (past the stem), in pixels. */
	offset: number;
	height: number;
}

/**
 * Stacks cards away from the line in the order given. Each card takes the first gap, nearest the line,
 * that's tall enough for it among the cards it would overlap; cards with photos or a painting are taller.
 */
function stack(entries: EntryInfo[], dayX: (entry: EntryInfo) => number, layout: Layout): StackedCard[] {
	const placed: StackedCard[] = [];
	for (const entry of entries) {
		const x = dayX(entry);
		const height = layout.cardHeight + (entry.photos.length || entry.painting ? layout.photoHeight : 0);
		const inTheWay = placed.filter((card) => Math.abs(card.x - x) < layout.cardWidth + layout.gap).sort((a, b) => a.offset - b.offset);
		let offset = 0;
		for (const card of inTheWay) {
			if (offset + height + layout.gap <= card.offset) break;
			offset = Math.max(offset, card.offset + card.height + layout.gap);
		}
		placed.push({ entry, x, offset, height });
	}
	return placed;
}

/** True when Jeong is showing its dark colors: chosen, or following Obsidian's dark theme. */
function isDark(): boolean {
	const body = document.body;
	return body.hasClass('jeong-theme-dark') || (!body.hasClass('jeong-theme-light') && body.hasClass('theme-dark'));
}

/** An entry's time of day; entries without one count as noon. */
function timeOf(entry: EntryInfo): string {
	return entry.time || '12:00';
}

