/**
 * Wording and formatting for the newer stalled-turn surfaces: the
 * pending-tool-call sentinel (A) and the abort-recovery display entry (B).
 *
 * Kept pure and mostly theme-free, the way background-shell/render.ts does
 * it: the plain stdout warning, the ctx.ui.notify text, and the hidden
 * system-reminder are all asserted against directly by string comparison, so
 * none of them touch a theme. Only the TUI entry needs colour, and even that
 * stays a thin wrapper around plain lines (abortRecoveryLines) so the wording
 * itself stays testable independent of theme.fg.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Compound duration — "45m", "6h12m" — the same shape the benchmark
 * forensics wrote the gap in ("6h12m later"). Unlike goal's formatDuration
 * (single largest unit, fine for a turn count), a pending call's age is the
 * whole point of the message, so minutes are never dropped once it runs past
 * an hour: "6h" alone would hide that the twelve minutes are also unaccounted
 * for.
 */
export function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${pad2(minutes % 60)}m`;
}

/** Wall-clock HH:MM, local time — the units the benchmark's own timeline used ("14:47", "20:59"). */
export function formatClockTime(ms: number): string {
	const d = new Date(ms);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * The plain stdout line for session_shutdown (A.1), in the same voice as
 * pi's own "To resume this session:" hint — no theme, because it is written
 * with process.stdout.write after the TUI has already been torn down, and a
 * theme.fg call would have nothing left to colour.
 */
export function pendingCallShutdownWarning(toolName: string, elapsedMs: number): string {
	return `WARNING: closing with a ${toolName} call still pending (issued ${formatDuration(elapsedMs)} ago) — the turn stays blocked until this session is reopened and any prompt answered.`;
}

/** ctx.ui.notify text for the 60s pending-call sentinel sweep (A.2). */
export function pendingCallAlertText(toolName: string, elapsedMs: number): string {
	return `${toolName} call still running after ${formatDuration(elapsedMs)} — still waiting for its result.`;
}

/**
 * The hidden reminder attached when a pending call finally completes long
 * after it was issued (A.3): the model's last look at the world is however
 * old the gap is, and it needs telling before it reasons over that stale
 * picture as if it were current.
 */
export function staleResultReminder(toolName: string, startedAt: number, completedAt: number): string {
	return `The ${toolName} call you issued at ${formatClockTime(startedAt)} only executed at ${formatClockTime(completedAt)} — ${formatDuration(completedAt - startedAt)} later. Assume the workspace and any processes may have changed; re-verify state before building on this result.`;
}

/** Wrap a reminder the way pi's own hidden-message reminders are wrapped (matches ask-user/nudge.ts, ultracode/reminders.ts, background-shell/render.ts). */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Plain lines for the abort-recovery entry (B), asserted directly in tests —
 * colour is applied only by renderAbortRecovery below.
 *
 * Deliberately NOT an instruction to the model: this is appendEntry, not
 * sendMessage, so nothing here ever reaches LLM context. It exists purely to
 * tell the human, who pressed Escape to unstick a hung tool rather than to
 * abandon the task, that the task is still open and any message continues it
 * — never fight the user by resuming on their behalf.
 */
export function abortRecoveryLines(toolName: string): string[] {
	return [
		"● Task unfinished",
		`Escape stopped a stuck ${toolName} call, not the task — the work above is still unfinished.`,
		"Send any message to pick it back up where it left off.",
	];
}

export function renderAbortRecovery(toolName: string, theme: Theme): Text {
	const [heading, body, hint] = abortRecoveryLines(toolName);
	const lines = [theme.fg("warning", theme.bold(heading!)), theme.fg("text", body!), theme.fg("dim", hint!)];
	return new Text(lines.join("\n"), 0, 0);
}
