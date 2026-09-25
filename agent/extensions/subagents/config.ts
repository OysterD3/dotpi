/**
 * Shared constants and types for the subagents extension.
 *
 * A set of NAMED subagents, each pinned to a model, a reasoning (thinking) level,
 * a purpose, and an optional tool allowlist and system prompt. The main agent
 * delegates a task to one by name through the `task` tool — or, naming none,
 * runs a one-time agent — and `/subagents` shows the table.
 *
 * Each definition is one Markdown file, `<name>.md`, the same shape pi's own
 * example subagent extension and Claude Code use (registry.ts has the format).
 * User agents live in agent/agents/ so they travel with the rest of this
 * config; a trusted project can add its own in `.pi/agents/`. Each subagent
 * runs as a headless pi subprocess with its model, thinking level, and tools
 * (spawn.ts) — the same mechanism the workflow extension uses, here driven by
 * standing definitions instead of a script.
 */

/** Directory of user agent files under the agent dir, and of project agent files under `.pi/`. */
export const AGENTS_DIR = "agents";

/** The dispatch tool name; pi has no built-in `task`, so the name is free. */
export const TOOL_NAME = "task";

/** pi thinking levels, the values a subagent's `reasoning` may take. */
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * The tools a spawned subagent can actually be given.
 *
 * Not `pi.getAllTools()`: a subagent spawns with `--no-extensions`, so every
 * extension tool in this session (workflow, memory, ask_user) is absent from
 * the process that would have to run it. A one-time agent asking for one of
 * those would fail on its spawn; the subagent-creator skill lists the same
 * seven for an agent file.
 */
export const SPAWNABLE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

export const CONFIG = {
	/** Wall-clock ceiling for one subagent, so a hung spawn cannot wedge a turn. */
	subagentTimeoutMs: 15 * 60_000,
} as const;

/** A single configured subagent. */
export interface SubagentDef {
	name: string;
	/** pi model reference; falls back to the session model. */
	model?: string;
	/** pi thinking level; falls back to a `:level` the model reference resolved with, then the session level. */
	reasoning?: string;
	/** Shown to the main agent (so it knows when to delegate) and in the panel. The file calls it `description`. */
	purpose: string;
	/** Optional tool allowlist (pi --tools), e.g. ["read","grep","find","ls"]. */
	tools?: string[];
	/** Optional system-prompt preamble for the subagent (pi --append-system-prompt). The file's body. */
	prompt?: string;
}

/** A definition as found on disk: where it came from, so edit and remove know which file to touch. */
export interface LoadedSubagent extends SubagentDef {
	source: "user" | "project";
	filePath: string;
}
