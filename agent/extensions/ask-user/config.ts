/**
 * Shared constants and types for the ask-user extension.
 *
 * ask_user is Claude Code's AskUserQuestion tool ported to pi: a tool the main
 * agent can call to pause and put a decision back to the human — with suggested
 * options, a free-form "Other" answer, an optional note on any answer, and a
 * decline path. Claude Code renders a bespoke multi-select component with an
 * in-dialog "press n to add a note" affordance; pi has no such component, so the
 * flow is composed from pi's own dialogs (select / input / confirm) and the note
 * is collected as a follow-up prompt (see interaction.ts).
 */

/** The tool name the model calls. Snake_case, as requested. */
export const TOOL_NAME = "ask_user";

/** settings.json key for the ask-user block. */
export const SETTINGS_KEY = "askUser";

export const CONFIG = {
	/** Option descriptions are trimmed to this in the selector row (the full text still reaches the model via the question context). */
	maxDescriptionChars: 72,
	/** Hard cap on how many options a single question may present (Claude Code allows 2-4; extra are dropped with a note). */
	maxOptions: 8,
} as const;

export interface AskUserSettings {
	/** Kill switch. Default true. When false the tool is not offered at all. */
	enabled: boolean;
	/**
	 * Whether to offer the optional "add a note" follow-up after an answer or a
	 * decline. Default true — this is the "yes with notes" / "decline with note"
	 * behavior. Set false to keep the flow to a single pick.
	 */
	allowNotes: boolean;
}

export const DEFAULT_SETTINGS: AskUserSettings = {
	enabled: true,
	allowNotes: true,
};
