import { ItemView, WorkspaceLeaf, debounce, moment, setIcon } from 'obsidian';
import type JeongPlugin from '../main';
import { t } from '../i18n';
import { listEntries, type EntryInfo } from '../journal/entries';
import { setNightSky } from './night-sky';

export const TIMELINE_VIEW = 'jeong-timeline';

// A timeline of the journal, one year at a time, in the style of the printed-chart sketch:
// huge month numerals, entries as small cards standing on one line, and a red line for today.
// Hover a card for a larger preview; click to open the entry. Drag to move around; pinch,
// Ctrl + wheel, or the − and + buttons zoom in and out of the year.

const CARD_WIDTH = 220;
const CARD_HEIGHT = 92;
const PHOTO_HEIGHT = 132; // the main photo, full width under the summary
const CARD_GAP = 10;
const STEM = 18; // the gap between the line and the nearest cards
const STEM_OFFSET = 14; // how far into the card its stem sits
const NUMERALS_HEIGHT = 170;
const MAX_CARDS_PER_DAY = 8; // more than this on one day fold into "+N"
const MIN_HEIGHT = 420; // the numerals plus a row of cards above and below the line
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;

export class TimelineView extends ItemView {
	private year = new Date().getFullYear();
	private selected: string | null = null;
	private scroller!: HTMLElement;
	private track!: HTMLElement;
	private preview!: HTMLElement;
	private showTimer = 0;
	private hideTimer = 0;
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

		const bar = root.createDiv({ cls: 'jeong-timeline-bar' });
		const earlier = bar.createEl('button', { text: `‹ ${t('timeline.earlier')}` });
		this.yearLabel = bar.createDiv({ cls: 'jeong-timeline-year' });
		const later = bar.createEl('button', { text: `${t('timeline.later')} ›` });
		const zoom = bar.createDiv({ cls: 'jeong-timeline-zoom' });
		const zoomOut = zoom.createEl('button', { attr: { 'aria-label': t('timeline.zoomOut') } });
		const zoomIn = zoom.createEl('button', { attr: { 'aria-label': t('timeline.zoomIn') } });
		setIcon(zoomOut, 'minus');
		setIcon(zoomIn, 'plus');
		const today = bar.createEl('button', { cls: 'jeong-timeline-today', text: t('timeline.today') });
		zoomOut.addEventListener('click', () => this.setZoom(this.zoom / 1.6));
		zoomIn.addEventListener('click', () => this.setZoom(this.zoom * 1.6));
		earlier.addEventListener('click', () => this.showYear(this.year - 1));
		later.addEventListener('click', () => this.showYear(this.year + 1));
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

		// Redraw when entries change
		this.registerEvent(this.app.metadataCache.on('changed', this.refresh));
		this.registerEvent(this.app.vault.on('delete', this.refresh));
		this.registerEvent(this.app.vault.on('rename', this.refresh));

