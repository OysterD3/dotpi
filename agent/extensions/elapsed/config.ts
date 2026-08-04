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
	 * Replaces the working message while a question or permission ask is open.
	 * A frozen "Working... 4m 12s" and an open "Waiting on your answer...
	 * 4m 12s" are visually identical at a glance — the whole point of this row
	 * is to make the one moment the agent is NOT working, and IS waiting on the
	 * person reading it, look different from every other moment it is. "Answer",
	 * not "approval": the same open wait covers an ask-user question as much as
	 * a permission prompt, and a question is not something you approve.
	 */
	waitingMessage: "Waiting on your answer...",
	/** Past-tense verb pool for the end-of-turn line. One is drawn per turn. */
	verbs: ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"] as const,
} as const;

export interface ElapsedSettings {
	/** The live counter next to the spinner. */
	workingTimer: boolean;
	/** The end-of-turn line. */
	showTurnDuration: boolean;
	/**
	 * Skip the end-of-turn line for turns shorter than this, in ms. 0 reports every
	 * turn; a few seconds keeps quick exchanges from accumulating noise.
	 */
	minTurnMs: number;
	/**
	 * How long a question or permission ask may sit open before ctx.ui.notify()
	 * and a terminal bell escalate it, repeating at every further interval past
	 * that. 0 turns the alert off (the live row still changes; only the nag
	 * stops). Traced from a benchmark run where permission prompts sat
	 * unanswered for 10-17 minutes: the TUI's only sign of a pending ask was a
	 * frozen counter, indistinguishable from a long-running tool call, so
	 * nothing ever drew the person back to the terminal. Default of two minutes
	 * is long enough that a prompt answered promptly never nags, short enough
	 * that an abandoned one does not go unmentioned for a coffee break.
	 */
	waitAlertMs: number;
}

export const DEFAULT_SETTINGS: ElapsedSettings = {
	workingTimer: true,
	showTurnDuration: true,
	minTurnMs: 0,
	waitAlertMs: 120_000,
};
