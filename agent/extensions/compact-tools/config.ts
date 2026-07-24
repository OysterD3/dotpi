/**
 * Compact rendering for the noisy built-in tools.
 *
 * pi already collapses tool output by default and expands it with ctrl+o
 * ("Toggle tool output", the `app.n` keybinding) — but the collapsed view still
 * shows up to ~10 lines per tool. This makes the collapsed view a SINGLE
 * summary line (path + line/exit/match counts), and shows the detail only once
 * the row is expanded. Nothing is lost: ctrl+o toggles every tool row open.
 *
 * `write` and `edit` are deliberately NOT recompacted: their whole value is the
 * change they make, so pi's own renderers — a syntax-highlighted content preview
 * for a write, a coloured +/- diff for an edit — are left in place to show it.
 * Compacting is for the read-only / exec tools whose output is context, not a
 * change: read, bash, grep, find, ls.
 *
 * It works by re-registering each of those built-ins with the same name,
 * delegating execution to the original tool (create*Tool from the SDK)
 * unchanged, and supplying only compact renderCall/renderResult — the pattern
 * from pi's own examples/extensions/built-in-tool-renderer.ts.
 *
 * pi has no mouse handling, so expansion is the ctrl+o keypress, not a click.
 */

export const SETTINGS_KEY = "compactTools";

/**
 * The built-in tools this extension recompacts. Intentionally excludes `write`
 * and `edit` — those keep pi's built-in rendering so a write shows its content
 * and an edit shows its diff.
 */
export const TOOL_NAMES = ["read", "bash", "grep", "find", "ls"] as const;

export const CONFIG = {
	/** Longest command/arg string shown on a call line before eliding. */
	callMaxChars: 100,
} as const;

export interface CompactToolsSettings {
	/** Master switch. Default true. */
	enabled: boolean;
	/** How many lines of detail to show when a row is expanded (then "… N more"). */
	expandedLines: number;
}

export const DEFAULT_SETTINGS: CompactToolsSettings = {
	enabled: true,
	expandedLines: 100,
};
