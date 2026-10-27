import type { JeongSettings } from '../settings';
import { Claude } from './claude';
import { Ollama } from './ollama';
import { OpenAI } from './openai';

// The language model that writes stories, summaries, and painting scenes. Ollama on this computer by default;
// Claude or OpenAI only when the person picks one in settings and adds their own API key.

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatResult {
	content: string;
	model: string;
	promptTokens: number;
	outputTokens: number;
	ms: number;
}

export interface ChatOptions {
	/** A JSON schema the reply must follow. */
	schema?: object;
	/** How much room the conversation needs, for models that run on this computer. */
	contextTokens?: number;
}

export interface LanguageModel {
	/** Sends a conversation and returns the reply. Pass a JSON schema to get structured output. */
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
	/** Frees the graphics card for painting, when the model runs on this computer. */
	unload(): Promise<void>;
	/** True when the model can be asked now. */
	isReady(): Promise<boolean>;
}

export type StoryProvider = 'ollama' | 'claude' | 'openai';

/** Asks whichever model is chosen in settings, so switching takes effect without reloading. */
export class StoryWriter implements LanguageModel {
	private models: Record<StoryProvider, LanguageModel>;

	constructor(
		private settings: () => JeongSettings,
		secret: (id: string) => string,
	) {
		this.models = {
			ollama: new Ollama(() => settings().ollamaUrl, () => settings().storyModel),
			claude: new Claude(() => secret(settings().claudeKey), () => settings().claudeModel),
			openai: new OpenAI(() => secret(settings().openaiKey), () => settings().openaiModel),
		};
	}

	private get current(): LanguageModel {
		return this.models[this.settings().storyProvider];
	}

	chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
		return this.current.chat(messages, options);
	}

	unload(): Promise<void> {
		return this.current.unload();
	}

	isReady(): Promise<boolean> {
		return this.current.isReady();
	}
}

/** The same schema with every object closed to extra fields, as the cloud APIs' strict modes require. */
export function closedSchema(schema: object): object {
	if (Array.isArray(schema)) return schema.map((item: unknown) => (item && typeof item === 'object' ? closedSchema(item) : item));
	const closed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) closed[key] = value && typeof value === 'object' ? closedSchema(value as object) : value;
	if (closed.type === 'object') closed.additionalProperties = false;
	return closed;
}
