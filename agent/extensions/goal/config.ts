/**
 * Tunables for /goal.
 *
 * Values marked "Claude Code parity" are taken from the shipped Claude Code binary
 * (2.1.217) rather than from documentation, so that behaviour matches.
 */

export const CONFIG = {
	/**
	 * Maximum length of a goal condition. Claude Code parity: it rejects longer
	 * conditions outright rather than truncating them.
	 */
	maxConditionChars: 4000,

	/**
	 * Words that mean "clear the goal" instead of "set this as the goal", matched
	 * case-insensitively against the trimmed argument. Claude Code parity: this is
	 * its exact set, even though only `clear` is documented in its argument hint.
	 */
	clearWords: new Set(["clear", "stop", "off", "reset", "none", "cancel"]),

	/**
	 * Fraction of the evaluator model's context window spent on transcript.
	 * Claude Code parity (its constant is 0.5). Older messages are dropped first.
	 */
	transcriptBudgetFraction: 0.5,

	/** Rough chars-per-token used to fit the transcript to the budget above. */
	charsPerToken: 4,

	/** Evaluator request timeout. Claude Code parity: 30s for prompt hooks. */
	timeoutMs: 30_000,

	/**
	 * Stop re-prompting after this many consecutive not-met verdicts.
	 *
	 * NOT Claude Code parity — it has no cap and relies on the user interrupting.
	 * A runaway loop here spends real money unattended, so this defaults to a
	 * finite number. Set to 0 to disable the cap and match Claude Code exactly.
	 */
	maxIterations: 20,

	/** Visual lines shown before the goal panel collapses. Ctrl+O expands. */
	collapsedLines: 8,
};
