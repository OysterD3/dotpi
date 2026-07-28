/**
 * Constants for the cmux permission notifier.
 *
 * The env-var names mirror the cmux-generated bridge (cmux-session.ts) exactly,
 * so a single `CMUX_PI_HOOKS_DISABLED=1` silences both, and neither does
 * anything when pi is running outside cmux.
 */

/** pi.events channel the permissions extension announces prompts on. */
export const ASK_CHANNEL = "permissions:ask";

/**
 * pi.events channel the ask-user extension announces questions on. Payload:
 * `{ active, question, header?, count, sessionId?, cwd? }`, with `active: false`
 * when the question closes.
 *
 * A question blocks on a human exactly as a permission prompt does, so it earns
 * the same treatment: without this, the one pi state most worth interrupting for
 * — the agent waiting on an answer in a pane you are not looking at — passed
 * silently, because the permissions extension is not involved in it at all.
 */
export const QUESTION_CHANNEL = "ask-user:asking";

/** Set to "1" to silence the cmux bridges. Same variable cmux's own file uses. */
export const DISABLE_ENV = "CMUX_PI_HOOKS_DISABLED";

/** Present only when pi is running inside a cmux surface; absent means no-op. */
export const SURFACE_ENV = "CMUX_SURFACE_ID";

/** Overrides the cmux binary, as in cmux's own bridge. */
export const BIN_ENV = "CMUX_PI_CMUX_BIN";

export const CONFIG = {
	/** cmux subcommand. Verified: the SUBCOMMAND decides handling, not the payload. */
	subcommand: "notification",
	/**
	 * Verified load-bearing: without this exact field cmux only shows an
	 * "Attention" banner and leaves the session marked running. With it, the
	 * session flips to needsInput and gets the bell chip.
	 */
	notificationType: "permission_prompt",
	/** cmux's wire vocabulary for this event. */
	hookEventName: "Notification",
	/** What cmux shows as the tool behind a question notification. */
	questionTool: "ask_user",
	/** Keep the banner to one readable line. */
	targetChars: 120,
	/** A notification must never delay the prompt; this only bounds the child. */
	timeoutMs: 5000,
} as const;
