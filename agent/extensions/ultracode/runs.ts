/**
 * Background workflow runs. The tool starts a run and returns immediately;
 * the registry is the single source of truth for what is in flight — the
 * status panel, /workflows, cancellation, and session shutdown all act on it.
 */
import { emptyUsage, type SpawnUsage } from "./spawn.ts";

export interface AgentRow {
	label: string;
	status: "running" | "done" | "failed";
}

export interface RunProgress {
	runId: string;
	name: string;
	status: "running" | "done" | "error" | "aborted";
	phases: Array<{ title: string; agents: AgentRow[] }>;
	logs: string[];
	agentCount: number;
	usage: SpawnUsage;
	error?: string;
}

export interface WorkflowRun {
	progress: RunProgress;
	controller: AbortController;
	startedAt: number;
	/** Resolves once the run has fully settled and outcome is recorded. */
	settled: Promise<void>;
	outcome?: { text: string; isError: boolean };
}

export function newProgress(runId: string, name: string): RunProgress {
	return { runId, name, status: "running", phases: [], logs: [], agentCount: 0, usage: emptyUsage() };
}

/** How many finished runs /workflows still lists. */
const FINISHED_KEPT = 5;

/** Text of any branch entry shape, for scanning a resumed transcript. */
function entryText(entry: Record<string, any>): string {
	const content = entry.content ?? entry.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block: { text?: string }) => (typeof block?.text === "string" ? block.text : "")).join("\n");
	}
	return "";
}

/**
 * Run ids the transcript says were started in the background but never
 * reported a result. The registry is per-process, so after a resume these are
 * runs whose promised "workflow-result" message can never arrive — the model
 * would otherwise wait for it forever, having been told not to guess.
 */
export function orphanedRunIds(branch: Array<Record<string, any>>): string[] {
	const started: string[] = [];
	const resolved = new Set<string>();
	for (const entry of branch) {
		const text = entryText(entry);
		if (!text) continue;
		for (const match of text.matchAll(/started in the background \(id: (wf-\d+)\)/g)) {
			if (match[1]) started.push(match[1]);
		}
		for (const match of text.matchAll(/Workflow "[^"]*" \((wf-\d+)\) (?:finished|failed|was cancelled)/g)) {
			if (match[1]) resolved.add(match[1]);
		}
	}
	return [...new Set(started.filter((id) => !resolved.has(id)))];
}

export class RunRegistry {
	private runs = new Map<string, WorkflowRun>();
	private counter = 0;

	nextId(): string {
		return `wf-${++this.counter}`;
	}

	add(run: WorkflowRun): void {
		this.runs.set(run.progress.runId, run);
		const finished = this.all().filter((r) => r.progress.status !== "running");
		for (const stale of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) {
			this.runs.delete(stale.progress.runId);
		}
	}

	get(runId: string): WorkflowRun | undefined {
		return this.runs.get(runId);
	}

	all(): WorkflowRun[] {
		return [...this.runs.values()];
	}

	active(): WorkflowRun[] {
		return this.all().filter((run) => run.progress.status === "running");
	}

	cancel(runId: string): "cancelled" | "not-running" | "unknown" {
		const run = this.runs.get(runId);
		if (!run) return "unknown";
		if (run.progress.status !== "running") return "not-running";
		run.controller.abort();
		return "cancelled";
	}

	cancelAll(): number {
		let count = 0;
		for (const run of this.active()) {
			run.controller.abort();
			count++;
		}
		return count;
	}
}
