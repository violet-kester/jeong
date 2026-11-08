// web/obsidian.ts adds Obsidian's helpers to the DOM when it loads; Node has no DOM, so give it somewhere to put them.
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of ['Node', 'Element', 'HTMLElement']) globals[name] = class {};
globals.window = globalThis;
globals.document = { createElement: () => ({}) };
globals.location = { search: '' };
if (!('navigator' in globalThis)) globals.navigator = { userAgent: 'test' };
export {};
