/**
 * The workflow status panel and the plain-text /workflows report.
 *
 * Pure string rendering: index.ts owns the widget lifecycle and tui.ts does the
 * themed drawing. The panel shows only what this process is running; the report
 * merges that with the run store, so runs from previous sessions are listed too.
 */
import { isAgentRecord, type JournalRecord } from "./journal.ts";
import { newProgress, type AgentRow, type RunProgress, type WorkflowRun } from "./runs.ts";
import { isSettled, type RunMeta } from "./store.ts";

/**
 * Rebuild a run's view from its journal, for runs this process is not driving
 * (finished ones, and ones a previous session left behind). Same shape the live
 * registry produces, so every renderer works on either without knowing which.
 */
export function progressFromJournal(meta: RunMeta, records: unknown[]): RunProgress {
	const progress = newProgress(meta.runId, meta.name);
	progress.status = meta.status;
	progress.agentCount = meta.agentCount;
	progress.usage = meta.usage;
	progress.error = meta.error;
	progress.resumedFrom = meta.resumedFrom;

	const phaseFor = (title: string): AgentRow[] => {
		let entry = progress.phases.find((phase) => phase.title === title);
		if (!entry) {
			entry = { title, agents: [] };
			progress.phases.push(entry);
		}
		return entry.agents;
	};

	for (const record of records as JournalRecord[]) {
		if (!record || typeof record !== "object") continue;
		if (record.kind === "phase") {
			phaseFor(record.title);
		} else if (record.kind === "log") {
			progress.logs.push(record.message);
		} else if (isAgentRecord(record)) {
			const status: AgentRow["status"] = record.replayed ? "replayed" : record.status === "done" ? "done" : "failed";
			if (status === "replayed") progress.replayedCount++;
			phaseFor(record.phase ?? "Agents").push({
				index: record.index,
				label: record.label,
				status,
				phase: record.phase,
				model: record.model,
				agentType: record.agentType,
				startedAt: record.startedAt,
				endedAt: record.endedAt,
				error: record.error,
				usage: record.usage,
				sessionFile: record.sessionFile,
			});
		}
	}
	for (const phase of progress.phases) phase.agents.sort((a, b) => a.index - b.index);
	return progress;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Agents that produced a result, replayed ones included. */
export function doneCount(agents: Array<{ status: string }>): number {
	return agents.filter((agent) => agent.status === "done" || agent.status === "replayed").length;
}

export function phaseSummary(progress: RunProgress): string {
	if (progress.phases.length === 0) return "starting…";
	return progress.phases
		.map((phase) => {
			const done = doneCount(phase.agents);
			const failed = phase.agents.filter((agent) => agent.status === "failed").length;
			return `${phase.title} ${done}/${phase.agents.length}${failed ? `(${failed}✗)` : ""}`;
		})
		.join(" · ");
}

export function statusMark(status: RunMeta["status"]): string {
	switch (status) {
		case "running":
			return "◆";
		case "paused":
			return "⏸";
		case "done":
			return "✓";
		case "aborted":
			return "◼";
		case "interrupted":
			return "⚡";
		default:
			return "✗";
	}
}

export function runLine(run: WorkflowRun, now: number): string {
	const progress = run.progress;
	const running = progress.phases.reduce(
		(count, phase) => count + phase.agents.filter((agent) => agent.status === "running").length,
		0,
	);
	const parts = [
		`${statusMark(progress.status)} ${progress.runId} ${progress.name}`,
		phaseSummary(progress),
		running ? `${running} running` : undefined,
		progress.replayedCount > 0 ? `${progress.replayedCount} replayed` : undefined,
		`$${progress.usage.cost.toFixed(4)}`,
		formatElapsed(now - run.startedAt),
	];
	return parts.filter(Boolean).join("  ");
}

/** Widget lines for the active runs, or undefined to hide the panel. */
export function panelLines(active: WorkflowRun[], now: number): string[] | undefined {
	if (active.length === 0) return undefined;
	const lines = active.map((run) => runLine(run, now));
	lines.push("  /workflows to inspect, pause, resume or cancel");
	return lines;
}

/**
 * One line per run for `/workflows list`, newest first. Live runs report their
 * phase progress; stored ones report the totals run.json kept.
 */
export function statusReport(metas: RunMeta[], live: Map<string, WorkflowRun>, now: number): string {
	if (metas.length === 0) return "No workflow runs recorded.";
	return metas
		.map((meta) => {
			const run = live.get(meta.runId);
			const tail = !isSettled(meta.status)
				? `${run ? phaseSummary(run.progress) : "in flight"} · ${formatElapsed(now - meta.startedAt)}`
				: `${meta.status} · ${meta.agentCount} agent${meta.agentCount === 1 ? "" : "s"} · $${meta.usage.cost.toFixed(4)} · ${formatElapsed((meta.endedAt ?? now) - meta.startedAt)}`;
			const resumed = meta.resumedFrom ? ` (resumed ${meta.resumedFrom})` : "";
			return `${statusMark(meta.status)} ${meta.runId} ${meta.name}${resumed} — ${tail}`;
		})
		.join("\n");
}

/**
 * Runs a previous session left behind. The store knows this as fact now (a
 * run.json whose owning pid is gone), so the model can be told precisely which
 * ids are dead and that each is resumable.
 */
export function interruptedNotice(interrupted: RunMeta[]): string | undefined {
	if (interrupted.length === 0) return undefined;
	const one = interrupted.length === 1;
	const ids = interrupted.map((meta) => meta.runId).join(", ");
	return [
		`The background workflow${one ? "" : "s"} ${ids} did not survive the end of the previous session, so ${one ? "its result message will" : "their result messages will"} never arrive.`,
		`Do not keep waiting. ${one ? "It is" : "They are"} resumable: call workflow with resumeFromRunId: "${interrupted[0]!.runId}" to continue without re-running the agents that already succeeded, or start the work again if it is no longer needed.`,
	].join(" ");
}
