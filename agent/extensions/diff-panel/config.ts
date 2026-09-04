/**
 * Tunables for the diff panel.
 */
export const CONFIG = {
	/**
	 * Opens the panel from the editor; pressed again it hands the panel the
	 * keyboard, and inside the panel it closes it. shift+→ keeps the arrow
	 * family the other panels use — shift+↑ for background shells, shift+↓ for
	 * workflows — and points at where this one is: the right-hand half of the
	 * screen. It decodes as its own key (`\x1b[1;2C`), so nothing the editor
	 * binds is in the way. Claude Code's own shift+ctrl+d is pi-tui's debug
	 * key, which is why it is not that.
	 */
	key: "shift+right",
	/** How much of the terminal the panel takes. pi-tui resolves it per frame, so a resize follows. */
	width: "50%",
	/** Rows at the bottom of the screen the panel never covers: the editor and the footer. */
	bottomReserve: 8,
	/** Terminal height to assume when pi-tui cannot say. */
	assumedRows: 24,
	/** How often the working tree is re-read while the panel is up. */
	pollMs: 2000,
	/** Delay after a tool call finishes before re-reading, so a burst of edits costs one read. */
	settleMs: 250,
	/** A file bigger than this is listed but not diffed. */
	maxFileBytes: 1024 * 1024,
	/** Bytes searched for a NUL before a file is called binary — git's own heuristic. */
	binaryProbeBytes: 8000,
	/** Unchanged lines shown either side of a change; pi's default for edit diffs. */
	contextLines: 4,
	/** Longest a git command may run before it is treated as having failed. */
	gitTimeoutMs: 5000,
	/** Largest git output accepted, in bytes; `git show` of a big file needs it. */
	gitMaxBuffer: 16 * 1024 * 1024,
} as const;

/**
 * Announcements from ask-user and permissions. The panel hides while a
 * question is up: a question takes the editor's place at the bottom of the
 * screen, and the diff it is asking about sits in the chat under the panel.
 * Declared here rather than imported, so each extension stays self-contained.
 */
export const ASK_CHANNEL = "ask-user:asking";
export const PERMISSION_CHANNEL = "permissions:ask";
export const PERMISSION_ANSWERED_CHANNEL = "permissions:answered";
