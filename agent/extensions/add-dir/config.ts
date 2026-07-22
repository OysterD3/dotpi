/**
 * Constants for the workspace extension.
 */

/** Custom session entry recording a session-scoped add or remove. */
export const ENTRY_TYPE = "workspace_dir";

/** Key inside the `permissions` block of settings.json, as Claude Code names it. */
export const SETTINGS_KEY = "additionalDirectories";

/**
 * Context filenames, in pi's own precedence order (resource-loader.js). Only the
 * first match in a directory is loaded, exactly as pi does for the cwd.
 */
export const CONTEXT_FILES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** The three answers Claude Code offers, with its labels. */
export const CHOICES = [
	{ value: "session", label: "Yes, for this session" },
	{ value: "remember", label: "Yes, and remember this directory" },
	{ value: "no", label: "No" },
] as const;

export type Choice = (typeof CHOICES)[number]["value"];

export const CONFIG = {
	/**
	 * Read each added directory's AGENTS.md the way pi reads the project's own.
	 * Claude Code does this too — it tracks the added directories separately for
	 * exactly this purpose. Set false to add directories without their guidance.
	 */
	loadContextFiles: true,
	/** Per-file cap on injected context, so one huge AGENTS.md cannot flood the prompt. */
	contextFileMaxChars: 24_000,
	/** Cap across all added directories combined. */
	contextFileTotalChars: 48_000,
	/** Refuse to grow the workspace past this, to keep the prompt bounded. */
	maxDirectories: 24,
	/** Directory suggestions offered while typing `/add-dir <prefix>`. */
	completionLimit: 20,
	/** How long to wait for a settings.json lock held by pi itself. */
	lockRetries: 10,
	lockDelayMs: 20,
};
