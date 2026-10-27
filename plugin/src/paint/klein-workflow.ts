import type { Workflow } from './comfyui';

// The built-in painting workflow: FLUX.2 [klein] 4B (distilled, Apache 2.0), from ComfyUI's own
// "Text to Image (FLUX.2 Klein 4B Distilled)" template, in ComfyUI's API format. Four steps, no
// negative prompt. The files it needs, from huggingface.co/Comfy-Org/Flux-2-Klein-4B, go in ComfyUI/models:
//
//   diffusion_models/flux-2-klein-4b.safetensors
//   text_encoders/qwen_3_4b_fp4_flux2.safetensors   (the small text encoder, for 8 GB graphics cards)
//   vae/flux2-vae.safetensors

// 5:3, like a card's photo; both sides a multiple of 16
const WIDTH = 960;
const HEIGHT = 576;

export function kleinWorkflow(prompt: string, seed: number): Workflow {
	return {
		model: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-4b.safetensors', weight_dtype: 'default' } },
		clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b_fp4_flux2.safetensors', type: 'flux2', device: 'default' } },
		vae: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
		positive: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['clip', 0] } },
		negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } },
		guider: { class_type: 'CFGGuider', inputs: { cfg: 1, model: ['model', 0], positive: ['positive', 0], negative: ['negative', 0] } },
		noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
		sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
		sigmas: { class_type: 'Flux2Scheduler', inputs: { steps: 4, width: WIDTH, height: HEIGHT } },
		latent: { class_type: 'EmptyFlux2LatentImage', inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
		sample: {
			class_type: 'SamplerCustomAdvanced',
			inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['latent', 0] },
		},
		decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
		save: { class_type: 'SaveImage', inputs: { filename_prefix: 'jeong/painting', images: ['decode', 0] } },
	};
}
