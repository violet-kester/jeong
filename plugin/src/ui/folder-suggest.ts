import { AbstractInputSuggest, App, TFolder } from 'obsidian';

/** Suggests the vault's folders under a text box as you type, like Obsidian's own folder settings. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const lower = query.toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((folder) => folder.path.toLowerCase().includes(lower))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		// Let the setting's onChange save the choice, as if it had been typed
		this.inputEl.trigger('input');
		this.close();
	}
}
