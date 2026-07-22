export const CONFIG = {
	/**
	 * How long to wait for a server to finish `initialize`. Cold starts are slow —
	 * tsserver and gopls both load the whole project.
	 */
	initializeTimeoutMs: 30_000,
	/**
	 * How long to wait for diagnostics after opening a file.
	 *
	 * Diagnostics arrive as unsolicited `publishDiagnostics` notifications, so there is no
	 * response to await — the only options are "wait for the first publish" or "wait a
	 * bounded time". A clean file may legitimately never publish anything, which is why
	 * this must have a floor as well as a ceiling.
	 */
	diagnosticsTimeoutMs: 15_000,
	/**
	 * Keep listening this long after the first publish. Servers frequently send an empty
	 * batch first and the real errors a moment later, once analysis completes.
	 *
	 * This dominates warm latency: a re-check of an already-loaded project measured ~1.5s,
	 * almost all of it this wait. Lower it for snappier checks at the risk of missing a
	 * late batch.
	 */
	settleMs: 1200,
	/** Idle servers are shut down after this long to stop tsserver/gopls squatting on RAM. */
	idleShutdownMs: 10 * 60 * 1000,
	/** Files accepted in a single call. */
	maxFiles: 20,
	/** Diagnostics rendered per file before truncating. */
	maxDiagnosticsPerFile: 50,
	/** Visual lines shown before the tool output collapses. Ctrl+O expands. */
	collapsedLines: 12,
	/** Set true to see raw JSON-RPC traffic on stderr while debugging a server. */
	debug: false,
};
