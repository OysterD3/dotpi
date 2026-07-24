/**
 * Constants and settings for the elapsed-time extension.
 */
export const ENTRY_TYPE = "turn-duration";

export const SETTINGS_KEY = "elapsed";

export const CONFIG = {
	/**
	 * How often the working message is rewritten. The text only changes once a
	 * second below a minute (formatDuration floors), so a faster tick would
	 * repaint without saying anything new.
	 */
	tickMs: 1000,
	/** pi's own default text; the timer is appended to it. */
	workingMessage: "Working...",
	/**
	 * Claude Code's past-tense verb pool for the end-of-turn line, verbatim.
	 * One is drawn per turn.
	 */
	verbs: ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"] as const,
} as const;

export interface ElapsedSettings {
	/** The live counter next to the spinner. */
	workingTimer: boolean;
	/** Claude Code's settings key of the same name: the end-of-turn line. */
	showTurnDuration: boolean;
	/**
	 * Skip the end-of-turn line for turns shorter than this, in ms. Claude Code
	 * has no threshold; 0 matches it, and a few seconds keeps quick exchanges
	 * from accumulating noise.
	 */
	minTurnMs: number;
}

export const DEFAULT_SETTINGS: ElapsedSettings = {
	workingTimer: true,
	showTurnDuration: true,
	minTurnMs: 0,
};
