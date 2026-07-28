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
 * `ctx.ui.custom()` — a real focused component (overlay.ts) driving a pure state
 * machine (interaction.ts).
 */

/** The tool name the model calls. Snake_case, as requested. */
export const TOOL_NAME = "ask_user";

/** settings.json key for the ask-user block. */
export const SETTINGS_KEY = "askUser";

export const CONFIG = {
	/**
	 * Shown in the free-text row while it is empty. This row replaces the old
	 * "Other" entry: there is nothing to select and then be prompted by — the
	 * user simply types here.
	 */
	customPlaceholder: "Type my own answer",
	/** Hard cap on options per question (Claude Code allows 2-4; extra are dropped). */
	maxOptions: 8,
	/** Hard cap on questions per call (Claude Code allows 1-4). */
	maxQuestions: 4,
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
