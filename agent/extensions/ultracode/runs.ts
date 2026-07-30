/**
 * Background workflow runs.
 *
 * The registry tracks what is in flight IN THIS PROCESS — controllers, pause
 * gates, the live progress the panel and the TUI draw. Durable facts live in
 * store.ts, and the two are kept in step: every status change is written to
 * run.json, every agent and log line to journal.jsonl. That split is what lets
 * `/workflows` show runs from previous sessions, and lets a run that died with
 * its session be resumed instead of merely apologised for.
 */
import type { AgentOptions } from "./engine.ts";
import { emptyUsage, type SpawnUsage } from "./spawn.ts";
import type { RunStatus } from "./store.ts";

export interface AgentRow {
	index: number;
	label: string;
	status: "running" | "done" | "failed" | "replayed";
	phase?: string;
	model?: string;
	agentType?: string;
	startedAt: number;
	endedAt?: number;
	error?: string;
	usage?: SpawnUsage;
	/** The agent's own pi session file — the transcript /workflows can export. */
	sessionFile?: string;
	options?: AgentOptions;
}

export interface RunProgress {
	runId: string;
	name: string;
	status: RunStatus;
	phases: Array<{ title: string; agents: AgentRow[] }>;
	logs: string[];
	agentCount: number;
	replayedCount: number;
	usage: SpawnUsage;
	error?: string;
	resumedFrom?: string;
}

export interface WorkflowRun {
	progress: RunProgress;
	controller: AbortController;
	gate: PauseGate;
	startedAt: number;
	/** Resolves once the run has fully settled and outcome is recorded. */
	settled: Promise<void>;
	/** This run's label on the spend channel — "code-review (16:01)". */
	spendDetail?: string;
	outcome?: { text: string; isError: boolean };
}

export function newProgress(runId: string, name: string): RunProgress {
	return {
		runId,
		name,
		status: "running",
		phases: [],
		logs: [],
		agentCount: 0,
		replayedCount: 0,
		usage: emptyUsage(),
	};
}

/**
 * A live pause. Parked agents resolve when the run is resumed or aborted — the
 * engine re-checks the abort signal on the way out, so an abort never leaves a
 * caller waiting on a run that is already dead.
 */
export class PauseGate {
	private paused = false;
	private waiters = new Set<() => void>();

	isPaused(): boolean {
		return this.paused;
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		this.release();
	}

	/** Wake everyone regardless of state; used on abort. */
	release(): void {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const wake of waiters) wake();
	}

	waiting(): number {
		return this.waiters.size;
	}

	async wait(signal: AbortSignal): Promise<void> {
		if (!this.paused || signal.aborted) return;
		await new Promise<void>((resolve) => {
			const wake = () => {
				this.waiters.delete(wake);
				signal.removeEventListener("abort", wake);
				resolve();
			};
			this.waiters.add(wake);
			signal.addEventListener("abort", wake, { once: true });
		});
	}
}

export type CancelOutcome = "cancelled" | "not-running" | "unknown";
export type PauseOutcome = "paused" | "resumed" | "already" | "not-running" | "unknown";

export class RunRegistry {
	private runs = new Map<string, WorkflowRun>();

	add(run: WorkflowRun): void {
		this.runs.set(run.progress.runId, run);
	}

	get(runId: string): WorkflowRun | undefined {
		return this.runs.get(runId);
	}

	all(): WorkflowRun[] {
		return [...this.runs.values()];
	}

	/** Runs this process is still driving, paused ones included. */
	active(): WorkflowRun[] {
		return this.all().filter((run) => run.progress.status === "running" || run.progress.status === "paused");
	}

	cancel(runId: string): CancelOutcome {
		const run = this.runs.get(runId);
		if (!run) return "unknown";
		if (run.progress.status !== "running" && run.progress.status !== "paused") return "not-running";
		// Release the gate first: a paused run must not sit parked forever
		// waiting for a resume that is never coming.
		run.gate.release();
		run.controller.abort();
		return "cancelled";
	}

	cancelAll(): number {
		let count = 0;
		for (const run of this.active()) {
			run.gate.release();
			run.controller.abort();
			count++;
		}
		return count;
	}

	/**
	 * Forget every run. Called when the session ends, because this registry means
	 * "in flight in this process for THIS session" — after a shutdown nothing in
	 * it is either. A run already settled has everything it knows on disk, so the
	 * panel keeps listing it; a run just cancelled settles through callbacks that
	 * hold their own references and persists itself on the way out.
	 *
	 * Without this a `/new` in the same process inherits the old session's runs,
	 * and anything totting up what the registry holds — the footer's run lines,
	 * the spend `/usage` reports — starts the fresh session already several
	 * dollars in.
	 */
	clear(): void {
		this.runs.clear();
	}

	// The GATE is the authority on whether a run is paused, not progress.status:
	// a pause is requested at once but only observed when an agent next reaches
	// the gate, so a run between agents (or with none at all) would otherwise
	// refuse to resume from a pause it had just accepted.
	pause(runId: string): PauseOutcome {
		const run = this.runs.get(runId);
		if (!run) return "unknown";
		if (run.progress.status !== "running" && run.progress.status !== "paused") return "not-running";
		if (run.gate.isPaused()) return "already";
		run.gate.pause();
		return "paused";
	}

	resume(runId: string): PauseOutcome {
		const run = this.runs.get(runId);
		if (!run) return "unknown";
		if (run.progress.status !== "running" && run.progress.status !== "paused") return "not-running";
		if (!run.gate.isPaused()) return "already";
		run.gate.resume();
		return "resumed";
	}
}

/** Every agent row of a run, flattened in index order. */
export function allAgents(progress: RunProgress): AgentRow[] {
	return progress.phases.flatMap((phase) => phase.agents).sort((a, b) => a.index - b.index);
}
