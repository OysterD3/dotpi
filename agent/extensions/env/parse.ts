/**
 * dotenv-style parsing. Pure and dependency-free, so it is directly testable.
 *
 * Format: `KEY=value`, one per line. `export KEY=value` works too. Blank lines and `#`
 * comments are ignored. Values may be single- or double-quoted; double-quoted values
 * interpret `\n`, `\t`, `\r`, `\"` and `\\`. Single quotes are literal, matching shell
 * semantics. In an unquoted value, only " #" (space-hash) starts a trailing comment, so
 * `KEY=abc#notacomment` keeps its hash.
 */

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse dotenv text into key/value pairs. Malformed lines are skipped, never fatal. */
export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = withoutExport.indexOf("=");
		if (eq <= 0) continue;

		const key = withoutExport.slice(0, eq).trim();
		if (!VALID_KEY.test(key)) continue;

		out[key] = parseValue(withoutExport.slice(eq + 1).trim());
	}

	return out;
}

function parseValue(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}

	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}

	const comment = value.indexOf(" #");
	return comment === -1 ? value : value.slice(0, comment).trim();
}
