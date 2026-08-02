/**
 * The workflow status panel and the plain-text /workflows report.
 *
 * Pure string rendering: index.ts owns the widget lifecycle and tui.ts does the
 * themed drawing. The panel shows only what this process is running; the report
 * merges that with the run store, so runs from previous sessions are listed too.
 */
import { isAgentRecord, type JournalRecord } from "./journal.ts";
import { newProgress, type AgentRow, type RunProgress, type WorkflowRun } from "./runs.ts";
import { isSettled, unresumedInterrupted, type RunMeta } from "./store.ts";

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

/**
 * When a run started, in the shortest form that still tells two of them apart.
 *
 * Run ids are not displayed any more — `wf-mgk2j4l-1` is fourteen characters of
 * base36 in a line that gets truncated, and it says nothing you can act on. The
 * cost of dropping it is that five `code-review` runs all read `code-review`,
 * so something has to separate them, and when a run happened is the answer a
 * person actually wants. Clock time within the day, a date before that.
 */
export function startedLabel(startedAt: number, now: number): string {
	const started = new Date(startedAt);
	if (started.toDateString() !== new Date(now).toDateString()) {
		return started.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	return `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
}

/**
 * The runs `/workflows` will show: this session's, newest first.
 *
 * Everything the store holds is still on disk and still resumable by id — the
 * model is told about interrupted ones by name, and `show <id>` reads any of
 * them. This is a browsing filter, so the list is about the work in front of
 * you rather than fifty runs deep in history.
 *
 * `isLive` keeps a run this process is driving whatever its recorded session
 * id says. A session with no id (ephemeral, `--no-session`) would otherwise
 * watch its own fleet vanish from the panel the moment it started, since a run
 * with no sessionId can never match one.
 */
export function sessionRuns(
	metas: RunMeta[],
	sessionId: string | undefined,
	isLive: (runId: string) => boolean,
	cwd?: string,
): RunMeta[] {
	// Unresumed interrupted runs cross the session boundary. Scoping the panel
	// is a browsing convenience, but applied to these it hid the one row that
	// still had work owed on it — and `R resume run` is in this panel, so the
	// filter was removing the only way to reach the thing the notice was
	// telling the model to resume. Anything already resumed drops out again.
	//
	// They do NOT cross the PROJECT boundary. The store is global, so without a
	// cwd every repository's abandoned runs showed up in every other one, and
	// resuming one would have run its agents in the wrong tree.
	const owed = new Set(unresumedInterrupted(metas, cwd).map((meta) => meta.runId));
	return metas.filter(
		(meta) => isLive(meta.runId) || owed.has(meta.runId) || (sessionId !== undefined && meta.sessionId === sessionId),
	);
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
		// The run's name, not its id. This line sits directly under the prompt and
		// is clipped to the terminal width, so every character it spends has to
		// earn its place — and the id is not something you can do anything with
		// from here.
		`${statusMark(progress.status)} ${progress.name}`,
		phaseSummary(progress),
		running ? `${running} running` : undefined,
		progress.replayedCount > 0 ? `${progress.replayedCount} replayed` : undefined,
		// No running total. A live dollar figure under the prompt is a thing to
		// watch rather than read, and this line is clipped to the terminal width,
		// so it is spent on progress instead. `/usage` is where money lives; the
		// number itself is still accumulated and announced on `usage:spend`.
		formatElapsed(now - run.startedAt),
	];
	return parts.filter(Boolean).join("  ");
}

/** Widget lines for the active runs, or undefined to hide the panel. */
export function panelLines(active: WorkflowRun[], now: number): string[] | undefined {
	if (active.length === 0) return undefined;
	const lines = active.map((run) => runLine(run, now));
	// Gesture first: the statusline truncates this line and does not wrap, so the
	// key that needs no typing has to survive the clip. /workflows stays at the
	// tail — it is still the discoverable and scriptable way in.
	lines.push("  shift+↓ or /workflows to inspect, pause, resume or cancel");
	return lines;
}

/**
 * One line per run for `/workflows list`, newest first. Live runs report their
 * phase progress; stored ones report the totals run.json kept.
 *
 * The one surface that still prints run ids, and only at the end of the line.
 * This is the addressing report — the whole reason to type `/workflows list`
 * rather than open the panel is to find the id to pass to `show`, `pause` or
 * `cancel` — so removing it here would leave those subcommands with nothing to
 * name. The name still leads, which is the part you read.
 */
export function statusReport(metas: RunMeta[], live: Map<string, WorkflowRun>, now: number): string {
	if (metas.length === 0) return "No workflow runs in this session.";
	return metas
		.map((meta) => {
			const run = live.get(meta.runId);
			const tail = !isSettled(meta.status)
				? `${run ? phaseSummary(run.progress) : "in flight"} · ${formatElapsed(now - meta.startedAt)}`
				: `${meta.status} · ${meta.agentCount} agent${meta.agentCount === 1 ? "" : "s"} · ${formatElapsed((meta.endedAt ?? now) - meta.startedAt)}`;
			// Names the PARENT run, not this one. The hide-ids pass took the id out
			// of every row, but this one identifies a relationship rather than the
			// row itself — without it three rows all read "code-review (resumed)"
			// and the chain can only be reconstructed by running `show` on each.
			const resumed = meta.resumedFrom ? ` (resumed ${meta.resumedFrom})` : "";
			return `${statusMark(meta.status)} ${meta.name}${resumed} — ${tail} · ${startedLabel(meta.startedAt, now)}  [${meta.runId}]`;
		})
		.join("\n");
}

/**
 * Runs a previous session left behind. The store knows this as fact now (a
 * run.json whose owning pid is gone), so the model can be told precisely which
 * ids are dead and that each is resumable.
 */
export const NOTICE_MAX_STALE = 3;

export function interruptedNotice(interrupted: RunMeta[], stale: RunMeta[] = []): string | undefined {
	if (interrupted.length === 0 && stale.length === 0) return undefined;
	const parts: string[] = [];

	if (interrupted.length > 0) {
		const one = interrupted.length === 1;
		const ids = interrupted.map((meta) => meta.runId).join(", ");
		// Every id gets its own resume call. The previous wording listed all the
		// dead runs but only ever offered resumeFromRunId for the first, so a
		// session that lost three runs was told how to recover one of them.
		const calls = interrupted.map((meta) => `resumeFromRunId: "${meta.runId}"`).join(", then ");
		parts.push(
			`The background workflow${one ? "" : "s"} ${ids} did not survive the end of the previous session, so ${one ? "its result message will" : "their result messages will"} never arrive.`,
			`Do not keep waiting, and do NOT write a new workflow for the same work — resuming replays every agent that already succeeded and re-runs only the ones that failed, so it is both faster and cheaper than starting again.`,
			`Call workflow with ${calls}.`,
			// The escape hatch is kept, because a run for work the user has since
			// abandoned should not be resumed out of obedience — but it is stated
			// last and narrowly, where it was previously an equal-weight option and
			// the easier of the two to take.
			`Start over only if the work itself is no longer wanted.`,
		);
	}

	if (stale.length > 0) {
		// Capped, because this repeats every session until the run is resumed or
		// pruned, and an unbounded list would eventually be the longest thing in
		// the turn. The overflow is counted rather than dropped silently — a
		// truncated list that looks complete is worse than a long one.
		const shown = stale.slice(0, NOTICE_MAX_STALE);
		const calls = shown.map((meta) => `resumeFromRunId: "${meta.runId}"`).join(", ");
		const more = stale.length - shown.length;
		parts.push(
			`${interrupted.length > 0 ? "Also still" : "Still"} unresumed from an earlier session: ${shown
				.map((meta) => `${meta.name} (${meta.runId})`)
				.join(", ")}${more > 0 ? `, and ${more} older one${more === 1 ? "" : "s"} — see /workflows` : ""}.`,
			`${shown.length === 1 ? "It is" : "They are"} still resumable with ${calls}. Mention ${shown.length === 1 ? "it" : "them"} to the user only if it bears on what they are asking for now; otherwise leave ${shown.length === 1 ? "it" : "them"} alone.`,
		);
	}

	return parts.join(" ");
}
