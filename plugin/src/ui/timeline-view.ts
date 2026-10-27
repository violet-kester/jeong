import { ItemView, Notice, Platform, WorkspaceLeaf, debounce, moment, setIcon } from 'obsidian';
import type JeongPlugin from '../main';
import { t } from '../i18n';
import { listEntries, type EntryInfo } from '../journal/entries';
import { setNightSky } from './night-sky';
import { arrive, leave } from './motion';
import { openButtonPill } from './open-button';
import { paintMessage } from './story-messages';
import { brushReveal } from '../paint/brush-reveal';
import { applyInk } from '../paint/ink';

export const TIMELINE_VIEW = 'jeong-timeline';

// A timeline of the journal, a year, a month, a week, or a day at a time, in the style of the printed-chart
// sketch: huge numerals (months in a year, days in a month or week, hours in a day), entries as small cards
// standing on one line, and a red line for now. Hover a card for a larger preview; click to open the entry.
// Drag to move around; pinch, Ctrl + wheel, or the − and + buttons stretch the period out or squeeze it in.
// A numeral takes you one step closer: a month to that month, a day to its week, a day in a week to that day.

const CARD_WIDTH = 220;
const CARD_HEIGHT = 92;
const PHOTO_HEIGHT = 132; // the main photo (or painting), full width under the summary
const CARD_GAP = 10;
const STEM = 18; // the gap between the line and the nearest cards
const STEM_OFFSET = 14; // how far into the card its stem sits
const NUMERALS_HEIGHT = 170;
const PHOTO_TURN_MS = 4000; // how long each picture shows before the next one fades in
const MAX_CARDS_PER_DAY = 8; // more than this on one day fold into "+N"
const MIN_HEIGHT = 420; // the numerals plus a row of cards above and below the line
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;
/** How wide a day is at least, in month, week, and day views, so cards have room to stand side by side. */
const DAY_WIDTH: Record<Scale, number> = { year: 0, month: 90, week: CARD_WIDTH + 40, day: 24 * 110 };
const PREVIEW_REST_MS = 600; // the pointer rests this long on a card before its preview shows, so passing over doesn't flash it

type Scale = 'year' | 'month' | 'week' | 'day';
const SCALES: Scale[] = ['year', 'month', 'week', 'day'];
/** What each view's columns are, and where its numerals take you. */
const COLUMN: Record<Scale, 'month' | 'day' | 'hour'> = { year: 'month', month: 'day', week: 'day', day: 'hour' };
const CLOSER: Record<Scale, Scale | null> = { year: 'month', month: 'week', week: 'day', day: null };

export class TimelineView extends ItemView {
	private scale: Scale = 'year';
	/** The first day of the year, month, or week shown. */
	private start = moment().startOf('year');
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
		// The paper behind a painting is the card's color, which changes with the theme
		this.registerEvent(this.app.workspace.on('css-change', () => this.applyInk()));
		this.applyInk();

		this.goToToday();
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
		return this.scale === 'week' ? this.x(day) + STEM_OFFSET + CARD_GAP : this.x(day + 0.5);
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
		const width = this.scale === 'year' ? Math.max(this.scroller.clientWidth * 2.2, 1800) : Math.max(this.scroller.clientWidth, this.days() * DAY_WIDTH[this.scale] + 80);
		this.track.style.width = `${width * this.zoom}px`;

		// The day, top to bottom: the page goes from cream mornings to a walnut night with stars,
		// and the sky ruler down the left edge runs from dawn to night, with noon at the line
		this.track.createDiv({ cls: 'jeong-timeline-sky' });
		const stars = this.track.createDiv({ cls: 'jeong-timeline-stars' });
		for (let i = 0; i < 3; i++) stars.createDiv({ cls: 'jeong-timeline-twinkle' });

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
			const numeral = column.createEl('b', { text: day.format(unit === 'month' ? 'MM' : unit === 'day' ? 'D' : 'h') });
			column.createEl('small', { text: day.format(unit === 'month' ? 'MMMM' : unit === 'hour' ? 'A' : this.scale === 'week' ? 'dddd' : 'ddd') });
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
		const above = stack(morning, (e) => this.dayX(e));
		const below = stack(afternoon, (e) => this.dayX(e));
		const reach = (cards: StackedCard[]) => Math.max(0, ...cards.map((card) => card.offset + card.height));

