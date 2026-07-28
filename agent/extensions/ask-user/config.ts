/**
 * Shared constants and types for the ask-user extension.
 *
 * ask_user is Claude Code's AskUserQuestion tool ported to pi: a tool the main
 * agent calls to pause and put a decision back to the human. One call may carry
 * several questions; each offers suggested options plus a free-text row, any
 * answer can be annotated with a note, and the user reviews everything before it
 * is sent.
 *
 * Claude Code renders a bespoke component with in-dialog key bindings. pi's
 * select/input/confirm dialogs cannot bind keys inside themselves, so this uses
 * `ctx.ui.custom()` — a real focused component (prompt.ts) driving a pure state
 * machine (interaction.ts).
 */

/** The tool name the model calls. Snake_case, as requested. */
export const TOOL_NAME = "ask_user";

/** settings.json key for the ask-user block. */
export const SETTINGS_KEY = "askUser";

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
	/** Hard cap on options per question (Claude Code allows 2-4; extra are dropped). */
	maxOptions: 8,
	/** Hard cap on questions per call (Claude Code allows 1-4). */
	maxQuestions: 4,
	/**
	 * Rows kept for the conversation above the prompt. A tall question scrolls
	 * its option list rather than shoving the whole transcript off screen.
	 */
	screenReserve: 8,
	/** Row count assumed when the host cannot report one (tests, odd terminals). */
	assumedRows: 24,
} as const;

export interface AskUserSettings {
	/** Kill switch. Default true. When false the tool is not offered at all. */
	enabled: boolean;
	/**
	 * Whether Tab attaches a note to the focused answer. Default true. A note no
	 * longer costs an extra prompt — it is typed inline — so turning this off
	 * only removes the affordance, it does not shorten the flow.
	 */
	allowNotes: boolean;
}

export const DEFAULT_SETTINGS: AskUserSettings = {
	enabled: true,
	allowNotes: true,
};
