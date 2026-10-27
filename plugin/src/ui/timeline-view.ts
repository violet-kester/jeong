import { ItemView, WorkspaceLeaf, debounce, moment } from 'obsidian';
import type JeongPlugin from '../main';
import { t } from '../i18n';
import { listEntries, type EntryInfo } from '../journal/entries';

export const TIMELINE_VIEW = 'jeong-timeline';

// A simple timeline of the journal, one year at a time, in the style of the printed-chart
// sketch: huge month numerals, entries as marks along one line, and a red line for today.
// Lanes, eras, photos, and zoom levels come later.
export class TimelineView extends ItemView {
	private year = new Date().getFullYear();
	private selected: string | null = null;
	private scroller!: HTMLElement;
	private track!: HTMLElement;
	private card!: HTMLElement;
	private yearLabel!: HTMLElement;
	private dragging = { active: false, moved: false, x: 0, left: 0 };

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

		const bar = root.createDiv({ cls: 'jeong-timeline-bar' });
		const earlier = bar.createEl('button', { text: `‹ ${t('timeline.earlier')}` });
		this.yearLabel = bar.createDiv({ cls: 'jeong-timeline-year' });
		const later = bar.createEl('button', { text: `${t('timeline.later')} ›` });
		const today = bar.createEl('button', { cls: 'mod-cta', text: t('timeline.today') });
		earlier.addEventListener('click', () => this.showYear(this.year - 1));
		later.addEventListener('click', () => this.showYear(this.year + 1));
		today.addEventListener('click', () => this.showYear(new Date().getFullYear(), true));

		this.scroller = root.createDiv({ cls: 'jeong-timeline-scroller' });
		this.track = this.scroller.createDiv({ cls: 'jeong-timeline-track' });
		this.card = root.createDiv({ cls: 'jeong-timeline-card' });
		this.card.hide();
		this.enablePanning();

		// Redraw when entries change or the pane is resized
		const refresh = debounce(() => this.render(), 300, true);
		this.registerEvent(this.app.metadataCache.on('changed', refresh));
		this.registerEvent(this.app.vault.on('delete', refresh));
		this.registerEvent(this.app.vault.on('rename', refresh));
		this.registerDomEvent(window, 'resize', refresh);

