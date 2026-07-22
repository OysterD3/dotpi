/**
 * Tunables for /rewind.
 */

export const CONFIG = {
	/**
	 * Tools whose file mutations are checkpointed, by tool name and the parameter
	 * holding the path. pi's built-in `write` and `edit` both use `path`.
	 *
	 * Add custom file-writing tools here. `bash` is deliberately absent: a shell
	 * command can touch anything, and there is no way to know what beforehand, so
	 * including it would create checkpoints that silently miss files.
	 */
	trackedTools: { write: "path", edit: "path" } as Record<string, string>,

	/**
	 * Files larger than this are not backed up, and are reported as skipped rather
	 * than silently missing. Keeps a runaway session from filling the disk.
	 */
	maxFileBytes: 8 * 1024 * 1024,

	/** Directory under the pi agent dir holding per-session history. */
	historyDirName: "file-history",

	/** Session history directories older than this are removed at startup. */
	pruneAfterDays: 30,

	/** Newest N checkpoints offered in the picker. */
	maxCheckpointsShown: 30,

	/** Characters of a prompt shown in the picker before truncating. */
	promptPreviewChars: 60,
};

/** Restore modes, matching Claude Code's three options and their labels. */
export const MODES = [
	{ value: "both", label: "Restore code and conversation" },
	{ value: "conversation", label: "Restore conversation" },
	{ value: "code", label: "Restore code" },
] as const;

export type RestoreMode = (typeof MODES)[number]["value"];
