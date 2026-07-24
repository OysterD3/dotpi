/**
 * Shared constants and types for the subagents extension.
 *
 * This is Claude Code's subagents feature, made configurable for pi: a set of
 * NAMED subagents, each pinned to a model, a reasoning (thinking) level, a
 * purpose, and an optional tool allowlist and system prompt. The main agent
 * delegates a task to one by name through the `task` tool (Claude Code's
 * `subagent_type`), and `/subagents` shows the table.
 *
 * Definitions live in agent/settings.json so they travel with the rest of this
 * config. Each subagent runs as a headless pi subprocess with its model,
 * thinking level, and tools (spawn.ts) — the same mechanism the ultracode
 * workflow uses, here driven by standing definitions instead of a script.
 */

/** settings.json key for the subagents block (a read fallback for manual config). */
export const SETTINGS_KEY = "subagents";

/**
 * The file pi manages through /subagents. It holds the whole block
 * ({ defaults, agents }) and takes precedence over the settings.json fallback,
 * so interactive edits never churn settings.json.
 */
export const STORE_FILE = "subagents.json";

/** The dispatch tool name (Claude Code's is `Task`; pi has no built-in `task`). */
export const TOOL_NAME = "task";

/** pi thinking levels, the values a subagent's `reasoning` may take. */
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const CONFIG = {
	/** Wall-clock ceiling for one subagent, so a hung spawn cannot wedge a turn. */
	subagentTimeoutMs: 15 * 60_000,
} as const;

/** A single configured subagent. */
export interface SubagentDef {
	name: string;
	/** pi model reference; falls back to defaults.model, then the session model. */
	model?: string;
	/** pi thinking level; falls back to defaults.reasoning, then the session level. */
	reasoning?: string;
	/** Shown to the main agent (so it knows when to delegate) and in the panel. */
	purpose: string;
	/** Optional tool allowlist (pi --tools), e.g. ["read","grep","find","ls"]. */
	tools?: string[];
	/** Optional system-prompt preamble for the subagent (pi --append-system-prompt). */
	prompt?: string;
}

export interface SubagentDefaults {
	model?: string;
	reasoning?: string;
}

export interface SubagentsSettings {
	defaults: SubagentDefaults;
	agents: SubagentDef[];
}

export const DEFAULT_SETTINGS: SubagentsSettings = {
	defaults: {},
	agents: [],
};
