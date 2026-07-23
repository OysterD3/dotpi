/**
 * Session-mode state machine, mirroring Claude Code's ultra_effort attachment
 * cadence. Claude Code derives this by scanning message history for the last
 * enter/exit attachment; here the same outcomes are tracked as a counter:
 *
 *   - first user turn with the mode on        -> full "Ultracode is on" reminder
 *   - every 10th user turn after a reminder   -> sparse "still on" reminder
 *     (TURNS_BETWEEN_MAINTENANCE = 10)
 *   - first user turn after switching off     -> exit reminder, once, and only
 *     if an enter reminder was actually delivered
 *   - re-enabling before the exit reminder was delivered restores the previous
 *     state (in Claude Code the attachment history simply never changed)
 */
import { CONFIG } from "./config.ts";
import { ENTER_FULL, ENTER_SPARSE, EXIT } from "./reminders.ts";

export class UltracodeMode {
	private on = false;
	private announced = false;
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
			if (!this.announced) {
				this.announced = true;
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
			return EXIT;
		}
		return null;
	}

	/** Rebuild state when resuming a session whose branch is being replayed. */
	restore(state: { on: boolean; announced: boolean; turnsSinceReminder: number; exitPending: boolean }): void {
		this.on = state.on;
		this.announced = state.announced;
		this.exitPending = !state.on && state.exitPending;
		this.turnsSinceReminder = state.turnsSinceReminder;
	}
}
