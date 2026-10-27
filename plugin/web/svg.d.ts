// SVG files are bundled as their text (see build.mjs)
declare module '*.svg' {
	const text: string;
	export default text;
}
