import { t } from '../i18n';
import type { StoryProgress } from '../compose/write-story';

/** Plain-words status for each step of writing a story. */
export function storyMessage(progress: StoryProgress): string {
	switch (progress) {
		case 'story':
			return t('story.writing');
		case 'check':
			return t('story.checking');
		case 'rewrite':
			return t('story.rewriting');
		case 'summary':
			return t('story.summarizing');
		case 'not-ready':
			return t('story.notReady');
		case 'done':
			return t('story.done');
		case 'failed':
			return t('story.failed');
	}
}
