import { requestUrl } from 'obsidian';
import type { ChatMessage, ChatOptions, ChatResult, LanguageModel } from './language-model';

// Talks to Ollama, which runs the language model (Granite) on this computer.
// Requests only go to the local address in settings, never to the internet.

interface OllamaResponse {
	model: string;
	message?: { content?: string };
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
}

export class Ollama implements LanguageModel {
	constructor(
		private url: () => string,
		private model: () => string,
		/** The model that looks at photos; the story model may not see images. */
		private photoModel: () => string = model,
	) {}

	async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
		const started = performance.now();
		const sees = messages.some((m) => m.images?.length);
		const response = await requestUrl({
			url: `${this.url().replace(/\/$/, '')}/api/chat`,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				model: sees ? this.photoModel() : this.model(),
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
		for (const model of new Set([this.model(), this.photoModel()])) {
			try {
				await requestUrl({
					url: `${this.url().replace(/\/$/, '')}/api/generate`,
					method: 'POST',
					contentType: 'application/json',
					body: JSON.stringify({ model, keep_alive: 0 }),
					throw: false,
				});
			} catch {
				// Not running, or already unloaded
			}
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
