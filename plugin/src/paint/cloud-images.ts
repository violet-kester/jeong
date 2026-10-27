import { requestUrl } from 'obsidian';

// Paints through OpenAI's or xAI's (Grok's) image API, with the person's own API key. Only used when they
// choose one in settings instead of ComfyUI: the picture's description leaves this computer.

export type CloudPainter = 'openai' | 'xai';

const ENDPOINTS: Record<CloudPainter, string> = {
	openai: 'https://api.openai.com/v1/images/generations',
	xai: 'https://api.x.ai/v1/images/generations',
};

export class CloudImages {
	constructor(
		private service: () => CloudPainter,
		private apiKey: () => string,
		private model: () => string,
	) {}

	isReady(): boolean {
		return this.apiKey().length > 0;
	}

	/** Paints the prompt and returns the image's bytes. */
	async paint(prompt: string): Promise<ArrayBuffer> {
		const service = this.service();
		const response = await requestUrl({
			url: ENDPOINTS[service],
			method: 'POST',
			contentType: 'application/json',
			headers: { Authorization: `Bearer ${this.apiKey()}` },
			// OpenAI's image models always answer in base64; xAI's need asking
			body: JSON.stringify({ model: this.model(), prompt, n: 1, ...(service === 'xai' ? { response_format: 'b64_json' } : { size: '1024x1024' }) }),
		});
		const image = (response.json as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
		if (!image) throw new Error('The image service answered without a picture');
		const bytes = Uint8Array.from(window.atob(image), (char) => char.charCodeAt(0));
		return bytes.buffer;
	}
}
