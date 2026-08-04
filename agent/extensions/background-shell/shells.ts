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
 * Shells die with the session (killAll on session_shutdown), and an exit hook
 * catches the paths that skip it. A pi killed outright skips both, and since
 * nothing is written to disk there is no record left for a later session to
 * reconcile — the orphaned group is simply out of reach.
 *
 * A shell's whole existence is this module's registry: the record, the child,
 * and its output ring. Nothing here touches the filesystem.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { OutputBuffer } from "./output.ts";

export type ShellStatus = "running" | "done" | "failed" | "killed";

/** One background shell's record. Lives in the registry and dies with the session. */
export interface ShellMeta {
	shellId: string;
	command: string;
	cwd: string;
	/** The child's pid — the process group leader, so kill(-pid) reaches everything. */
	pid: number | undefined;
	sessionId?: string;
	status: ShellStatus;
	startedAt: number;
	endedAt?: number;
	/** null means killed by signal rather than exiting on its own. */
	exitCode?: number | null;
	/** Set when the kill came from the tool call's timeout parameter. */
	timedOut?: boolean;
	/**
	 * Set once this shell's exit has actually reached the model — not merely
	 * been handed to sendMessage. A followUp queued mid-turn can be purged
	 * whole by an Escape/abort before the model ever sees it, so this stays
	 * false for that path at delivery time; only an idle delivery (which
	 * cannot be queued behind a live turn), a tool result that already
	 * narrated the exit itself (kill_shell, bash_output), or the
	 * before_agent_start handler may set it. before_agent_start sets it two
	 * ways: by finding this shell's followUp already persisted in the session
	 * branch as a delivered custom_message (proof it WAS drained and seen —
	 * the common case), or, failing that, by its own reminder injection
	 * (spliced into the next turn unconditionally, never queued, so listing
	 * the shell there IS delivery). See index.ts's deliverExit and
	 * before_agent_start handler, and tools.ts's kill_shell/bash_output.
	 */
	exitAnnounced?: boolean;
}

/** Anything but running. */
export function isSettled(status: ShellStatus): boolean {
	return status !== "running";
}

let counter = 0;

/**
 * A sortable id: `sh-<base36 ms>-<base36 pid>-<counter>`. The pid component
 * keeps ids from colliding between concurrent pi sessions — they share no
 * store any more, but they do share a user reading two transcripts.
 */
export function newShellId(now: number = Date.now()): string {
	return `sh-${now.toString(36).padStart(9, "0")}-${process.pid.toString(36)}-${++counter}`;
}

/** Who asked for the kill. Decides how (and whether) the exit is reported. */
export type KilledBy = "tool" | "panel" | "timeout" | "shutdown";

export interface ShellJob {
	meta: ShellMeta;
	child: ChildProcess | undefined;
	/** Everything the shell has written, bounded to the last CONFIG.bufferBytes. */
	output: OutputBuffer;
	/** The model's bash_output cursor: bytes of the output stream already read. */
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
	/**
	 * Foreground-only: kill a command with no explicit `timeout` after this
	 * many ms of zero new output. 0 disables it. Read from settings.json's
	 * namespaced `backgroundShell` block (see settings.ts) — unlike
	 * shellPath/commandPrefix, an untrusted project's override is dropped
	 * rather than honoured. undefined here means "not set", and the default
	 * lives in CONFIG so tools.ts is the one place that falls back to it.
	 */
	foregroundIdleKillMs?: number;
}

/** pi's shell resolution, minus the Windows arm this Mac will never take. */
export function resolveShell(shellPath: string | undefined): { shell: string; args: string[] } {
	if (shellPath) return { shell: shellPath, args: ["-c"] };
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: "sh", args: ["-c"] };
}

export interface StartRequest {
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
	/** Called exactly once, after the meta has its final status. */
	onExit: (job: ShellJob) => void;
}

export function startShell(request: StartRequest): ShellJob {
	const { meta } = request;
	const { shell, args } = resolveShell(request.config.shellPath);
	const command = request.config.commandPrefix ? `${request.config.commandPrefix}\n${meta.command}` : meta.command;

	let resolveSettled: () => void;
	const job: ShellJob = {
		meta,
		child: undefined,
		output: new OutputBuffer(CONFIG.bufferBytes),
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
		job.output.append(`spawn failed: ${String(error)}\n`);
		meta.status = "failed";
		meta.exitCode = null;
		meta.endedAt = Date.now();
		queueMicrotask(() => {
			resolveSettled();
			request.onExit(job);
		});
		return job;
	}

	job.child = child;
	meta.pid = child.pid;

	child.stdout?.on("data", (data: Buffer) => job.output.append(data));
	child.stderr?.on("data", (data: Buffer) => job.output.append(data));

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
		// "killed" only when the process actually died of a signal. A kill can
		// lose the race: the process exits cleanly at the same moment a timeout
		// or kill_shell fires, the SIGTERM hits nothing, and the close event
		// then delivers a real exit code — that run completed and must not be
		// reported as killed, let alone "timed out", for succeeding.
		const bySignal = code === null;
		meta.status = job.killedBy && bySignal ? "killed" : code === 0 ? "done" : "failed";
		if (job.killedBy === "timeout" && meta.status === "killed") meta.timedOut = true;
		meta.exitCode = code;
		meta.endedAt = Date.now();
		resolveSettled();
		request.onExit(job);
	};

	// "close", not "exit": close waits for the output pipes to drain, so the
	// buffer is complete before the exit report reads its tail.
	child.on("close", (code) => finalize(code));
	child.on("error", (error) => {
		job.output.append(`spawn failed: ${String(error)}\n`);
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
 * Every shell this pi process started, running or settled, keyed by id — and,
 * with nothing on disk, the only place a shell exists at all.
 *
 * Settled jobs stay listed so bash_output can drain their remaining output;
 * clear() on session_shutdown is what keeps /new from inheriting them. Because
 * each one still holds its output ring, the oldest settled jobs beyond `retain`
 * are dropped as new shells arrive — the in-memory replacement for the disk
 * store's prune, and what bounds this registry to retain × bufferBytes.
 */
export class ShellRegistry {
	private readonly jobs = new Map<string, ShellJob>();

	constructor(private readonly retain: number = CONFIG.retainShells) {}

	add(job: ShellJob): void {
		this.jobs.set(job.meta.shellId, job);
		// Only an add can grow the map, so trimming here is enough to bound it.
		const settled = this.all().filter((entry) => isSettled(entry.meta.status));
		for (const stale of settled.slice(this.retain)) this.jobs.delete(stale.meta.shellId);
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
