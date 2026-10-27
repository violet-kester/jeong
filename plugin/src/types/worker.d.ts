// Files imported with ?worker are bundled separately and arrive as source code text,
// which is then started as a Web Worker (see esbuild.config.mjs).
declare module '*?worker' {
	const code: string;
	export default code;
}
