/** An entry's words, without frontmatter, embeds, the links line, or callouts. */
export function storyText(content: string): string {
	return content
		.replace(/^---[\s\S]*?---/, '')
		.replace(/!\[\[[^\]]*\]\]/g, '')
		.replace(/^\*\[\[.*\]\]\*$/gm, '')
		.replace(/^>.*$/gm, '')
		.trim();
}
