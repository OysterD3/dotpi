/**
 * Constants for the workspace extension.
 */

/** Custom session entry recording a session-scoped add or remove. */
export const ENTRY_TYPE = "workspace_dir";

/** Key inside the `permissions` block of settings.json, conventionally named. */
export const SETTINGS_KEY = "additionalDirectories";

/**
 * Where the workspace is announced for other extensions to act on.
 *
 * The permissions extension is the consumer that made this necessary: auto
 * mode's classifier decides half of what it decides by asking "is this path
 * inside the project", and being told about only the cwd made every write to an
 * added directory read as an escape from it. Settings alone cannot close that —
 * a `/add-dir` is session-scoped by design, so it is in the session log and in
 * no file at all.
 *
 * The string is duplicated on the consumer's side rather than shared through a
 * module, matching the rest of this repo: extensions here install one at a time,
 * so they may share a string but never an import. With nobody listening, this is
 * a no-op.
 *
 * Every message carries the complete list and replaces the last one. A removal
 * therefore needs no event of its own, and `/rewind` past an `/add-dir` is
 * correct for free.
 */
export const WORKSPACE_CHANNEL = "workspace:dirs";

/**
 * Context filenames, in pi's own precedence order (resource-loader.js). Only the
 * first match in a directory is loaded, exactly as pi does for the cwd.
 */
export const CONTEXT_FILES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** The three answers offered, with their labels. */
export const CHOICES = [
	{ value: "session", label: "Yes, for this session" },
	{ value: "remember", label: "Yes, and remember this directory" },
	{ value: "no", label: "No" },
] as const;

export type Choice = (typeof CHOICES)[number]["value"];

export const CONFIG = {
	/**
	 * Read each added directory's AGENTS.md the way pi reads the project's own.
	 * Tracking the added directories separately exists for exactly this purpose.
	 * Set false to add directories without their guidance.
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
