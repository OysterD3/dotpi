/**
 * Mapping between the conventional capitalised tool names and pi's.
 *
 * Rules are written the conventional way — `Bash(...)`, `Read(...)` — so a
 * settings file can be carried across, but they are matched against pi's actual
 * lower-case tool names. Anything not listed here is matched by its own name, so
 * rules can target custom tools such as `Web_search(...)` too.
 */

/** Conventional name -> pi tool name, for the tools whose names differ. */
const ALIASES: Record<string, string> = {
	bash: "bash",
	read: "read",
	write: "write",
	edit: "edit",
	// The multi-edit and notebook variants map onto pi's single edit tool.
	multiedit: "edit",
	notebookedit: "edit",
	grep: "grep",
	// Glob is pi's find.
	glob: "find",
	find: "find",
	ls: "ls",
};

/** Tools whose rule content is a filesystem path. */
export const PATH_TOOLS = new Set(["read", "write", "edit"]);

/** Tools that can change the machine, used by the write-oriented modes. */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * pi built-ins that only ever read, and read nothing but the filesystem.
 *
 * Used by `auto` mode's `skipReadOnly`, which is a cost decision rather than a
 * safety one: these are what an agent does hundreds of times a turn, and paying
 * for a model call before each `grep` would make the mode unusable. It is
 * deliberately a closed list of built-ins — a custom or MCP tool never lands
 * here, however read-only its name sounds, because an extension's tool can do
 * anything at all.
 *
 * The gap this leaves is real and worth naming: reading a file *is* how a secret
 * gets exposed. `deny` rules are the answer to that (`Read(**\/.env)` and
 * friends), and `auto.skipReadOnly: false` closes it at the price of a call per
 * read.
 */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

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
