/**
 * The background shell runner and the in-process registry.
 *
 * Spawning follows pi's own bash tool where it matters and ultracode's
 * runShellCommand where the built-in falls short. Like the built-in: the shell
 * is resolved from settings (`shellPath`), falling back to /bin/bash then sh,
 * and `shellCommandPrefix` is prepended the way pi does (`prefix\ncommand`).
 * Like ultracode: the child gets its own process GROUP (`detached: true`) —
 * sh does not exec compound commands, so signalling the child pid alone kills
 * sh and leaves the real work running, holding the output pipes open forever.
 * Kill signals the group, SIGTERM first and SIGKILL after a grace period, so a
 * dev server gets to shut down its own children.
 *
 * What is deliberately NOT reused: pi's createLocalBashOperations. Its abort
 * path is an immediate SIGKILL of the whole tree — right for a cancelled
 * foreground command, wrong for "please stop my dev server".
 *
 * Shells die with the session (killAll on session_shutdown). A pi crash skips
 * that, which is what store.reconcile() is for.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { appendOutput, isSettled, writeMeta, type ShellMeta } from "./store.ts";

/** Who asked for the kill. Decides how (and whether) the exit is reported. */
export type KilledBy = "tool" | "panel" | "timeout" | "shutdown";

export interface ShellJob {
	meta: ShellMeta;
	child: ChildProcess | undefined;
	/** The model's bash_output cursor: byte offset into output.log already read. */
	readOffset: number;
	killedBy?: KilledBy;
	/**
	 * Silence the exit message for this shell: the exit is reaching the model
	 * another way (kill_shell watching it die reports it in its own result),
	 * or the session it belonged to is over and the next one must not hear
	 * about it. Suppression lives here rather than on killedBy because blame
	 * is first-wins and races: a kill_shell on a shell already dying of a
	 * timeout must still silence the duplicate.
	 */
	suppressExit?: boolean;
	/** Resolves when the process group is gone and the meta is final. */
	settled: Promise<void>;
}

export interface ShellConfig {
	shellPath?: string;
	commandPrefix?: string;
}

/** pi's shell resolution, minus the Windows arm this Mac will never take. */
export function resolveShell(shellPath: string | undefined): { shell: string; args: string[] } {
	if (shellPath) return { shell: shellPath, args: ["-c"] };
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: "sh", args: ["-c"] };
}

export interface StartRequest {
	agentDir: string;
	meta: ShellMeta;
	config: ShellConfig;
	/** Environment for the child; the caller mirrors the built-in's. Default: process.env. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Seconds, matching pi's bash tool. Undefined = no timeout. The caller
	 * validates range; anything non-finite or over Node's setTimeout ceiling
	 * is ignored here rather than silently becoming a 1ms timer.
	 */
	timeoutSeconds?: number;
	/** Called exactly once, after the meta has its final status on disk. */
	onExit: (job: ShellJob) => void;
}

