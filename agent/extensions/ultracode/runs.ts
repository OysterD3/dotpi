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
	/**
	 * "queued" is live-only: it means the engine has started this agent (a row
	 * exists, `startedAt` is set) but its spawn is still waiting on the process
	 * FairScheduler for a concurrency slot — see the pre/post flip around
	 * `scheduler.run` in tool.ts. It never appears in a journal (only "done",
	 * "failed" and "replayed" outcomes are ever written), so `progressFromJournal`
	 * never produces it — only a run this process is actively driving can be
	 * queued on ITS OWN scheduler.
	 */
	status: "running" | "queued" | "done" | "failed" | "replayed";
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
	/**
	 * The most agents that were ever in flight at once.
	 *
	 * Recorded because it is the number that distinguishes a fleet from a queue,
	 * and until now it could only be recovered by hand-parsing journal
	 * timestamps. A run with eight agents and a peak of 1 is eight agents that
	 * ran one after another — the shape that turned a 15-minute job into 53
	 * minutes here, and which looks identical to a healthy run in every other
	 * field we record.
	 */
	peakConcurrency: number;
	/** Turns used by the single deepest agent; a proxy for "one agent ground". */
	deepestAgentTurns: number;
	usage: SpawnUsage;
	error?: string;
	resumedFrom?: string;
}

export interface AgentTally {
	total: number;
	done: number;
	failed: number;
	replayed: number;
}

/**
 * Count how the agents actually ended, across every phase.
 *
 * A script decides for itself what a failed agent means — agent() returns null
 * and the script may legitimately carry on — so the SCRIPT completing says
 * nothing about whether the work happened. Five runs in this store finished
 * with every one of their agents dead (an ambiguous model reference killed each
 * on spawn) and were reported as "done", 0 turns, $0.00. The model, told a
 * workflow had succeeded, wrote a fresh one under a new name and paid for the
 * whole phase again — three and four times over for the same discovery.
 *
 * So the outcome is judged on the agents, not on the script returning.
 */
export function tallyAgents(progress: RunProgress): AgentTally {
	const tally: AgentTally = { total: 0, done: 0, failed: 0, replayed: 0 };
	for (const phase of progress.phases) {
		for (const agent of phase.agents) {
			tally.total++;
			if (agent.status === "failed") tally.failed++;
			else if (agent.status === "replayed") tally.replayed++;
			else if (agent.status === "done") tally.done++;
		}
	}
	return tally;
}

/**
 * True when the run had agents and every one of them failed.
 *
 * Deliberately not "any agent failed": a fan-out where one verifier of five
 * dies has still done its job, and failing the whole run would throw away four
 * good results. Total failure is the case that cannot be anything but a defect.
 */
export function allAgentsFailed(tally: AgentTally): boolean {
	return tally.total > 0 && tally.failed === tally.total;
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
		peakConcurrency: 0,
		deepestAgentTurns: 0,
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
