/**
 * Ephemeral runtime state for the auto-recap path.
 *
 * Only two things need tracking, and neither belongs in the session:
 *
 *   lastIdleAt   when the agent last settled, so the idle gap can be measured on
 *                the next input. Reset on session start.
 *   generating   a reentrancy guard, so a recap already in flight is never
 *                started a second time (the manual command and an auto trigger
 *                could otherwise overlap).
 *
 * The recaps themselves are persisted — as display-only session entries — so
 * that "turns since last recap" survives a resume; that lives in gate.ts, read
 * straight off the branch. Nothing here needs to.
 */

export class RecapState {
	private lastIdleAt: number | undefined;
	private generating = false;

	/** Milliseconds since the agent last went idle, or undefined if it never has. */
	idleMs(now: number): number | undefined {
		return this.lastIdleAt === undefined ? undefined : now - this.lastIdleAt;
	}

	markIdle(now: number): void {
		this.lastIdleAt = now;
	}

	/** Reset on a new session; a fresh session has nothing to be "away" from. */
	reset(): void {
		this.lastIdleAt = undefined;
		this.generating = false;
	}

	begin(): boolean {
		if (this.generating) return false;
		this.generating = true;
		return true;
	}

	end(): void {
		this.generating = false;
	}

	isGenerating(): boolean {
		return this.generating;
	}
}
