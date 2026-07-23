/**
 * The workflow status panel: a widget above the editor while runs are active,
 * one line per run — phases, agent counts, spend, elapsed time — so a
 * background fleet is visible without blocking anything. Pure string
 * rendering; index.ts owns the widget lifecycle.
 */
import type { RunProgress, WorkflowRun } from "./runs.ts";

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function phaseSummary(progress: RunProgress): string {
	if (progress.phases.length === 0) return "starting…";
	return progress.phases
		.map((phase) => {
			const done = phase.agents.filter((agent) => agent.status === "done").length;
			const failed = phase.agents.filter((agent) => agent.status === "failed").length;
			return `${phase.title} ${done}/${phase.agents.length}${failed ? `(${failed}✗)` : ""}`;
		})
		.join(" · ");
}

export function runLine(run: WorkflowRun, now: number): string {
	const progress = run.progress;
	const running = progress.phases.reduce(
		(count, phase) => count + phase.agents.filter((agent) => agent.status === "running").length,
		0,
	);
	const parts = [
		`◆ ${progress.runId} ${progress.name}`,
		phaseSummary(progress),
		running ? `${running} running` : undefined,
		`$${progress.usage.cost.toFixed(4)}`,
		formatElapsed(now - run.startedAt),
	];
	return parts.filter(Boolean).join("  ");
}

/** Widget lines for the active runs, or undefined to hide the panel. */
export function panelLines(active: WorkflowRun[], now: number): string[] | undefined {
	if (active.length === 0) return undefined;
	const lines = active.map((run) => runLine(run, now));
	lines.push(`  /workflows to inspect · /workflows cancel <id> to stop`);
	return lines;
}

/** One line per run for /workflows, newest first, finished runs included. */
export function statusReport(runs: WorkflowRun[], now: number): string {
	if (runs.length === 0) return "No workflows in this session.";
	return [...runs]
		.reverse()
		.map((run) => {
			const progress = run.progress;
			const mark =
				progress.status === "running" ? "◆" : progress.status === "done" ? "✓" : progress.status === "aborted" ? "◼" : "✗";
			const tail =
				progress.status === "running"
					? `${phaseSummary(progress)} · ${formatElapsed(now - run.startedAt)}`
					: `${progress.status} · ${progress.agentCount} agent${progress.agentCount === 1 ? "" : "s"} · $${progress.usage.cost.toFixed(4)}`;
			return `${mark} ${progress.runId} ${progress.name} — ${tail}`;
		})
		.join("\n");
}