		this.showYear(this.year, true);
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
	}

	/** Pixels from the left edge for a day of the year. */
	private x(day: number): number {
		return 40 + (day / daysIn(this.year)) * (this.track.clientWidth - 80);
	}

	private render(): void {
		const entries = listEntries(this.app, this.plugin.settings.journalFolder).filter((e) => e.date.startsWith(`${this.year}-`));
		this.yearLabel.setText(String(this.year));
		this.track.empty();
		this.track.style.width = `${Math.max(this.scroller.clientWidth * 2.2, 1800)}px`;

		// Month columns with huge numerals
		for (let m = 0; m < 12; m++) {
			const start = dayOfYear(new Date(this.year, m, 1));
			const end = m === 11 ? daysIn(this.year) : dayOfYear(new Date(this.year, m + 1, 1));
			const month = this.track.createDiv({ cls: 'jeong-timeline-month' });
			month.style.left = `${this.x(start)}px`;
			month.style.width = `${this.x(end) - this.x(start)}px`;
			month.createEl('b', { text: String(m + 1).padStart(2, '0') });
			month.createEl('small', { text: moment().month(m).format('MMMM') });
		}

		this.track.createDiv({ cls: 'jeong-timeline-axis' });

		// Today
		const now = new Date();
		if (now.getFullYear() === this.year) {
			const line = this.track.createDiv({ cls: 'jeong-timeline-now' });
			line.style.left = `${this.x(dayOfYear(now))}px`;
			line.createSpan({ text: `${t('timeline.today')} · ${moment(now).format('ll')}` });
		}

		// Entries: one mark per entry; several on the same day stack upward
		const perDay = new Map<string, number>();
		for (const entry of entries) {
			const stack = perDay.get(entry.date) ?? 0;
			perDay.set(entry.date, stack + 1);
			const mark = this.track.createEl('button', { cls: 'jeong-timeline-entry', attr: { 'aria-label': entry.title } });
			mark.style.left = `${this.x(dayOfYear(new Date(`${entry.date}T12:00`)))}px`;
			mark.style.setProperty('--stack', String(stack));
			if (entry.file.path === this.selected) mark.addClass('is-selected');
			if (entry.status === 'recorded') mark.addClass('is-waiting');
			mark.addEventListener('click', () => {
				if (this.dragging.moved) return;
				this.selected = entry.file.path;
				this.render();
				void this.showCard(entry);
			});
		}

		if (!entries.length) {
			this.track.createDiv({ cls: 'jeong-timeline-empty', text: t('timeline.empty') });
			this.card.hide();
		}
	}

	private async showCard(entry: EntryInfo): Promise<void> {
		this.card.empty();
		this.card.show();
		const meta = [moment(`${entry.date} ${entry.time || '12:00'}`).format(entry.time ? 'LLLL' : 'LL'), entry.duration]
			.filter(Boolean)
			.join(' · ');
		if (entry.photos.length) {
			const [main, ...rest] = entry.photos;
			if (main) this.card.createEl('img', { cls: 'jeong-timeline-card-photo', attr: { src: this.app.vault.getResourcePath(main), alt: '' } });
			if (rest.length) {
				const strip = this.card.createDiv({ cls: 'jeong-timeline-card-strip' });
				for (const photo of rest.slice(0, 4)) strip.createEl('img', { attr: { src: this.app.vault.getResourcePath(photo), alt: '' } });
				if (rest.length > 4) strip.createSpan({ cls: 'jeong-timeline-card-more', text: `+${rest.length - 4}` });
			}
		}
		this.card.createDiv({ cls: 'jeong-timeline-card-meta', text: meta });
		this.card.createEl('h2', { text: entry.title });
		const excerpt = entry.status === 'recorded' ? t('timeline.waiting') : entry.summary || (await this.excerpt(entry));
		if (excerpt) this.card.createEl('p', { text: excerpt });
		const open = this.card.createEl('button', { cls: 'mod-cta', text: t('record.openEntry') });
		open.addEventListener('click', () => void this.app.workspace.getLeaf(false).openFile(entry.file));
	}

	/** The first couple of sentences of the entry, without frontmatter or embeds. */
	private async excerpt(entry: EntryInfo): Promise<string> {
		const content = await this.app.vault.cachedRead(entry.file);
		const body = content
			.replace(/^---[\s\S]*?---/, '')
			.replace(/!\[\[[^\]]*\]\]/g, '')
			.trim();
		return body.length > 280 ? `${body.slice(0, 280).trimEnd()}…` : body;
	}

	// Drag to move through the year; the mouse wheel scrolls sideways
	private enablePanning(): void {
		this.registerDomEvent(this.scroller, 'pointerdown', (e: PointerEvent) => {
			if (e.pointerType !== 'mouse') return;
			this.dragging = { active: true, moved: false, x: e.clientX, left: this.scroller.scrollLeft };
		});
		this.registerDomEvent(window, 'pointermove', (e: PointerEvent) => {
			if (!this.dragging.active) return;
			const dx = e.clientX - this.dragging.x;
			if (Math.abs(dx) > 4) this.dragging.moved = true;
			this.scroller.scrollLeft = this.dragging.left - dx;
		});
		this.registerDomEvent(window, 'pointerup', () => {
			this.dragging.active = false;
			window.setTimeout(() => (this.dragging.moved = false), 0);
		});
		this.registerDomEvent(
			this.scroller,
			'wheel',
			(e: WheelEvent) => {
				if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
				this.scroller.scrollLeft += e.deltaY;
				e.preventDefault();
			},
			{ passive: false },
		);
	}
}

function dayOfYear(date: Date): number {
	return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86_400_000;
}

function daysIn(year: number): number {
	return dayOfYear(new Date(year, 11, 31)) + 1;
}
