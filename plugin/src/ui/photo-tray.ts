import { setIcon } from 'obsidian';
import { t } from '../i18n';

// The photo tray in the recording panel. On a computer, drag photos in or click to choose;
// on a phone, tapping opens the photo picker. Photos can be added before, during, or after
// recording. The first photo is the main one; the star makes another photo the main one.

export interface Photo {
	file: File;
	url: string;
	/** Written to the journal (or on its way): it can no longer be removed or reordered here. */
	saved: boolean;
}

export class PhotoTray {
	photos: Photo[] = [];
	private strip: HTMLElement;
	private input: HTMLInputElement;
	private dragFrom = -1;
	/** Called when photos are added, so a window with a saved entry can write them straight away. */
	onAdd: (() => void) | null = null;
	/** Called after photos are added, removed or reordered. */
	onChange: (() => void) | null = null;

	/**
	 * `label` replaces the button's words, e.g. a shorter "Add photos" where space is tight.
	 * `stripHost` puts the row of photos somewhere other than beside the button.
	 */
	constructor(container: HTMLElement, label = t('photos.add'), stripHost?: HTMLElement) {
		const tray = container.createDiv({ cls: 'jeong-photos' });
		this.input = tray.createEl('input', { type: 'file', attr: { accept: 'image/*', multiple: '' } });
		this.input.hide();
		this.input.addEventListener('change', () => {
			this.add(Array.from(this.input.files ?? []));
			this.input.value = '';
		});

		this.strip = (stripHost ?? tray).createDiv({ cls: 'jeong-photos-strip' });
		const drop = tray.createEl('button', { cls: 'jeong-photos-drop' });
		setIcon(drop.createSpan({ cls: 'jeong-photos-icon' }), 'image-plus');
		drop.createSpan({ text: label });
		drop.addEventListener('click', () => this.input.click());

		// Drag and drop from the desktop, a file explorer, or a browser
		tray.addEventListener('dragover', (e) => {
			if (!e.dataTransfer?.types.includes('Files')) return;
			e.preventDefault();
			tray.addClass('is-dragging');
		});
		tray.addEventListener('dragleave', () => tray.removeClass('is-dragging'));
		tray.addEventListener('drop', (e) => {
			tray.removeClass('is-dragging');
			if (!e.dataTransfer?.files.length) return;
			e.preventDefault();
			this.add(Array.from(e.dataTransfer.files));
		});
	}

	add(files: File[]): void {
		for (const file of files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))) {
			this.photos.push({ file, url: URL.createObjectURL(file), saved: false });
		}
		this.render();
		this.onAdd?.();
		this.onChange?.();
	}

	/** Takes the photos not written yet and marks them as written, so nothing else writes them too. */
	claim(): Photo[] {
		const photos = this.photos.filter((photo) => !photo.saved);
		photos.forEach((photo) => (photo.saved = true));
		if (photos.length) this.render();
		return photos;
	}

	/** Writing them failed: they're waiting again. */
	release(photos: Photo[]): void {
		photos.forEach((photo) => (photo.saved = false));
		if (photos.length) this.render();
	}

	dispose(): void {
		this.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
		this.photos = [];
	}

	private render(): void {
		this.strip.empty();
		// Once one is in the journal, the order is too
		const ordered = this.photos.some((photo) => photo.saved);
		this.photos.forEach((photo, index) => {
			const item = this.strip.createDiv({ cls: 'jeong-photos-item', attr: { draggable: ordered ? 'false' : 'true' } });
			if (index === 0) item.addClass('is-main');
			item.createEl('img', { attr: { src: photo.url, alt: photo.file.name } });

			if (!ordered) {
				const star = item.createEl('button', { cls: 'jeong-photos-star', attr: { 'aria-label': t('photos.makeMain') } });
				setIcon(star, 'star');
				star.addEventListener('click', () => this.move(index, 0));
			}

			if (!photo.saved) {
				const remove = item.createEl('button', { cls: 'jeong-photos-remove', attr: { 'aria-label': t('photos.remove') } });
				setIcon(remove, 'x');
				remove.addEventListener('click', () => {
					URL.revokeObjectURL(photo.url);
					this.photos.splice(index, 1);
					this.render();
					this.onChange?.();
				});
			}

			// Drag a thumbnail onto another to reorder
			item.addEventListener('dragstart', () => (this.dragFrom = index));
			item.addEventListener('dragover', (e) => {
				if (this.dragFrom >= 0) e.preventDefault();
			});
			item.addEventListener('drop', (e) => {
				if (this.dragFrom < 0) return;
				e.preventDefault();
				e.stopPropagation();
				this.move(this.dragFrom, index);
				this.dragFrom = -1;
			});
		});
	}

	private move(from: number, to: number): void {
		const [photo] = this.photos.splice(from, 1);
		if (photo) this.photos.splice(to, 0, photo);
		this.render();
		this.onChange?.();
	}
}

/** "IMG_2041.HEIC" → "heic"; falls back to the file's type, then "jpg". */
export function photoExtension(file: { name: string; type: string }): string {
	const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
	if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
	const fromType = file.type.split('/')[1]?.toLowerCase();
	return fromType === 'jpeg' ? 'jpg' : fromType || 'jpg';
}
