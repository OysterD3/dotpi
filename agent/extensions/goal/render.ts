/**
 * TUI rendering for /goal.
 *
 * Two surfaces, mirroring Claude Code:
 *   - the instruction messages that enter LLM context (set / not-met)
 *   - the terminal outcomes, which are display-only (met / impossible)
 *
 * Status wording is taken from Claude Code so the two feel the same to use.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ActiveGoal } from "./state.ts";

export type GoalMessageDetails = {
	kind: "set" | "not_met";
	condition: string;
	reason?: string;
	iterations?: number;
};

export type GoalResultDetails = {
	kind: "met" | "impossible" | "capped";
	condition: string;
	reason: string;
	iterations: number;
	durationMs: number;
};

/** Compact duration, e.g. "8s", "3m 20s", "1h 04m". */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;

	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Footer text while a goal is running. Claude Code shows "/goal active". */
export function statusText(goal: ActiveGoal | undefined): string | undefined {
	if (!goal) return undefined;
	return goal.iterations > 0 ? `/goal active (${goal.iterations})` : "/goal active";
}

/** Single-line summary for `/goal` with no arguments. */
export function summaryLine(goal: ActiveGoal | undefined): string {
	if (!goal) return "No goal set";

	const parts = [`${goal.iterations} iteration${goal.iterations === 1 ? "" : "s"}`];
	parts.push(formatDuration(Date.now() - goal.setAt));

	let line = `Goal active: ${goal.condition} (${parts.join(" · ")})`;
	if (goal.lastReason) line += `\n  ${goal.lastReason}`;
	return line;
}

export function renderGoalMessage(details: GoalMessageDetails, theme: Theme): Text {
	const lines: string[] = [];

	if (details.kind === "set") {
		lines.push(theme.fg("accent", theme.bold("● Goal set")));
		lines.push(theme.fg("text", details.condition));
		lines.push(theme.fg("dim", "/goal clear to stop early"));
	} else {
		const label = details.iterations ? `Goal not yet met… continuing (${details.iterations})` : "Goal not yet met… continuing";
		lines.push(theme.fg("warning", `● ${label}`));
		if (details.reason) lines.push(theme.fg("muted", details.reason));
	}

	return new Text(lines.join("\n"), 0, 0);
}

export function renderGoalResult(details: GoalResultDetails, theme: Theme): Text {
	const stats = `${details.iterations} iteration${details.iterations === 1 ? "" : "s"} · ${formatDuration(details.durationMs)}`;

	const heading =
		details.kind === "met"
			? theme.fg("success", theme.bold("● Goal achieved"))
			: details.kind === "impossible"
				? theme.fg("error", theme.bold("● Goal could not be achieved"))
				: theme.fg("warning", theme.bold("● Goal stopped: iteration limit reached"));

	const lines = [
		heading,
		theme.fg("dim", stats),
		theme.fg("text", details.condition),
		theme.fg("muted", details.reason),
	];

	if (details.kind === "met") {
		lines.push(theme.fg("dim", "/goal <condition> to set another"));
	}

	return new Text(lines.join("\n"), 0, 0);
}