		this.measureTop();
		const height = Math.max(this.scroller.clientHeight, this.top + MIN_HEIGHT);
		const axisY = Math.max(this.top + Math.round((height - this.top) * 0.56), this.top + NUMERALS_HEIGHT + STEM + reach(above));
		this.axisY = axisY;
		axis.style.top = `${axisY}px`;
		this.track.style.setProperty('--jeong-axis', `${axisY}px`);

		for (const { entry, x, offset, height: cardHeight, isAbove } of [...above.map((c) => ({ ...c, isAbove: true })), ...below.map((c) => ({ ...c, isAbove: false }))]) {
			const top = isAbove ? axisY - STEM - offset - cardHeight : axisY + STEM + offset;

			const stem = this.track.createDiv({ cls: 'jeong-timeline-stem' });
			stem.style.left = `${x}px`;
			stem.style.top = `${isAbove ? top + cardHeight : axisY}px`;
			stem.style.height = `${isAbove ? axisY - top - cardHeight : top - axisY}px`;
			const dot = this.track.createDiv({ cls: 'jeong-timeline-dot' });
			dot.style.left = `${x}px`;
			dot.style.top = `${axisY}px`;

			this.entryCard(entry, x - STEM_OFFSET, top, cardHeight);
		}

		// Days with more entries than fit get a small "+N"
		for (const [x, folded] of hidden) {
			const more = this.track.createEl('button', { cls: 'jeong-timeline-more', text: `+${folded.length}`, attr: { 'aria-label': t('timeline.moreEntries') } });
			more.style.left = `${x}px`;
			more.style.top = `${axisY}px`;
			more.addEventListener('click', () => this.showList(folded));
		}

		// Tall enough for the lowest card, with room under it for the Record button (and, on phones, Obsidian's toolbar)
		this.track.style.height = `${Math.max(height, axisY + STEM + reach(below) + (Platform.isMobile ? 200 : 96))}px`;

		if (!entries.length) {
			this.track.createDiv({ cls: 'jeong-timeline-empty', text: t('timeline.empty') });
			this.preview.hide();
		}
	}

	/** A small card: main photo, date and time, title, and a short snippet. */
	private entryCard(entry: EntryInfo, left: number, top: number, height: number): void {
		// No aria-label: Obsidian turns those into tooltips, which would cover the card below. Screen readers read the card's text.
		const card = this.track.createDiv({ cls: 'jeong-timeline-entry', attr: { role: 'button', tabindex: '0', 'data-path': entry.file.path } });
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
		card.style.width = `${CARD_WIDTH}px`;
		card.style.height = `${height}px`;
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
			if (e.pointerType === 'mouse' || e.detail === 0) void this.openEntry(entry);
			else void this.showPreview(entry);
		});
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void this.openEntry(entry);
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
		if (painting) card.addClass('is-painting');
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

	/** Opens the entry's note. (Not `open`: that name belongs to Obsidian's views, which call it to show the tab.) */
	private async openEntry(entry: EntryInfo): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(entry.file);
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
		openButtonPill(actions, () => void this.openEntry(entry));
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
		const content = await this.app.vault.cachedRead(entry.file);
		const body = content
			.replace(/^---[\s\S]*?---/, '')
			.replace(/!\[\[[^\]]*\]\]/g, '')
			.replace(/^\*\[\[.*\]\]\*$/gm, '')
			.replace(/^>.*$/gm, '')
			.trim();
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
function stack(entries: EntryInfo[], dayX: (entry: EntryInfo) => number): StackedCard[] {
	const placed: StackedCard[] = [];
	for (const entry of entries) {
		const x = dayX(entry);
		const height = CARD_HEIGHT + (entry.photos.length || entry.painting ? PHOTO_HEIGHT : 0);
		const inTheWay = placed.filter((card) => Math.abs(card.x - x) < CARD_WIDTH + CARD_GAP).sort((a, b) => a.offset - b.offset);
		let offset = 0;
		for (const card of inTheWay) {
			if (offset + height + CARD_GAP <= card.offset) break;
			offset = Math.max(offset, card.offset + card.height + CARD_GAP);
		}
		placed.push({ entry, x, offset, height });
	}
	return placed;
}

/** An entry's time of day; entries without one count as noon. */
function timeOf(entry: EntryInfo): string {
	return entry.time || '12:00';
}