export function startShell(request: StartRequest): ShellJob {
	const { agentDir, meta } = request;
	const { shell, args } = resolveShell(request.config.shellPath);
	const command = request.config.commandPrefix ? `${request.config.commandPrefix}\n${meta.command}` : meta.command;

	let resolveSettled: () => void;
	const job: ShellJob = {
		meta,
		child: undefined,
		readOffset: 0,
		settled: new Promise<void>((resolve) => {
			resolveSettled = resolve;
		}),
	};

	let child: ChildProcess;
	try {
		child = spawn(shell, [...args, command.replace(/\0/g, "")], {
			cwd: meta.cwd,
			env: request.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
	} catch (error) {
		// Synchronous spawn failure (bad shell path). Finalize without a child.
		appendOutput(agentDir, meta.shellId, `spawn failed: ${String(error)}\n`);
		meta.status = "failed";
		meta.exitCode = null;
		meta.endedAt = Date.now();
		writeMeta(agentDir, meta);
		queueMicrotask(() => {
			resolveSettled();
			request.onExit(job);
		});
		return job;
	}

	job.child = child;
	meta.pid = child.pid;
	writeMeta(agentDir, meta);

	child.stdout?.on("data", (data: Buffer) => appendOutput(agentDir, meta.shellId, data));
	child.stderr?.on("data", (data: Buffer) => appendOutput(agentDir, meta.shellId, data));

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const timeoutMs = (request.timeoutSeconds ?? 0) * 1000;
	if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= CONFIG.maxTimeoutMs) {
		timeoutTimer = setTimeout(() => killJob(job, "timeout"), timeoutMs);
		timeoutTimer.unref?.();
	}

	let finalized = false;
	const finalize = (code: number | null) => {
		if (finalized) return;
		finalized = true;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		meta.status = job.killedBy ? "killed" : code === 0 ? "done" : "failed";
		if (job.killedBy === "timeout") meta.timedOut = true;
		meta.exitCode = code;
		meta.endedAt = Date.now();
		writeMeta(agentDir, meta);
		resolveSettled();
		request.onExit(job);
	};

	// "close", not "exit": close waits for the output pipes to drain, so the
	// log is complete before the exit report reads its tail.
	child.on("close", (code) => finalize(code));
	child.on("error", (error) => {
		appendOutput(agentDir, meta.shellId, `spawn failed: ${String(error)}\n`);
		finalize(null);
	});

	return job;
}

/**
 * SIGTERM the process group now, SIGKILL it if still alive after the grace
 * period. Returns false when there was nothing left to signal. First killer
 * wins the blame: a timeout firing mid panel-kill must not relabel it.
 */
export function killJob(job: ShellJob, by: KilledBy): boolean {
	if (isSettled(job.meta.status)) return false;
	if (!job.killedBy) job.killedBy = by;
	const child = job.child;
	if (!child?.pid) return false;
	const group = (signal: NodeJS.Signals) => {
		try {
			process.kill(-child.pid!, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		}
	};
	group("SIGTERM");
	const hard = setTimeout(() => {
		// Gate on the JOB being unsettled, not on the leader's liveness: sh
		// often dies of the SIGTERM while a grandchild that traps it lives on
		// in the group, holding the pipes open — that survivor is exactly what
		// this rung is for, and kill(-pid) reaches the group as long as any
		// member remains. (The settled job check also keeps a recycled-pgid
		// SIGKILL from firing after a clean exit.)
		if (!isSettled(job.meta.status)) group("SIGKILL");
	}, CONFIG.killGraceMs);
	hard.unref?.();
	return true;
}

export type KillOutcome = "killed" | "not-running" | "unknown";

/**
 * Every shell this pi process started, running or settled, keyed by id.
 * Settled jobs stay listed so bash_output can drain their remaining output;
 * clear() on session_shutdown is what keeps /new from inheriting them.
 */
export class ShellRegistry {
	private readonly jobs = new Map<string, ShellJob>();

	add(job: ShellJob): void {
		this.jobs.set(job.meta.shellId, job);
	}

	get(shellId: string): ShellJob | undefined {
		return this.jobs.get(shellId);
	}

	all(): ShellJob[] {
		return [...this.jobs.values()].sort((a, b) => b.meta.startedAt - a.meta.startedAt);
	}

	running(): ShellJob[] {
		return this.all().filter((job) => !isSettled(job.meta.status));
	}

	kill(shellId: string, by: KilledBy): KillOutcome {
		const job = this.jobs.get(shellId);
		if (!job) return "unknown";
		if (isSettled(job.meta.status)) return "not-running";
		killJob(job, by);
		return "killed";
	}

	/** Kill every running shell. Returns how many were signalled. */
	killAll(by: KilledBy): number {
		let count = 0;
		for (const job of this.jobs.values()) {
			if (!isSettled(job.meta.status) && killJob(job, by)) count++;
		}
		return count;
	}

	clear(): void {
		this.jobs.clear();
	}
}
