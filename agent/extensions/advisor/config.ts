/**
 * Shared constants for the advisor extension.
 *
 * The natural shape for this is a server-side tool, where the API forwards the
 * whole conversation to the reviewer model. pi has no such server tool, so the
 * forwarding is done client-side: the tool reads the session branch, flattens it,
 * and sends it to the configured reviewer model as a tool-less headless pi call.
 *
 * The values below are pi-side choices, documented in README.md.
 */

/** Custom session-entry type the advisor status marker is stored under (display only). */
export const ENTRY_TYPE = "advisor";

/** settings.json key for the advisor block. */
export const SETTINGS_KEY = "advisor";

/** The tool name as the model sees it. */
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
	/**
	 * Reasoning level for the reviewer, passed explicitly on every call.
	 *
	 * The point is that it is stated at all. Omitting --thinking does not mean
	 * "the model's default", it means the child reads settings.json and takes
	 * `defaultThinkingLevel` — so raising that for the session you are typing in
	 * silently raised every advisor consult too, and the advisor is spawned
	 * per tool call with the whole transcript in its prompt. That coupling is
	 * invisible at the point where the setting is edited, which is what makes it
	 * a trap rather than a preference.
	 *
	 * "medium" because a second opinion is worth some reasoning and this is not
	 * the session's own model: the reviewer reads a transcript and answers, it
	 * does not carry a task.
	 */
	reviewerThinking: "medium",
	/**
	 * How often the "what is the advisor doing" line is repainted. The elapsed
	 * time is shown in whole seconds, so a faster tick would redraw without
	 * saying anything new — and the point of the tick is that the number moves
	 * during the long silence before the reviewer's first token.
	 */
	statusTickMs: 1000,
} as const;

export interface AdvisorSettings {
	/**
	 * The reviewer model, as a pi model reference ("sonnet", "opus",
	 * "openai-codex/gpt-5.6-sol", ...). This is the whole point of the feature
	 * and it is required: with no model set the advisor tool is not offered.
	 * There is deliberately no baked-in default — which model is worth consulting
	 * depends entirely on which one you are already running.
	 */
	model?: string;
	/**
	 * Kill switch. Defaults to true. Even with a model set, `enabled: false` keeps
	 * the tool out of the session.
	 */
	enabled: boolean;
}

export const DEFAULT_SETTINGS: AdvisorSettings = {
	enabled: true,
};
