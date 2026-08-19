/**
 * Edit-streak nudge: how many consecutive main-session edit/write tool calls
 * have happened with no Workflow call between them.
 *
 * Two other mechanisms already tell the model to reach for a fleet — the
 * keyword's per-turn opt-in and /ultracode's standing cadence — and neither
 * watches whether it actually did. The measured failure ran through both:
 * "ultracode" opted in once, a workflow ran once, and then the model hand-
 * edited 69 files across 360 tool calls with nothing left to say otherwise —
 * keyword mode's tool description forbids un-opted-in workflow use, so once
 * the opt-in reminder decayed (index.ts's before_agent_start, mode.ts's
 * hasMessageSinceLastUserTurn), grinding alone was the only path the model's
 * own rules still allowed it to read. This counts the grind directly,
 * independent of which opt-in mechanism is standing, and says something at a
 * fixed multiple instead of staying silent for the rest of the session.
 *
 * The caller (index.ts) gates counting on "the opt-in is standing" — session
 * mode on, or a workflow already run this session — because a streak before
 * either has ever been true is just ordinary single-file work, not the
 * failure this watches for.
 */

/** Tool names that count as "hand-editing a file", matching the reminder's own wording. */
export const EDIT_STREAK_TOOLS = new Set(["edit", "write"]);

export class EditStreak {
	private count = 0;
	/** Nudges delivered so far in the current turn; the caller caps this. */
	private nudgesThisTurn = 0;

	current(): number {
		return this.count;
	}

	/** Call once per turn (before_agent_start) so the per-turn cap resets. */
	newTurn(): void {
		this.nudgesThisTurn = 0;
	}

	/** A Workflow call is delegated work, not solo grinding: the streak ends. */
	reset(): void {
		this.count = 0;
	}

	/**
	 * Record one edit/write call. Returns the streak length to report at every
	 * `threshold`th call, or null if this call is not one of them — or the
	 * turn has already delivered `maxPerTurn` nudges.
	 */
	recordEdit(threshold: number, maxPerTurn: number): number | null {
		this.count++;
		if (this.count % threshold !== 0 || this.nudgesThisTurn >= maxPerTurn) return null;
		this.nudgesThisTurn++;
		return this.count;
	}

	/** Rebuild the streak across a resume — see restoreEditStreak. */
	restore(count: number): void {
		this.count = count;
	}
}

/** Enough of a branch entry to read without importing SessionManager's types. */
interface ToolResultBranchEntry {
	type: string;
	message?: { role?: string; toolName?: string };
}

/**
 * Reconstruct the streak count and whether a workflow has ever run, from a
 * resumed session's branch. One linear scan, in order: a workflow tool result
 * resets the streak (mirroring EditStreak.reset()) and is remembered as proof
 * the opt-in this session is not hypothetical; every edit/write result
 * extends it; everything else (reads, greps, bash checks) leaves it alone —
 * looking at your own work between edits is not the same as delegating it.
 *
 * Reads RESULTS, not calls: a blocked or interrupted call never produced one,
 * and by the time a result exists the interesting moment (asking, or not) has
 * already passed either way. The live counter (index.ts's tool_call handler)
 * counts the call itself instead, for the reason the live path always had —
 * the model has already committed by the time it calls, so there is no reason
 * to wait for the result to count it live. The
 * two can disagree by an in-flight call at the exact moment of a crash; that
 * is the same gap store.ts's reconcile() already accepts for run state.
 */
export function restoreEditStreak(branch: ToolResultBranchEntry[], workflowToolName: string): { count: number; workflowRan: boolean } {
	let count = 0;
	let workflowRan = false;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const toolName = entry.message.toolName;
		if (toolName === workflowToolName) {
			workflowRan = true;
			count = 0;
		} else if (toolName !== undefined && EDIT_STREAK_TOOLS.has(toolName)) {
			count++;
		}
	}
	return { count, workflowRan };
}
