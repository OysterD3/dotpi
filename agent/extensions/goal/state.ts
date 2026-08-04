/**
 * Active-goal state and its persistence.
 *
 * The goal has to survive `/resume`, so it is written to the session as a custom
 * entry. Custom entries do not enter LLM context, which is what we want: the
 * model learns about the goal from the instruction message, not from bookkeeping.
 *
 * State is recovered by scanning backwards for the most recent entry: the newest
 * one wins, and cleared goals are recorded too, so a clear is not undone by
 * replaying an older set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_ENTRY = "goal_state";

export type ActiveGoal = {
	condition: string;
	/** Not-met verdicts so far, i.e. how many times the goal has resumed work. */
	iterations: number;
	/**
	 * When this *session* started working on the goal. Reset on restore, because
	 * the hours a session spends closed are not time the agent spent working —
	 * see elapsedMs and goalElapsed().
	 */
	setAt: number;
	/** Time already banked by earlier sessions, in ms. */
	elapsedMs: number;
	/**
	 * Context tokens at the moment the goal was set, or undefined when pi could
	 * not estimate them. The outcome line reports the difference.
	 */
	tokensAtStart?: number;
	/** The judge's reason from the most recent not-met verdict. */
	lastReason?: string;
};

/**
 * How long the agent has actually been working on this goal.
 *
 * `setAt` alone would count wall-clock across a `/resume`, so a goal set before
 * dinner reports "16h" the next morning next to a turn count and a token figure
 * that both measure work. Time is banked at each persist instead, which loses
 * only the stretch between the last write and the process exiting.
 */
export function goalElapsed(goal: ActiveGoal, now: number): number {
	return Math.max(0, goal.elapsedMs + (now - goal.setAt));
}

/** What gets written to the session. `active: false` records a clear. */
export type GoalEntryData = {
	active: boolean;
	condition: string;
	iterations: number;
	/** Total time banked up to this write; `setAt` is not persisted. */
	elapsedMs: number;
	tokensAtStart?: number;
	lastReason?: string;
};

type BranchEntry = { type: string; customType?: string; data?: unknown };

/** Recover the goal from a session branch, or undefined if none is active. */
export function restoreGoal(entries: BranchEntry[]): ActiveGoal | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;

		const data = entry.data as GoalEntryData | undefined;
		if (!data || typeof data.condition !== "string") return undefined;
		if (!data.active) return undefined;

		return {
			condition: data.condition,
			iterations: typeof data.iterations === "number" ? data.iterations : 0,
			// The clock restarts for this session; what earlier ones banked carries over.
			setAt: Date.now(),
			elapsedMs: typeof data.elapsedMs === "number" && data.elapsedMs >= 0 ? data.elapsedMs : 0,
			tokensAtStart: typeof data.tokensAtStart === "number" ? data.tokensAtStart : undefined,
			lastReason: typeof data.lastReason === "string" ? data.lastReason : undefined,
		};
	}
	return undefined;
}

/**
 * Context tokens spent since the goal was set, or undefined if that is unknowable.
 *
 * `getContextUsage()` reports how full the context is *now*, not what the goal
 * has cost in total, so a compaction mid-goal leaves the current reading below
 * the baseline. That difference is not zero spend — it is a number this reading
 * cannot produce, and printing "0 tokens" would claim the goal was free. The
 * segment is dropped instead.
 */
export function tokensSpent(
	goal: { tokensAtStart?: number },
	ctx: { getContextUsage(): { tokens: number | null } | undefined },
): number | undefined {
	const now = ctx.getContextUsage()?.tokens;
	if (goal.tokensAtStart === undefined || now === undefined || now === null) return undefined;
	const delta = now - goal.tokensAtStart;
	return delta >= 0 ? delta : undefined;
}

/**
 * The single source of truth for whether a goal is running.
 *
 * `evaluating` exists because `agent_end` can fire again while the evaluator's
 * own LLM call is still in flight. Without it, one goal could spawn overlapping
 * evaluations and duplicate follow-up messages.
 */
export class GoalState {
	private goal: ActiveGoal | undefined;
	private evaluating = false;

	/**
	 * Whether the condition needs to be re-asserted to the model on the next
	 * turn. Two events arm this, both in index.ts: `session_compact` (a
	 * compaction is free to summarize the goalSetInstruction message that first
	 * told the model about the check into prose with no directive weight), and
	 * a `session_start` that restores an active goal via restoreGoal (the model
	 * never sees the custom entry it is read from — see this file's header
	 * comment on why custom entries stay out of LLM context). The next
	 * `before_agent_start` consumes it exactly once, so a session hitting
	 * neither event never pays for it.
	 */
	private pendingReassertion = false;

	constructor(private readonly pi: ExtensionAPI) {}

	get(): ActiveGoal | undefined {
		return this.goal;
	}

	isEvaluating(): boolean {
		return this.evaluating;
	}

	beginEvaluation(): boolean {
		if (this.evaluating) return false;
		this.evaluating = true;
		return true;
	}

	endEvaluation(): void {
		this.evaluating = false;
	}

	/** Arm the reassertion. A no-op with no active goal: there is nothing to reassert. */
	markPendingReassertion(): void {
		if (this.goal) this.pendingReassertion = true;
	}

	/** Consume the flag. Always clears it, so a turn that reads it pays at most once. */
	consumePendingReassertion(): boolean {
		const pending = this.pendingReassertion;
		this.pendingReassertion = false;
		return pending;
	}

	/**
	 * Adopt state recovered from a resumed session without re-persisting it.
	 *
	 * Always clears any pending reassertion first: this call replaces the goal
	 * wholesale with a different session's state (or none), and a flag armed by
	 * whatever was active before belongs to a goal that, as far as this method
	 * is concerned, no longer exists. index.ts re-arms it right after, if the
	 * newly adopted goal warrants it.
	 */
	adopt(goal: ActiveGoal | undefined): void {
		this.pendingReassertion = false;
		this.goal = goal;
	}

	set(condition: string, tokensAtStart?: number): ActiveGoal {
		this.goal = { condition, iterations: 0, setAt: Date.now(), elapsedMs: 0, tokensAtStart };
		this.persist(true);
		return this.goal;
	}

	/** Record a not-met verdict. Returns the new iteration count. */
	recordMiss(reason: string): number {
		if (!this.goal) return 0;
		this.goal.iterations++;
		this.goal.lastReason = reason;
		this.persist(true);
		return this.goal.iterations;
	}

	/**
	 * Clear the goal. Returns the goal that was active, if any.
	 *
	 * Deliberately does NOT touch `evaluating`: an evaluation already in flight
	 * still owns the lock, and its own `finally` releases it. Clearing here would
	 * let the next `agent_end` start a second call alongside the first.
	 */
	clear(): ActiveGoal | undefined {
		const previous = this.goal;
		if (previous) {
			this.goal = undefined;
			// A goal that no longer exists has nothing to reassert; without this a
			// compaction just before `/goal clear` would reassert a condition the
			// user just turned off.
			this.pendingReassertion = false;
			this.persist(false, previous);
		}
		return previous;
	}

	private persist(active: boolean, goal: ActiveGoal | undefined = this.goal): void {
		if (!goal) return;
		this.pi.appendEntry<GoalEntryData>(GOAL_ENTRY, {
			active,
			condition: goal.condition,
			iterations: goal.iterations,
			elapsedMs: goalElapsed(goal, Date.now()),
			tokensAtStart: goal.tokensAtStart,
			lastReason: goal.lastReason,
		});
	}
}
