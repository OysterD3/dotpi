/**
 * Constants for pointer.
 *
 * The host waits for the session to acknowledge a point, and the session
 * polls its inbox to find one — so `ackTimeoutMs` must stay a comfortable
 * multiple of `pollMs`, or a healthy session is reported as absent.
 */

/** customType of the delivered message entry (and its renderer). */
export const MESSAGE_TYPE = "pointer";

/** The native messaging host name Chrome looks up, and the manifest file stem. */
export const HOST_NAME = "com.pi.pointer";

export const CONFIG = {
	/** How often a session drains its own inbox. */
	pollMs: 500,

	/** How many points one tick hands over at most. */
	maxDrainPerTick: 8,

	/** How long the host waits for the session to acknowledge a point. */
	ackTimeoutMs: 4_000,

	/** How often the host looks for that acknowledgement. */
	ackPollMs: 100,

	/** How long the host gives `lsof` to name the dev server's directory. */
	lsofTimeoutMs: 2_000,

	/** Characters of a session id shown to the developer. */
	idChars: 8,
};
