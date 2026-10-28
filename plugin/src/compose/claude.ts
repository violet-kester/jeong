import Anthropic from '@anthropic-ai/sdk';
import { closedSchema, type ChatMessage, type ChatOptions, type ChatResult, type LanguageModel } from './language-model';

// Talks to Claude through Anthropic's API, with the person's own API key. Only used when they choose
// Claude in settings: transcripts and entries leave this computer and go to Anthropic.

/** Models that can hand a declined request to another Claude model instead of returning the refusal. */
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

export class Claude implements LanguageModel {
	constructor(
		private apiKey: () => string,
		private model: () => string,
	) {}

	async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
		const started = performance.now();
		// Obsidian runs plugins in its own window; the key is the person's and stays on their computer
		const client = new Anthropic({ apiKey: this.apiKey(), dangerouslyAllowBrowser: true });
		const model = this.model();
		const system = messages
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n\n');
		const fallback = FALLBACK_MODELS.includes(model);
		const response = await client.beta.messages.create({
			model,
			max_tokens: 16000,
			...(system ? { system } : {}),
			messages: messages
				.filter((m) => m.role !== 'system')
				.map((m) => ({
					role: m.role as 'user' | 'assistant',
					content: m.images?.length
						? [
								...m.images.map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } })),
								{ type: 'text' as const, text: m.content },
							]
						: m.content,
				})),
			output_config: {
				effort: 'medium',
				...(options.schema ? { format: { type: 'json_schema' as const, schema: closedSchema(options.schema) as Record<string, unknown> } } : {}),
			},
			...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
		});
		if (response.stop_reason === 'refusal') throw new Error(`Claude declined to write this (${response.stop_details?.category ?? 'no reason given'})`);
		const content = response.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('');
		return {
			content: content.trim(),
			model: response.model,
			promptTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0),
			outputTokens: response.usage.output_tokens,
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
