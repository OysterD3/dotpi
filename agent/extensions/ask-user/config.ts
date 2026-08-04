/**
 * Shared constants and types for the ask-user extension.
 *
 * ask_user is a tool the main agent calls to pause and put a decision back to
 * the human. One call may carry
 * several questions; each offers suggested options plus a free-text row, any
 * answer can be annotated with a note, and the user reviews everything before it
 * is sent.
 *
 * This needs a bespoke component with in-dialog key bindings. pi's
 * select/input/confirm dialogs cannot bind keys inside themselves, so this uses
 * `ctx.ui.custom()` — a real focused component (prompt.ts) driving a pure state
 * machine (interaction.ts).
 *
 * There is deliberately NO settings block and no off switch. An agent that asks
 * when a decision is genuinely the user's is not a preference to be tuned, it is
 * how the agent is supposed to behave, and every knob here was a way to end up
 * back where this started: a tool that exists and never gets used. The only
 * condition on it is a real user being present to answer, which is a fact about
 * the session rather than a choice. Everything below is a tunable — a cap, a
 * placeholder, a badge, a mutation threshold — not a switch.
 */

/** The tool name the model calls. Snake_case, as requested. */
export const TOOL_NAME = "ask_user";

/**
 * customType on the hidden message carrying the opening nudge. It marks the
 * entry in the session file, which is how a resumed session can tell that the
 * reminder already went out on an earlier turn.
 */
export const NUDGE_ENTRY_TYPE = "ask-user-nudge";

/**
 * customType on the hidden message carrying the compliance follow-up (see
 * CONFIG.followUp below and nudge.ts). Distinct from NUDGE_ENTRY_TYPE so the
 * two are told apart in the session file — one is the opening reminder, the
 * other is what fires when that reminder was read and ignored.
 */
export const FOLLOWUP_ENTRY_TYPE = "ask-user-followup";

/**
 * pi.events channel announcing that a question owns the prompt. Payload:
 * `{ active, blocking, question, header?, count, sessionId?, cwd? }` when it
 * opens, and `{ active: false, blocking }` when it is answered or dismissed.
 *
 * Three subscribers today, for three different reasons:
 *   - the statusline blanks itself while a question is up, so the question owns
 *     the bottom of the screen. This extension cannot do that itself —
 *     `ui.setFooter(undefined)` restores pi's *built-in* footer, so swapping and
 *     restoring here would retire another extension's footer for good.
 *   - cmux-notify raises the pane, because a question stops pi on a human just
 *     as a permission prompt does.
 *   - elapsed stops the turn clock, so a turn's duration keeps meaning how long
 *     the agent worked rather than how long someone took to decide.
 *
 * `blocking` is false for the `/ask-user test` demo: the prompt is on screen but
 * the agent is not stuck behind it. The two subscribers that act on "the agent
 * has stopped" honour it; the statusline does not, because the demo does own the
 * bottom of the screen either way.
 *
 * The payload carries the question and not merely the flag because a subscriber
 * that has to interrupt someone needs to say what for. Same decoupling ultracode
 * uses for its workflow lines — announce, and let the listener decide.
 */
export const ASK_CHANNEL = "ask-user:asking";

export const CONFIG = {
	/**
	 * Shown in the free-text row while it is empty. This row replaces the old
	 * "Other" entry: there is nothing to select and then be prompted by — the
	 * user simply types here.
	 */
	customPlaceholder: "Type my own answer",
	/**
	 * Badge on the option the model recommends. Kept short so it rides on the end
	 * of the label line rather than pushing the answer around, and glyph-led so it
	 * scans as a mark rather than as part of the answer text.
	 */
	recommendedBadge: "★ Recommended",
	/** Hard cap on options per question; extra are dropped. */
	maxOptions: 8,
	/** Hard cap on questions per call. */
	maxQuestions: 4,
	/**
	 * Rows kept for the conversation above the prompt. A tall question scrolls
	 * its option list rather than shoving the whole transcript off screen.
	 */
	screenReserve: 8,
	/** Row count assumed when the host cannot report one (tests, odd terminals). */
	assumedRows: 24,
	/**
	 * The opening nudge fires at most once in this many interactive turns.
	 * Guards against a session of successive task statements each pulling the
	 * same reminder in; the previous one is still in context and still applies.
	 */
	nudgeCooldownTurns: 8,
	/**
	 * The compliance follow-up: once the opening nudge has gone out, this is how
	 * many files may be created or edited with zero ask_user calls in between
	 * before a second, sharper reminder rides in. This is what closes the actual
	 * benchmark gap — a model that reads the opening nudge and keeps building
	 * regardless has no other checkpoint, and by the time it stops on its own
	 * the wrong guess is already load-bearing across every file it touched.
	 *
	 * A threshold, not a toggle, for the same reason nudgeCooldownTurns is one:
	 * tunable, but there is no value that turns it off, because a model that
	 * never checks back in is exactly the failure this exists to catch.
	 */
	followUp: {
		afterMutations: 5,
	},
} as const;
