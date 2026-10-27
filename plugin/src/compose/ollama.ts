import { requestUrl } from 'obsidian';

// Talks to Ollama, which runs the language model (Granite) on this computer.
// Requests only go to the local address in settings, never to the internet.

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

interface OllamaResponse {
	model: string;
	message?: { content?: string };
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
}

export class Ollama {
	constructor(
		private url: () => string,
		private model: () => string,
	) {}

	/** Sends a conversation and returns the reply. Pass a JSON schema to get structured output. */
	async chat(messages: ChatMessage[], options: { schema?: object; contextTokens?: number } = {}): Promise<ChatResult> {
		const started = performance.now();
		const response = await requestUrl({
			url: `${this.url().replace(/\/$/, '')}/api/chat`,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				model: this.model(),
				messages,
				stream: false,
				...(options.schema ? { format: options.schema } : {}),
				// Low temperature keeps the story close to what was said
				options: { temperature: 0.3, num_ctx: options.contextTokens ?? 8192 },
			}),
		});
		const data = response.json as OllamaResponse;
		return {
			content: data.message?.content?.trim() ?? '',
			model: data.model,
			promptTokens: data.prompt_eval_count ?? 0,
			outputTokens: data.eval_count ?? 0,
			ms: data.total_duration ? data.total_duration / 1e6 : performance.now() - started,
		};
	}

	/**
	 * Frees the model's memory on the graphics card now, rather than after Ollama's usual few idle minutes, so
	 * something else (the painting model) has room. Ollama loads it again the next time it's asked.
	 */
	async unload(): Promise<void> {
		try {
			await requestUrl({
				url: `${this.url().replace(/\/$/, '')}/api/generate`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify({ model: this.model(), keep_alive: 0 }),
				throw: false,
			});
		} catch {
			// Not running, or already unloaded
		}
	}

	/** True when Ollama is running and has the model downloaded. */
	async isReady(): Promise<boolean> {
		try {
			const response = await requestUrl({ url: `${this.url().replace(/\/$/, '')}/api/tags`, throw: false });
			const models = (response.json as { models?: { name: string }[] }).models ?? [];
			return models.some((m) => m.name === this.model() || m.name.startsWith(`${this.model()}:`));
		} catch {
			return false;
		}
	}
}
