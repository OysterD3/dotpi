/**
 * Time the turn spent waiting on the human, as a pure accumulator.
 *
 * The turn clock runs from agent_start to agent_settled, which is the right
 * span for "how long did the agent work" right up until the agent stops working
 * and asks *you* something. An ask_user question blocks inside a tool call, so
 * without this the count keeps climbing while nothing is happening, and both
 * the live "Working... 4m 12s" and the "✻ Cooked for 4m 20s" line end up
 * measuring how long you took to answer.
 *
 * Pure and clock-injected — index.ts passes Date.now() in — so the arithmetic
 * is testable without sleeping, the way duration.ts and render.ts are.
 */
export class WaitClock {
	/** Completed waits, in ms. */
	private waited = 0;
	/** When the open wait began, if a question is up. */
	private since: number | undefined;

	/** A question took the prompt at `now`. A second open is ignored. */
	open(now: number): void {
		if (this.since === undefined) this.since = now;
	}

	/** The question was answered or dismissed at `now`. A stray close is ignored. */
	close(now: number): void {
		if (this.since === undefined) return;
		this.waited += Math.max(0, now - this.since);
		this.since = undefined;
	}

	/**
	 * Everything waited so far, including a wait still in progress — which is
	 * what freezes the live counter rather than letting it catch up in a jump
	 * when the question closes.
	 */
	waitedBy(now: number): number {
		return this.waited + (this.since === undefined ? 0 : Math.max(0, now - this.since));
	}

	/**
	 * How long the wait open right now has lasted, or 0 when none is open.
	 *
	 * Distinct from waitedBy(): that is the turn's running total across every
	 * wait so far, which is exactly what must stay frozen while a question is
	 * up. This is the open wait's own clock, counting from when *this* prompt
	 * appeared — what the live "Waiting on your answer… Xs" row and the
	 * waitAlertMs notifier both need, so a second wait in the same turn is
	 * reported from zero rather than picking up where the first left off.
	 */
	openWaitMs(now: number): number {
		return this.since === undefined ? 0 : Math.max(0, now - this.since);
	}

	/** True while a question is up. */
	get waiting(): boolean {
		return this.since !== undefined;
	}

	/** Start of a new turn: nothing carried over from the last one. */
	reset(): void {
		this.waited = 0;
		this.since = undefined;
	}
}

/** Working time: wall clock since the turn began, less time spent on the human. */
export function workedMs(startedAt: number, now: number, waits: WaitClock): number {
	return Math.max(0, now - startedAt - waits.waitedBy(now));
}
