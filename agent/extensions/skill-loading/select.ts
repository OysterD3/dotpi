/**
 * Which mode a skill is in.
 *
 * Configuration is a map of pattern to mode, and the patterns are deliberately
 * more than exact names. pi's skill names include plugin-scoped families —
 * `chrome-devtools-mcp:a11y-debugging`, `chrome-devtools-mcp:troubleshooting`
 * and four more arrive together from one package — and listing each by hand is
 * how a config file goes stale the next time that package adds one. So
 * `"chrome-devtools-mcp:*": "command"` covers the family, including members that
 * do not exist yet.
 *
 * Precedence, most specific first, because a family rule must not be able to
 * override the one exception you carved out of it:
 *
 *   1. an exact name
 *   2. the longest matching glob (measured by its literal characters, so
 *      `chrome-devtools-mcp:*` beats `*`)
 *   3. `default`
 *
 * Pure: no filesystem, no pi APIs.
 */

import { isMode, type Mode, type SkillLoadingSettings } from "./config.ts";

/** `*` matches any run of characters; everything else is literal. */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.split("*").join(".*")}$`);
}

/** How many characters of a pattern are literal — its specificity. */
function literalLength(pattern: string): number {
	return pattern.split("*").join("").length;
}

export function modeFor(name: string, settings: SkillLoadingSettings): Mode {
	const configured = settings.skills;

	const exact = configured[name];
	if (isMode(exact)) return exact;

	let best: { mode: Mode; length: number } | undefined;
	for (const [pattern, mode] of Object.entries(configured)) {
		if (!pattern.includes("*")) continue;
		if (!isMode(mode)) continue;
		if (!globToRegExp(pattern).test(name)) continue;

		const length = literalLength(pattern);
		// `>` not `>=`, so the first of two equally specific patterns wins and the
		// answer does not depend on object key order.
		if (!best || length > best.length) best = { mode, length };
	}

	return best?.mode ?? settings.default;
}

export type Decided<T> = { entry: T; mode: Mode };

/** Every skill with the mode it resolved to, in the order they were given. */
export function decide<T extends { name: string }>(entries: T[], settings: SkillLoadingSettings): Decided<T>[] {
	return entries.map((entry) => ({ entry, mode: modeFor(entry.name, settings) }));
}
