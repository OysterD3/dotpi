/**
 * The one line a collapsed run of tool calls is replaced by.
 *
 * "Searched for 1 pattern, read 2 files, ran 2 shell commands" — the calls
 * counted by what they DID rather than listed by name, which is the whole point:
 * a run of nine reads is one fact, not nine lines, and the names of the files
 * are in the calls you can expand to.
 *
 * Pure: no pi, no components, so the wording and the pluralisation can be
 * checked without a terminal.
 */

/**
 * Tool name to a phrase, given how many times it was called.
 *
 * Only tools whose action has a natural English verb are in here. Everything
 * else falls through to naming itself — "called lsp_diagnostics 2 times" is
 * clumsier than a phrase would be and it is true, which a guessed verb might
 * not be. New tools arrive from MCP servers and other extensions all the time,
 * so the fallback is the common path, not the edge case.
 */
const PHRASES: Record<string, (count: number) => string> = {
	read: (n) => `read ${n} ${plural(n, "file")}`,
	write: (n) => `wrote ${n} ${plural(n, "file")}`,
	edit: (n) => `edited ${n} ${plural(n, "file")}`,
	multi_edit: (n) => `edited ${n} ${plural(n, "file")}`,
	bash: (n) => `ran ${n} shell ${plural(n, "command")}`,
	bash_output: (n) => `read ${n} shell ${plural(n, "output")}`,
	grep: (n) => `searched for ${n} ${plural(n, "pattern")}`,
	glob: (n) => `matched ${n} ${plural(n, "glob")}`,
	find: (n) => `searched for ${n} ${plural(n, "file")}`,
	ls: (n) => `listed ${n} ${plural(n, "directory", "directories")}`,
	web_search: (n) => `ran ${n} web ${plural(n, "search")}`,
	fetch_content: (n) => `fetched ${n} ${plural(n, "page")}`,
	todo_write: (n) => `updated the plan ${n === 1 ? "once" : `${n} times`}`,
};

function plural(count: number, one: string, many = `${one}s`): string {
	return count === 1 ? one : many;
}

/** Sentence case, so the line opens like a sentence rather than a log entry. */
function capitalise(text: string): string {
	return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Count each tool in first-appearance order, so the summary reads in the order
 * the work happened rather than alphabetically or by frequency.
 */
export function summarise(toolNames: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);

	const parts = [...counts].map(([name, count]) => {
		const phrase = PHRASES[name];
		return phrase ? phrase(count) : `called ${name} ${count === 1 ? "once" : `${count} times`}`;
	});

	if (parts.length === 0) return "";
	if (parts.length === 1) return capitalise(parts[0]!);
	// Comma-separated with no "and": this is a status line, not prose, and the
	// conjunction is one more thing to wrap on a narrow terminal.
	return capitalise(parts.join(", "));
}
