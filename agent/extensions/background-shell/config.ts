/**
 * background-shell constants: the custom message type, the pi.events channels,
 * and the tunables.
 *
 * Channel strings are declared here rather than imported across extensions —
 * each one stays self-contained, the same way the statusline re-declares
 * ultracode's channels.
 */

/**
 * Custom message type for "a background shell exited". Sent via pi.sendMessage
 * so it reaches the model — a tool result is final once execute() resolves, so
 * a later exit can only arrive as a new message.
 */
export const RESULT_MESSAGE = "background-shell-exit";

/** Custom message type for the hidden reminders (interrupted shells, running shells). */
export const REMINDER_MESSAGE = "background-shell";

/**
 * pi.events channel carrying one footer line per running shell.
 * Payload: `{ lines: string[] | undefined }` — undefined means "none, clear it".
 * The statusline appends these below its own lines, the way it does ultracode's
 * run lines; this extension never draws into the footer itself.
 */
export const LINES_CHANNEL = "background-shell:lines";

/**
 * pi.events channel saying whether the shells panel is holding the editor's
 * slot. Payload: `{ active: boolean }`. Separate from LINES_CHANNEL for the
 * same reason ultracode splits them: "stand down, a panel owns the bottom of
 * the screen" is a different fact with a different lifetime than "here is what
 * to draw". The statusline cannot be blanked from here — `ui.setFooter(undefined)`
 * would restore pi's *built-in* footer and retire the custom one for the session.
 */
export const PANEL_OPEN_CHANNEL = "background-shell:panel-open";

/**
 * ask-user's announcement that a question is about to take the editor slot.
 * The panel closes itself on it: pi keeps no bookkeeping of an overlay:false
 * component, so a question would silently draw over the panel and its done()
 * would never fire.
 */
export const ASK_CHANNEL = "ask-user:asking";

export const CONFIG = {
	/**
	 * Grace between SIGTERM and SIGKILL on the process group. Long enough for a
	 * dev server to close sockets and child containers, short enough that "kill"
	 * still means now.
	 */
	killGraceMs: 5000,
	/**
	 * How long kill_shell waits for the group to actually die before returning
	 * anyway. killGraceMs plus a beat — past that the SIGKILL has been sent and
	 * there is nothing more waiting can add.
	 */
	killWaitCapMs: 7000,
	/** Output tail carried in the exit message. Enough to show why it exited. */
	exitTailBytes: 4096,
	exitTailLines: 20,
	/** How much of output.log the panel's detail view reads. */
	panelTailBytes: 65_536,
	/**
	 * Cap on one FILTERED bash_output read — the regex deserves the widest
	 * window, since matching lines may sit anywhere in it. A firehose that
	 * wrote more than this since the last check is skipped to its tail — the
	 * end is what you want from a shell, and truncateTail trims further to
	 * pi's usual 2000/50KB.
	 */
	readCapBytes: 2_000_000,
	/**
	 * Cap on an UNFILTERED bash_output read. truncateTail keeps at most 50KB
	 * anyway, so reading the full 2MB window would be decode work discarded
	 * on arrival; this is that cap plus slack, with the skip note covering
	 * whatever the smaller window leaves behind.
	 */
	unfilteredReadCapBytes: 65_536,
	/** Settled shell directories kept on disk, newest first. */
	retainShells: 30,
	/** Panel refresh tick. Elapsed times only change once a second. */
	tickMs: 1000,
	/** Footer-lines re-announce tick while shells are running. */
	linesTickMs: 2000,
	/** Running shells shown in the footer before "+N more". */
	footerShellLines: 3,
	/** Command text kept in ids' company: list rows, footer lines, messages. */
	commandPreview: 48,
	/**
	 * Node's setTimeout ceiling (2^31−1 ms), which pi's own bash tool also
	 * enforces. Anything above it would be clamped to 1ms and kill the shell
	 * instantly as "timed out".
	 */
	maxTimeoutMs: 2_147_483_647,
	/** Fallback terminal height when the TUI has not reported one. */
	assumedRows: 24,
	/** Rows left for the transcript above the panel, matching ultracode's panel. */
	screenReserve: 6,
} as const;
