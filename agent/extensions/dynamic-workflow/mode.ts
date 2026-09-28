/**
 * Session-mode state machine. The obvious implementation scans message history
 * for the last enter/exit marker; here the same outcomes are tracked as a
 * counter:
 *
 *   - first user turn with the mode on        -> full "Ultracode is on" reminder
 *   - every 10th user turn after a reminder   -> sparse "still on" reminder
 *     (TURNS_BETWEEN_MAINTENANCE = 10)
 *   - first user turn after switching off     -> exit reminder, once, and only
 *     if an enter reminder was actually delivered
 *   - re-enabling before the exit reminder was delivered restores the previous
 *     state (nothing was delivered, so nothing needs undoing)
 *   - first user turn with the mode on after  -> full reminder again
 *     a compaction took the last one out of view
 */
import { CONFIG } from "./config.ts";
import { ENTER_FULL, ENTER_SPARSE, EXIT } from "./reminders.ts";

export class UltracodeMode {
	private on = false;
	private announced = false;
	/** Announced, but a compaction has since taken the reminder out of view. */
	private outOfView = false;
	private exitPending = false;
	private turnsSinceReminder = 0;

	isOn(): boolean {
		return this.on;
	}

	enable(): void {
		if (this.on) return;
		this.on = true;
		if (this.exitPending) {
			// The off-state was never surfaced to the model; resume as if
			// nothing happened rather than re-announcing.
			this.exitPending = false;
			return;
		}
		this.announced = false;
		this.outOfView = false;
		this.turnsSinceReminder = 0;
	}

	disable(): void {
		if (!this.on) return;
		this.on = false;
		this.exitPending = this.announced;
	}

	/**
	 * Call once per user turn that reaches the model. Returns the reminder text
	 * to attach to that turn, or null.
	 */
	reminderForTurn(): string | null {
		if (this.on) {
			if (!this.announced || this.outOfView) {
				this.announced = true;
				this.outOfView = false;
				this.turnsSinceReminder = 0;
				return ENTER_FULL;
			}
			this.turnsSinceReminder++;
			if (this.turnsSinceReminder >= CONFIG.turnsBetweenMaintenance) {
				this.turnsSinceReminder = 0;
				return ENTER_SPARSE;
			}
			return null;
		}
		if (this.exitPending) {
			this.exitPending = false;
			this.announced = false;
			this.outOfView = false;
			return EXIT;
		}
		return null;
	}

	/**
	 * A compaction folded the last reminder into its summary (the caller checks
	 * that it was not in the kept tail), so the model can no longer see that
	 * the mode is on — and the tool description forbids a workflow without
	 * that. The next turn with the mode on announces again, including a turn
	 * after re-enabling before a pending exit went out. `announced` is left
	 * alone: it also means an exit notice is owed on off, and the summary may
	 * still say the mode is on.
	 */
	reminderOutOfView(): void {
		if (this.announced) this.outOfView = true;
	}

	/** Rebuild state when resuming a session whose branch is being replayed. */
	restore(state: { on: boolean; announced: boolean; outOfView: boolean; turnsSinceReminder: number; exitPending: boolean }): void {
		this.on = state.on;
		this.announced = state.announced;
		this.outOfView = state.announced && state.outOfView;
		this.exitPending = !state.on && state.exitPending;
		this.turnsSinceReminder = state.turnsSinceReminder;
	}
}

/**
 * True when a message of the given customType appears in the branch more
 * recently than the last real user prompt — a "message" entry whose role is
 * "user"; every reminder this extension injects rides in as role "custom"
 * instead, so those never trip the scan.
 *
 * This exists because a background workflow's result is delivered via
 * pi.sendMessage's triggerTurn or followUp options, and BOTH bypass the one
 * call site that fires before_agent_start: agent-session.js's `.prompt()`.
 * `sendCustomMessage`'s triggerTurn branch calls `_runAgentPrompt` directly,
 * and the followUp branch just queues onto the turn already running — neither
 * reaches `.prompt()`. So the turn that reacted to the result never got a
 * before_agent_start pass of its own, and never carried a keyword or mode
 * reminder either. This is how the NEXT real turn can tell one happened since
 * the user last typed anything, and treat itself as a continuation of an
 * opted-in task rather than a cold, unopted-in start.
 */
export function hasMessageSinceLastUserTurn(
	branch: Array<{ type: string; customType?: string; message?: { role?: string } }>,
	customType: string,
): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "custom_message" && entry.customType === customType) return true;
		if (entry.type === "message" && entry.message?.role === "user") return false;
	}
	return false;
}
