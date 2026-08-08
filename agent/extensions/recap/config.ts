/**
 * Tunables for /recap.
 *
 * Each value below is the point where the behaviour stops being useful, and the
 * comment on each says which.
 */

/** Custom session-entry type a recap is stored under. Display-only, never in LLM context. */
export const ENTRY_TYPE = "recap";

export const CONFIG = {
	/**
	 * Fraction of the recap model's context window spent on the transcript it
	 * reads. The recap itself is one line, but a wider view makes a better recap.
	 * Older messages are dropped first, since a recap is about recent work.
	 */
	transcriptBudgetFraction: 0.5,

	/** Rough chars-per-token used to fit the transcript to the budget above. */
	charsPerToken: 4,

	/**
	 * Manual `/recap` request timeout. 30s matches what the goal evaluator uses;
	 * a summary slower than that is not worth waiting on.
	 */
	timeoutMs: 30_000,

	/**
	 * Auto-recap request timeout. Shorter than the manual one because it runs in
	 * front of the user's own message on return, and a recap is not worth making
	 * them wait long for. On timeout the message just proceeds without one.
	 */
	autoTimeoutMs: 12_000,

	/**
	 * Idle gap that counts as "stepped away", measured from when the agent last
	 * went idle to the next interactive input. Real terminal blur would be the
	 * better signal; pi exposes no focus events, so this is wall-clock idle
	 * instead — see settings.ts and index.ts.
	 */
	idleThresholdMs: 300_000,

	/**
	 * Minimum user turns in the session before an auto-recap is worth making.
	 * Nothing worth recapping after one exchange.
	 */
	minUserTurns: 3,

	/**
	 * Minimum user turns since the last recap before making another automatically.
	 * Don't recap the same spot twice.
	 */
	minTurnsSinceLastRecap: 2,

	/**
	 * Whether auto-recap-on-return is on by default.
	 *
	 * On, because a recap you have to configure first is a recap you never see —
	 * this ran for weeks without producing a single entry before that lesson
	 * landed. The cost of being on is a cheap-model call and a few seconds in
	 * front of your own message, and only after a genuine 5-minute absence with
	 * the other gates passed; the wait is bounded by autoTimeoutMs and any
	 * failure lets the message through untouched. Opt out with
	 * `recap.autoOnReturn: false`.
	 */
	autoOnReturnDefault: true,
};
