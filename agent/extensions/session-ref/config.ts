/**
 * Limits and constants for session-ref.
 *
 * The numbers that matter are the context ones. A referenced session becomes a
 * custom MESSAGE entry — it enters LLM context and re-costs on every later
 * turn of this session — so the full-transcript path budgets against the
 * context that is actually left, not the window on paper, and always asks
 * first.
 */

/** customType of the injected message entry (and its renderer). */
export const MESSAGE_TYPE = "session-ref";

export const CONFIG = {
	/** The estimate used everywhere tokens are shown; recap uses the same. */
	charsPerToken: 4,

	/** Picker rows shown before the rest collapse into the search hint. */
	maxPickerRows: 15,

	/**
	 * How long a session listing is reused, in ms.
	 *
	 * `SessionManager.list` parses every session file and concatenates every
	 * message into one searchable string. The `#` provider is on the typing
	 * hot path, so without this it pays that per keystroke. Typing is bursty:
	 * a few seconds covers a whole query, and a session started mid-burst is
	 * not one you are about to reference.
	 */
	listCacheMs: 4_000,

	/**
	 * Share of the REMAINING context a full injection may fill. Not 1.0,
	 * because an injection that leaves no room for the next turn broke the
	 * session to exactly the degree it claimed to help it.
	 */
	fullBudgetFraction: 0.75,

	/** Above this share of remaining context, the confirm dialog turns severe. */
	heavyShareOfRemaining: 0.5,

	/**
	 * Fallback share of the model window when remaining context is unknowable
	 * (pi reports no usage estimate right after compaction).
	 */
	fallbackWindowFraction: 0.4,

	/**
	 * Floor for the full-mode budget, in tokens. When remaining context is
	 * near zero the fractional cap would inject a useless sliver; a confirmed
	 * full injection gets at least this much coherent tail instead, at the
	 * stated price of forcing compaction. The confirm dialog says so.
	 */
	minFullBudgetTokens: 2_000,

	/**
	 * The role tried for the summariser. Same policy as recap: a distillation
	 * is exactly the job role maps put on their cheapest model, and the
	 * session model stands in when no role map defines it (selectModel in
	 * model.ts).
	 */
	defaultModelRole: "cheap",

	/** Share of the SUMMARISER model's window its transcript input may take. */
	summaryTranscriptFraction: 0.5,

	/** Wall-clock ceiling for the summary call. Longer than recap's one-liner:
	 * a handoff summary reads a whole session and writes structured prose. */
	summaryTimeoutMs: 60_000,
};
