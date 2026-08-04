/**
 * Tunables for /goal.
 *
 * The values here are not arbitrary: each is the point where the behaviour stops
 * being useful, and the comment on each says which.
 */

export const CONFIG = {
	/**
	 * Maximum length of a goal condition. Longer ones are rejected outright rather
	 * than truncated: a silently clipped goal is judged against something the user
	 * never wrote.
	 */
	maxConditionChars: 4000,

	/**
	 * Words that mean "clear the goal" instead of "set this as the goal", matched
	 * case-insensitively against the trimmed argument. Only `clear` is advertised in
	 * the argument hint; the rest are here because they are what people type.
	 */
	clearWords: new Set(["clear", "stop", "off", "reset", "none", "cancel"]),

	/**
	 * Fraction of the evaluator model's context window spent on transcript. Older
	 * messages are dropped first, since evidence that a goal was met is recent.
	 */
	transcriptBudgetFraction: 0.5,

	/**
	 * Budget fraction for the second attempt after the provider rejects the first
	 * as too long. One retry at half the budget, then the check reports an error.
	 */
	retryBudgetFraction: 0.25,

	/** Rough chars-per-token used to fit the transcript to the budget above. */
	charsPerToken: 4,

	/** Evaluator request timeout. A judge slower than this is not worth waiting for. */
	timeoutMs: 30_000,

	/**
	 * Minimum word count for an interactive prompt to spend `goal.autoCapture`'s
	 * one-shot extraction attempt. Deliberately not a classifier of "is this a
	 * real request" — that judgment is the extraction call's own job, and its
	 * prompt is explicitly told to return null for quick questions and chats.
	 * This only screens out messages too short to plausibly state a criterion at
	 * all ("hi", "thanks"), so the one shot per session is not spent on those
	 * before the message that actually opens work arrives.
	 */
	minCaptureWords: 4,

	/**
	 * Cap on the user message text sent to the auto-capture extraction call.
	 * Unlike the evaluator, this reads one message rather than a budgeted
	 * transcript (see judge.ts's extractCriteria), so a pasted spec or log dump
	 * as the first message must not turn a one-shot screening call into a
	 * transcript-sized bill. Longer text is truncated, not rejected outright:
	 * unlike a user-typed `/goal` condition, this is scanned for criteria, not
	 * stored verbatim, and a truncated scan that still finds "tests pass" is
	 * strictly better than skipping capture altogether.
	 */
	maxCaptureChars: 6_000,

	/**
	 * Stop re-prompting after this many not-met verdicts, counted over the goal's
	 * whole life rather than as a consecutive run — nothing resets the count, and
	 * a condition judged unmet twenty times is worth giving up on however those
	 * twenty were spread out.
	 *
	 * A runaway loop spends real money unattended, so this defaults to a finite
	 * number. Set `goal.maxIterations` to 0 to let a goal run until interrupted.
	 */
	maxIterations: 20,

	/** Visual lines shown before the goal panel collapses. Ctrl+O expands. */
	collapsedLines: 8,
};
