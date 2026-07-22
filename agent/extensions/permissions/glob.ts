/**
 * Glob matching for path rules. Pure and dependency-free.
 *
 * pi bundles minimatch, but does not re-export it, so relying on a transitive
 * dependency would be a hidden break on any pi upgrade. This is small enough to
 * own outright — and being able to test the matcher directly matters more than
 * usual here, since it decides whether a deny rule protects a file or silently
 * fails to.
 *
 * Supported, matching the syntax Claude Code documents for path rules:
 *   *   any run of characters except "/"
 *   **  any run of characters including "/" (whole path segments)
 *   ?   exactly one character except "/"
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** Compile a glob to an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
	let out = "";

	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];

		if (char === "*") {
			const isDouble = pattern[i + 1] === "*";
			if (isDouble) {
				i++;
				// "a/**/b" must also match "a/b", so consume the following slash
				// into the optional group rather than requiring it.
				if (pattern[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			out += "[^/]";
			continue;
		}

		out += char.replace(SPECIAL, "\\$&");
	}

	return new RegExp(`^${out}$`);
}

/** Does `path` match `pattern`? Both should already be absolute or both relative. */
export function matchGlob(pattern: string, path: string): boolean {
	return globToRegExp(pattern).test(path);
}

/**
 * Match a raw string pattern where only `*` is special and `/` is not.
 *
 * Used for Bash command rules, which are string patterns rather than paths:
 * Claude Code documents these as prefix string matches with no argument parsing.
 */
export function matchCommandPattern(pattern: string, command: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(SPECIAL, "\\$&").replace(/\*/g, ""))
		.join(".*");
	return new RegExp(`^${source}$`, "s").test(command);
}
