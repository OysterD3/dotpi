/**
 * Mapping between Claude Code's capitalised tool names and pi's.
 *
 * Rules are written the Claude Code way — `Bash(...)`, `Read(...)` — so a
 * settings file can be carried across, but they are matched against pi's actual
 * lower-case tool names. Anything not listed here is matched by its own name, so
 * rules can target custom tools such as `Web_search(...)` too.
 */

/** Claude Code name -> pi tool name, for the tools whose names differ. */
const ALIASES: Record<string, string> = {
	bash: "bash",
	read: "read",
	write: "write",
	edit: "edit",
	// Claude Code's multi-edit and notebook variants map onto pi's single edit tool.
	multiedit: "edit",
	notebookedit: "edit",
	grep: "grep",
	// Claude Code's Glob is pi's find.
	glob: "find",
	find: "find",
	ls: "ls",
};

/** Tools whose rule content is a filesystem path. */
export const PATH_TOOLS = new Set(["read", "write", "edit"]);

/** Tools that can change the machine, used by the write-oriented modes. */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * Resolve a rule's tool name to pi's.
 *
 * Unknown names are passed through lower-cased rather than rejected: pi
 * extensions register their own tools, and a rule naming one should work.
 */
export function resolveToolName(name: string): string | undefined {
	const key = name.toLowerCase();
	if (key.length === 0) return undefined;
	return ALIASES[key] ?? key;
}
