// English strings. Every word shown on screen lives here, so Jeong (정) can be translated.
// Keep the wording plain and friendly (see "Easy for everyone" in the project notes).
export const en = {
	'ribbon.record': 'Record a new entry',
	'command.newEntry': 'Record a new entry',

	'record.title': 'New entry',
	'record.ready': 'Press the button and start talking.',
	'record.start': 'Start recording',
	'record.stop': 'Stop',
	'record.recording': 'Recording… press Stop when you’re done.',
	'record.saving': 'Saving…',
	'record.saved': 'Saved. This is a test recording, so it isn’t an entry yet.',
	'record.saveFailed': 'I couldn’t save that recording. Nothing else was changed. Try again, and if it keeps happening, let us know.',
	'record.noMicrophone': 'I can’t reach your microphone. Check that it’s plugged in and that Obsidian is allowed to use it.',

	'check.webgpu': 'Graphics (WebGPU)',
	'check.liveModel': 'Live transcript',
	'check.loading': 'Getting ready…',
	'check.downloading': 'Downloading (first time only)',
	'check.warming': 'Preparing on the graphics card (first time can take a minute)…',
	'check.readyIn': 'ready in',
	'check.speed': 'Speed',
	'check.finalModel': 'Final transcript',
	'compare.reading': 'Whisper is reading the whole recording…',
	'compare.whisper': 'Whisper (final transcript)',
	'compare.toRead': 'to read',
	'check.fasterThanSpeech': 'faster than speech',
	'check.lastPhrase': 'last phrase',
	'check.error': 'Problem',
	'check.format': 'Recording format',
	'check.saved': 'Test file',
	'check.savedLater': 'Saving on this device comes later',
	'check.yes': 'Available',
	'check.no': 'Not available (will use the slower CPU path)',
	'check.unknown': 'Unknown',

	'settings.journalFolder.name': 'Journal folder',
	'settings.journalFolder.desc': 'Where Jeong keeps your entries, inside this vault.',
};

export type StringKey = keyof typeof en;
