/**
 * Constants and settings for the elapsed-time extension.
 */
export const ENTRY_TYPE = "turn-duration";

export const SETTINGS_KEY = "elapsed";

/**
 * pi.events channels announcing that the agent has stopped and is waiting on a
 * human. The clock stops for the duration: a turn's duration is meant to say how
 * long the *agent* worked, and the seconds someone spends deciding are not that.
 *
 * ask-user announces `{ active, blocking, … }` on both edges. `blocking` is what
 * separates a question the agent is stuck behind from the `/ask-user test` demo,
 * which puts the same prompt on screen while the agent carries on working —
 * pausing for that would subtract time the agent really did spend.
 *
 * permissions announces only the opening edge on `permissions:ask` (it predates
 * this) and the close on `permissions:answered`. Both are needed: with only the
 * open, the clock would stop and never restart.
 *
 * Declared here rather than imported from those extensions — each one stays
 * self-contained, as with the statusline's channels.
 */
export const ASK_CHANNEL = "ask-user:asking";
export const PERMISSION_CHANNEL = "permissions:ask";
export const PERMISSION_ANSWERED_CHANNEL = "permissions:answered";

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
