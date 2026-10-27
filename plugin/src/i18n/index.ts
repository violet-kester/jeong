import { moment } from 'obsidian';
import { en, StringKey } from './en';

// Add a language by creating a file like ko.ts with the same keys and listing it here.
const languages: Record<string, Partial<Record<StringKey, string>>> = {
	en,
};

// Follow Obsidian's own display language, and fall back to English for anything missing.
export function t(key: StringKey): string {
	const language = moment.locale().split('-')[0] ?? 'en';
	return languages[language]?.[key] ?? en[key];
}