		this.goToToday();
	}

	// Redraw when the pane changes size, including when it first gets one (a new pane can open at 0 height)
	onResize(): void {
		if (this.track) this.refresh();
	}

	private refresh = debounce(() => this.redraw(), 300, true);

	/** Shows this year with today in the middle. */
	goToToday(): void {
		this.showYear(new Date().getFullYear(), true);
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

	private showYear(year: number, scrollToToday = false): void {
		this.year = year;
		this.render();
		const now = new Date();
		const target = scrollToToday && year === now.getFullYear() ? this.x(dayOfYear(now)) : 0;
		this.scroller.scrollLeft = Math.max(0, target - this.scroller.clientWidth / 2);
		// The line sits a little below the middle, as on a short day, even when busy mornings push it down
		this.scroller.scrollTop = Math.max(0, this.axisY - this.scroller.clientHeight * 0.56);
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

	/** Where an entry's day is on the line. */
	private dayX(entry: EntryInfo): number {
		return this.x(dayOfYear(new Date(`${entry.date}T12:00`)));
	}

	/** Pixels from the left edge for a day of the year. */
	private x(day: number): number {
		return 40 + (day / daysIn(this.year)) * (this.track.clientWidth - 80);
	}

	private render(): void {
		const entries = listEntries(this.app, this.plugin.settings.journalFolder).filter((e) => e.date.startsWith(`${this.year}-`));
		this.yearLabel.setText(String(this.year));
		this.track.empty();
		this.track.style.width = `${Math.max(this.scroller.clientWidth * 2.2, 1800) * this.zoom}px`;

		// The day, top to bottom: the page goes from cream mornings to a walnut night with stars,
		// and the sky ruler down the left edge runs from dawn to night, with noon at the line
		this.track.createDiv({ cls: 'jeong-timeline-sky' });
		const stars = this.track.createDiv({ cls: 'jeong-timeline-stars' });
		for (let i = 0; i < 3; i++) stars.createDiv({ cls: 'jeong-timeline-twinkle' });

		// Month columns with huge numerals
		for (let m = 0; m < 12; m++) {
			const start = dayOfYear(new Date(this.year, m, 1));
			const end = m === 11 ? daysIn(this.year) : dayOfYear(new Date(this.year, m + 1, 1));
			const month = this.track.createDiv({ cls: 'jeong-timeline-month' });
			month.style.left = `${this.x(start)}px`;
			month.style.width = `${this.x(end) - this.x(start)}px`;
			month.style.setProperty('--jeong-month-width', `${this.x(end) - this.x(start)}px`);
			month.createEl('b', { text: String(m + 1).padStart(2, '0') });
			month.createEl('small', { text: moment().month(m).format('MMMM') });
		}

		const axis = this.track.createDiv({ cls: 'jeong-timeline-axis' });

		// Today
		const now = new Date();
		if (now.getFullYear() === this.year) {
			const line = this.track.createDiv({ cls: 'jeong-timeline-now' });
			line.style.left = `${this.x(dayOfYear(now))}px`;
			line.createSpan({ text: `${t('timeline.today')} · ${moment(now).format('ll')}` });
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

		const height = Math.max(this.scroller.clientHeight, MIN_HEIGHT);
		const axisY = Math.max(Math.round(height * 0.56), NUMERALS_HEIGHT + STEM + reach(above));
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

		// Tall enough for the lowest card, with room under it for the Record button
		this.track.style.height = `${Math.max(height, axisY + STEM + reach(below) + 96)}px`;

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
		// The main photo, large, under the summary
		const main = entry.photos[0];
		if (main) card.createEl('img', { cls: 'jeong-timeline-entry-photo', attr: { src: this.app.vault.getResourcePath(main), alt: '' } });

		// Mouse: hover for a larger preview, click to open. Touch: tap for the preview.
		card.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') this.hoverPreview(entry);
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

	private hoverPreview(entry: EntryInfo): void {
		window.clearTimeout(this.hideTimer);
		window.clearTimeout(this.showTimer);
		this.showTimer = window.setTimeout(() => void this.showPreview(entry), 180);
	}

	private scheduleHide(): void {
		window.clearTimeout(this.showTimer);
		this.hideTimer = window.setTimeout(() => this.preview.hide(), 350);
	}

	/** A short list of entries that didn't fit on the timeline; pick one to preview it. */
	private showList(entries: EntryInfo[]): void {
		const card = this.preview;
		card.empty();
		card.show();
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

	/** The larger preview: bigger photo, the strip of others, the full summary, and Open entry. */
	private async showPreview(entry: EntryInfo): Promise<void> {
		this.selected = entry.file.path;
		this.track.querySelectorAll('.jeong-timeline-entry.is-selected').forEach((el) => el.removeClass('is-selected'));
		this.track.querySelector(`[data-path="${CSS.escape(entry.file.path)}"]`)?.addClass('is-selected');
		const card = this.preview;
		card.empty();
		card.show();
		const meta = [moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'LLLL' : 'LL'), entry.duration]
			.filter(Boolean)
			.join(' · ');
		if (entry.photos.length) {
			const [main, ...rest] = entry.photos;
			if (main) card.createEl('img', { cls: 'jeong-timeline-card-photo', attr: { src: this.app.vault.getResourcePath(main), alt: '' } });
			if (rest.length) {
				const strip = card.createDiv({ cls: 'jeong-timeline-card-strip' });
				for (const photo of rest.slice(0, 4)) strip.createEl('img', { attr: { src: this.app.vault.getResourcePath(photo), alt: '' } });
				if (rest.length > 4) strip.createSpan({ cls: 'jeong-timeline-card-more', text: `+${rest.length - 4}` });
			}
		}
		card.createDiv({ cls: 'jeong-timeline-card-meta', text: meta });
		card.createEl('h2', { text: entry.title });
		const excerpt = entry.status === 'recorded' ? t('timeline.waiting') : entry.summary || (await this.excerpt(entry));
		if (excerpt) card.createEl('p', { text: excerpt });
		const open = card.createEl('button', { cls: 'jeong-button-primary', text: t('record.openEntry') });
		open.addEventListener('click', () => void this.openEntry(entry));
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
 * that's tall enough for it among the cards it would overlap; cards with photos are taller.
 */
function stack(entries: EntryInfo[], dayX: (entry: EntryInfo) => number): StackedCard[] {
	const placed: StackedCard[] = [];
	for (const entry of entries) {
		const x = dayX(entry);
		const height = CARD_HEIGHT + (entry.photos.length ? PHOTO_HEIGHT : 0);
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

function dayOfYear(date: Date): number {
	return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86_400_000;
}

function daysIn(year: number): number {
	return dayOfYear(new Date(year, 11, 31)) + 1;
}
