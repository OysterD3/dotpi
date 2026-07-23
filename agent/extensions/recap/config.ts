/**
 * Tunables for /recap.
 *
 * Values marked "Claude Code parity" are taken from the shipped Claude Code
 * binary (2.1.217) rather than documentation, so behaviour matches. The rest are
 * this port's own, and are called out as such.
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
	 * Manual `/recap` request timeout. Claude Code runs its recap with `maxTurns:1`
	 * and no explicit timeout; 30s matches what the goal evaluator uses.
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
	 * went idle to the next interactive input. Claude Code parity: its away
	 * threshold ($IS) is 300_000 ms. Claude Code measures real terminal blur;
	 * pi exposes no focus events, so this is wall-clock idle instead — see
	 * settings.ts and index.ts.
	 */
	idleThresholdMs: 300_000,

	/**
	 * Minimum user turns in the session before an auto-recap is worth making.
	 * Claude Code parity (BIS = 3): nothing to recap after one exchange.
	 */
	minUserTurns: 3,

	/**
	 * Minimum user turns since the last recap before making another automatically.
	 * Claude Code parity (UIS = 2): don't recap the same spot twice.
	 */
	minTurnsSinceLastRecap: 2,

	/**
	 * Whether auto-recap-on-return is on by default.
	 *
	 * NOT Claude Code parity — Claude Code defaults its away summary ON, but it
	 * has real focus detection and generates the recap proactively while you are
	 * away, so it costs nothing extra and is ready the instant you return. pi has
	 * neither, so an auto-recap here costs a model call and a few seconds in front
	 * of your own message every time you return after an idle gap. That is a real
	 * cost to opt into, so it defaults off. Enable with `recap.autoOnReturn: true`.
	 */
	autoOnReturnDefault: false,
};
