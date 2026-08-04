/**
 * Tunables for the visual-reference verify gate.
 */
export const CONFIG = {
	/**
	 * Distinct file names kept for the follow-up message. The dirty COUNT is
	 * never capped — a session that touched fifty files still reports "50" — only
	 * the sample of names shown alongside it, so the message stays one line
	 * instead of growing without bound on a long session.
	 */
	fileListCap: 8,

	/**
	 * Follow-up nudges fired per session before the gate goes quiet. Mirrors
	 * goal.maxIterations's reasoning: a model that ignores two direct,
	 * evidence-bearing instructions to render is not a model a third nudge is
	 * going to reach, and nagging forever spends the user's money on a lost
	 * cause instead of just letting the agent stop.
	 */
	maxFollowUps: 2,
} as const;
