/**
 * Active-goal state and its persistence.
 *
 * The goal has to survive `/resume`, so it is written to the session as a custom
 * entry. Custom entries do not enter LLM context, which is what we want: the
 * model learns about the goal from the instruction message, not from bookkeeping.
 *
 * Claude Code does the same thing with a `goal_status` attachment and recovers
 * state by scanning backwards for the most recent one. This mirrors that: the
 * newest entry wins, and it records cleared goals too so a clear is not undone
 * by replaying an older set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_ENTRY = "goal_state";

export type ActiveGoal = {
	condition: string;
	/** Not-met verdicts so far, i.e. how many times the goal has resumed work. */
	iterations: number;
	setAt: number;
	lastReason?: string;
};

/** What gets written to the session. `active: false` records a clear. */
export type GoalEntryData = {
	active: boolean;
	condition: string;
	iterations: number;
	setAt: number;
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
			setAt: typeof data.setAt === "number" ? data.setAt : Date.now(),
		};
	}
	return undefined;
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

	/** Adopt state recovered from a resumed session without re-persisting it. */
	adopt(goal: ActiveGoal | undefined): void {
		this.goal = goal;
	}

	set(condition: string): ActiveGoal {
		this.goal = { condition, iterations: 0, setAt: Date.now() };
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

	/** Clear the goal. Returns the condition that was active, if any. */
	clear(): ActiveGoal | undefined {
		const previous = this.goal;
		if (previous) {
			this.goal = undefined;
			this.persist(false, previous);
		}
		this.evaluating = false;
		return previous;
	}

	private persist(active: boolean, goal: ActiveGoal | undefined = this.goal): void {
		if (!goal) return;
		this.pi.appendEntry<GoalEntryData>(GOAL_ENTRY, {
			active,
			condition: goal.condition,
			iterations: goal.iterations,
			setAt: goal.setAt,
		});
	}
}
