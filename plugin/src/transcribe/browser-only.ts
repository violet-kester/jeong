// Obsidian's workers can see Node.js's `process` object. Transformers.js and the ONNX
// runtime check for it, decide they're running in Node, and then skip loading the browser
// runtime (WebGPU + WebAssembly) we want. Hide it, so they take the browser path.
// This file must be imported before '@huggingface/transformers'.

const scope = globalThis as { process?: unknown };
if (scope.process !== undefined) {
	try {
		Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });
	} catch {
		scope.process = undefined;
	}
}

export {};
