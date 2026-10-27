import { setIcon } from 'obsidian';
import { t } from '../i18n';

// The photo tray in the recording panel. On a computer, drag photos in or click to choose;
// on a phone, tapping opens the photo picker. Photos can be added before, during, or after
// recording. The first photo is the main one; the star makes another photo the main one.

export interface Photo {
	file: File;
	url: string;
}

export class PhotoTray {
	photos: Photo[] = [];
	private strip: HTMLElement;
	private input: HTMLInputElement;
	private dragFrom = -1;

	constructor(container: HTMLElement) {
		const tray = container.createDiv({ cls: 'jeong-photos' });
		this.input = tray.createEl('input', { type: 'file', attr: { accept: 'image/*', multiple: '' } });
		this.input.hide();
		this.input.addEventListener('change', () => {
			this.add(Array.from(this.input.files ?? []));
			this.input.value = '';
		});

		this.strip = tray.createDiv({ cls: 'jeong-photos-strip' });
		const drop = tray.createEl('button', { cls: 'jeong-photos-drop' });
		setIcon(drop.createSpan({ cls: 'jeong-photos-icon' }), 'image-plus');
		drop.createSpan({ text: t('photos.add') });
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
			this.photos.push({ file, url: URL.createObjectURL(file) });
		}
		this.render();
	}

	dispose(): void {
		this.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
		this.photos = [];
	}

	private render(): void {
		this.strip.empty();
		this.photos.forEach((photo, index) => {
			const item = this.strip.createDiv({ cls: 'jeong-photos-item', attr: { draggable: 'true' } });
			if (index === 0) item.addClass('is-main');
			item.createEl('img', { attr: { src: photo.url, alt: photo.file.name } });

			const star = item.createEl('button', { cls: 'jeong-photos-star', attr: { 'aria-label': t('photos.makeMain') } });
			setIcon(star, 'star');
			star.addEventListener('click', () => this.move(index, 0));

			const remove = item.createEl('button', { cls: 'jeong-photos-remove', attr: { 'aria-label': t('photos.remove') } });
			setIcon(remove, 'x');
			remove.addEventListener('click', () => {
				URL.revokeObjectURL(photo.url);
				this.photos.splice(index, 1);
				this.render();
			});

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
	}
}

/** "IMG_2041.HEIC" → "heic"; falls back to the file's type, then "jpg". */
export function photoExtension(file: { name: string; type: string }): string {
	const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
	if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
	const fromType = file.type.split('/')[1]?.toLowerCase();
	return fromType === 'jpeg' ? 'jpg' : fromType || 'jpg';
}
