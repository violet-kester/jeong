import { requestUrl } from 'obsidian';
import { closedSchema, type ChatMessage, type ChatOptions, type ChatResult, type LanguageModel } from './language-model';

// Talks to OpenAI's API, with the person's own API key. Only used when they choose OpenAI in settings:
// transcripts and entries leave this computer and go to OpenAI.

interface OpenAIResponse {
	model: string;
	choices?: { message?: { content?: string | null; refusal?: string | null } }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAI implements LanguageModel {
	constructor(
		private apiKey: () => string,
		private model: () => string,
	) {}

	async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
		const started = performance.now();
		const response = await requestUrl({
			url: 'https://api.openai.com/v1/chat/completions',
			method: 'POST',
			contentType: 'application/json',
			headers: { Authorization: `Bearer ${this.apiKey()}` },
			body: JSON.stringify({
				model: this.model(),
				messages,
				...(options.schema
					? { response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: closedSchema(options.schema) } } }
					: {}),
			}),
		});
		const data = response.json as OpenAIResponse;
		const message = data.choices?.[0]?.message;
		if (message?.refusal) throw new Error(`OpenAI declined to write this: ${message.refusal}`);
		return {
			content: message?.content?.trim() ?? '',
			model: data.model,
			promptTokens: data.usage?.prompt_tokens ?? 0,
			outputTokens: data.usage?.completion_tokens ?? 0,
			ms: performance.now() - started,
		};
	}

	async unload(): Promise<void> {
		// Nothing runs on this computer
	}

	async isReady(): Promise<boolean> {
		return this.apiKey().length > 0;
	}
}
