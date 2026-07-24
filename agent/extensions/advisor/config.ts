/**
 * Shared constants for the advisor extension.
 *
 * The advisor is Claude Code's Advisor Tool ported to pi. In Claude Code it is
 * a server-side beta tool (the API request carries a tool schema
 * `{type:"advisor_20260301", name:"advisor", model}` and the API forwards the
 * whole conversation to `model`). pi has no such server tool, so the forwarding
 * is done client-side: the tool reads the session branch, flattens it, and
 * sends it to the configured reviewer model as a tool-less headless pi call.
 *
 * Values that mirror Claude Code are marked with the source they came from in
 * the 2.1.218 binary; the rest are pi-side choices documented in README.md.
 */

/** Custom session-entry type the advisor status marker is stored under (display only). */
export const ENTRY_TYPE = "advisor";

/** settings.json key for the advisor block. */
export const SETTINGS_KEY = "advisor";

/** The tool name, verbatim from Claude Code (`name:"advisor"`). */
export const TOOL_NAME = "advisor";

export const CONFIG = {
	/**
	 * Fraction of the reviewer model's context window spent on the forwarded
	 * transcript. The reviewer also needs room for its own reply and its system
	 * prompt, so this stays well under 1. Same shape as the recap extension.
	 */
	transcriptBudgetFraction: 0.5,
	/** Rough chars-per-token for budgeting the transcript (recap uses the same). */
	charsPerToken: 3.5,
	/** Context window assumed when the reviewer model does not report one. */
	fallbackContextWindow: 200_000,
	/** A single tool result longer than this is truncated before forwarding. */
	maxToolResultChars: 4_000,
	/** Wall-clock ceiling for one reviewer call, so a hung spawn cannot wedge the turn. */
	reviewerTimeoutMs: 5 * 60_000,
} as const;

export interface AdvisorSettings {
	/**
	 * The reviewer model, as a pi model reference ("sonnet", "opus",
	 * "openai-codex/gpt-5.6-sol", ...). This is the whole point of the feature
	 * and it is required: with no model set the advisor tool is not offered.
	 * Claude Code stores this as `advisorModel`; there is no baked-in default
	 * (Claude Code's `Lyo()` returns undefined when unset, which disables the
	 * tool). Configurable, and it must be.
	 */
	model?: string;
	/**
	 * Kill switch. Defaults to true. Mirrors Claude Code's
	 * CLAUDE_CODE_DISABLE_ADVISOR_TOOL / the `rY()` gate: even with a model set,
	 * `enabled: false` keeps the tool out of the session.
	 */
	enabled: boolean;
}

export const DEFAULT_SETTINGS: AdvisorSettings = {
	enabled: true,
};
