/**
 * Compact rendering for the built-in tools.
 *
 * pi already collapses tool output by default and expands it with ctrl+o
 * ("Toggle tool output", the `app.n` keybinding) — but the collapsed view still
 * shows up to ~10 lines per tool. This makes the collapsed view a SINGLE
 * summary line (path + line/exit/diff counts), and shows the detail only once
 * the row is expanded. Nothing is lost: ctrl+o toggles every tool row open.
 *
 * It works by re-registering each built-in with the same name, delegating
 * execution to the original tool (create*Tool from the SDK) unchanged, and
 * supplying only compact renderCall/renderResult — the pattern from pi's own
 * examples/extensions/built-in-tool-renderer.ts.
 *
 * pi has no mouse handling, so expansion is the ctrl+o keypress, not a click.
 */

export const SETTINGS_KEY = "compactTools";

/** The built-in tools this extension recompacts. */
export const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

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
