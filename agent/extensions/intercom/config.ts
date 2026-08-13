/**
 * Constants for intercom.
 *
 * The numbers that matter are the two liveness ones. A peer is live because it
 * says so recently AND its process answers — a heartbeat alone survives a
 * SIGKILL, and a pid alone is recycled by the OS. `staleAfterMs` must stay a
 * comfortable multiple of `heartbeatMs`, or a session that is merely busy
 * disappears from its own peers' lists.
 */

/** customType of the delivered message entry (and its renderer). */
export const MESSAGE_TYPE = "intercom";

export const TOOL_PEERS = "intercom_peers";
export const TOOL_SEND = "intercom_send";
export const TOOL_ASK = "intercom_ask";

export const CONFIG = {
	/** How often a live session rewrites its presence file. */
	heartbeatMs: 5_000,

	/**
	 * Presence older than this is not live, whatever the pid says. Four missed
	 * heartbeats: a session pausing on a slow provider call must not vanish.
	 */
	staleAfterMs: 20_000,

	/** How often a session drains its own inbox. */
	pollMs: 1_500,

	/** How often a blocked ask looks for its answer. */
	askPollMs: 400,

	/** Default wall-clock ceiling on a blocked ask. */
	defaultAskTimeoutMs: 120_000,

	/** Ceiling on the ceiling: a tool blocked longer than this is a hang. */
	maxAskTimeoutMs: 600_000,

	/** Longest single message. A longer one is refused, not truncated. */
	maxMessageChars: 4_000,

	/**
	 * Longest one-line preview shown for a message. A summary is a courtesy, not
	 * the message, so an over-long one is cut rather than refused.
	 */
	maxSummaryChars: 80,

	/** Messages delivered per tick. The rest wait for the next one. */
	maxDrainPerTick: 20,

	/** Id characters shown to the model, and the shortest prefix worth typing. */
	idChars: 8,
};
