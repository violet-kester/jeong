// Checks whether WebGPU is available, and which graphics chip it would use.
// Moonshine and Whisper run much faster on WebGPU than on the CPU fallback.

interface GpuAdapterInfo {
	vendor?: string;
	architecture?: string;
	description?: string;
}
interface GpuAdapter {
	info?: GpuAdapterInfo;
}
interface Gpu {
	requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<GpuAdapter | null>;
}

export interface WebGpuStatus {
	available: boolean;
	adapter?: string;
}

export async function checkWebGpu(): Promise<WebGpuStatus> {
	const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
	if (!gpu) return { available: false };
	try {
		const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) return { available: false };
		const info = adapter.info ?? {};
		const name = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ');
		return { available: true, adapter: name || undefined };
	} catch {
		return { available: false };
	}
}
