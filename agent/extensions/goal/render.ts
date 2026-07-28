/**
 * TUI rendering for /goal.
 *
 * Two surfaces:
 *   - the instruction messages that enter LLM context (set / not-met)
 *   - the terminal outcomes, which are display-only (met / impossible)
 *
 * Counting note: a "turn" here is an *evaluation*, not a not-met verdict, which
 * is why the outcome line reports one more than the misses that preceded it —
 * the check that ends the goal is itself a turn.
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
	/** Context tokens spent since the goal was set, when pi could estimate them. */
	tokens?: number;
};

/**
 * Duration in its most significant unit only — "45s", "2m", "1h".
 *
 * A goal that took four and a half minutes reads "4m", not "4m 30s": the extra
 * precision is not useful next to a turn count, and it makes the line longer than
 * the heading it sits under.
 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	return `${Math.floor(minutes / 60)}h`;
}

const UNITS = [
	{ size: 1_000, suffix: "k" },
	{ size: 1_000_000, suffix: "M" },
	{ size: 1_000_000_000, suffix: "B" },
] as const;

/**
 * Token count in compact form: 940, 12.4k, 1.2M.
 *
 * The unit is chosen from the value *after* rounding, because rounding can push
 * it into the next one: 999,950 scales to "1000.0k", which has to print as "1M".
 */
export function formatTokens(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	if (n < UNITS[0].size) return `${n}`;

	let unit = UNITS[0];
	for (const candidate of UNITS) {
		if (n >= candidate.size) unit = candidate;
	}

	let scaled = Number((n / unit.size).toFixed(1));
	const next = UNITS[UNITS.indexOf(unit) + 1];
	if (scaled >= 1000 && next) {
		unit = next;
		scaled = Number((n / unit.size).toFixed(1));
	}

	return `${scaled}${unit.suffix}`;
}

/** English plural for a count. */
export function plural(count: number, word: string): string {
	return count === 1 ? word : `${word}s`;
}

/** Collapse to one line and cap, for a reason quoted back in a summary. */
export function oneLine(text: string, limit = 120): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Summary for `/goal` with no arguments: the condition, then either "not yet
 * evaluated" or the turn count, then the last judge's reason if there has been
 * one.
 */
export function summaryLine(goal: ActiveGoal | undefined): string {
	if (!goal) return "No goal set. Usage: `/goal <condition>`";

	const turns = goal.iterations === 0 ? "not yet evaluated" : `${goal.iterations} ${plural(goal.iterations, "turn")}`;
	const line = `Goal active: ${goal.condition} (${turns})`;
	return goal.lastReason ? `${line}\nLast check: ${oneLine(goal.lastReason.trim())}` : line;
}

/** The `duration · N turns · X tokens` stats printed beside an outcome. */
export function statsLine(details: Pick<GoalResultDetails, "durationMs" | "iterations" | "tokens">): string {
	const parts = [formatDuration(details.durationMs), `${details.iterations} ${plural(details.iterations, "turn")}`];
	if (details.tokens !== undefined) parts.push(`${formatTokens(details.tokens)} tokens`);
	return parts.join(" · ");
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
	const heading =
		details.kind === "met"
			? theme.fg("success", theme.bold("● Goal achieved"))
			: details.kind === "impossible"
				? theme.fg("error", theme.bold("● Goal could not be achieved"))
				: theme.fg("warning", theme.bold("● Goal stopped: iteration limit reached"));

	const lines = [
		heading,
		theme.fg("dim", statsLine(details)),
		theme.fg("text", details.condition),
		theme.fg("muted", details.reason),
	];

	if (details.kind === "met") {
		lines.push(theme.fg("dim", "/goal <condition> to set another"));
	}

	return new Text(lines.join("\n"), 0, 0);
}
