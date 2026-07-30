/**
 * The on-disk workflow run store.
 *
 * Everything a run knows lives under `<agentDir>/workflow-runs/<runId>/`:
 *
 *   run.json        run metadata — the row /workflows and the TUI list from
 *   journal.jsonl   append-only record of every agent, log, and phase
 *   script.js       the script verbatim, so a run can be re-read and resumed
 *   agents/         a pi --session-dir: one real session file per subagent
 *   agents/<n>.err  that subagent's full stderr
 *
 * Why on disk rather than the process map it used to be:
 *   - runs outlive the session that started them, so a resumed session can say
 *     what happened instead of scraping its own transcript for prose;
 *   - the journal is what makes resume possible at all (journal.ts);
 *   - the agents/ session dir is what makes a run debuggable — each subagent
 *     has a genuine pi session that `pi --export` renders like any other.
 *
 * Run ids are `wf-<base36 ms>-<counter>`: sortable, unique across processes,
 * and legal as a pi `--session-id` prefix (pi requires
 * /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/), which is how agent sessions
 * are named `<runId>-a<index>`.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_STORE_DIR } from "./config.ts";
import { emptyUsage, type SpawnUsage } from "./spawn.ts";

export type RunStatus = "running" | "paused" | "done" | "error" | "aborted" | "interrupted";

/** A run is finished when nothing more will happen to it in any process. */
export function isSettled(status: RunStatus): boolean {
	return status !== "running" && status !== "paused";
}

export interface RunMeta {
	runId: string;
	name: string;
	description?: string;
	status: RunStatus;
	cwd: string;
	/** Process that owns the run; used to spot runs a crash left behind. */
	pid: number;
	/**
	 * The pi session that started it. `/workflows` lists only the current
	 * session's runs, so this is what separates them. Absent on runs written
	 * before it was recorded, and on ephemeral sessions that have no id — both
	 * read as "not this session" (see sessionRuns in panel.ts, which keeps live
	 * runs regardless so an ephemeral session still sees its own fleet).
	 */
	sessionId?: string;
	startedAt: number;
	endedAt?: number;
	agentCount: number;
	usage: SpawnUsage;
	error?: string;
	/** The run this one replays, when it was started with resumeFromRunId. */
	resumedFrom?: string;
	/** Agents whose results were replayed from the journal rather than spawned. */
	replayedCount?: number;
	args?: unknown;
}

export function storeRoot(agentDir: string): string {
	return join(agentDir, RUN_STORE_DIR);
}

export function runDir(agentDir: string, runId: string): string {
	return join(storeRoot(agentDir), runId);
}

export function agentsDir(agentDir: string, runId: string): string {
	return join(runDir(agentDir, runId), "agents");
}

/**
 * The pi session id for one agent of a run; also its file name in agents/.
 * Schema retries get their own id: pi refuses to create a session file that
 * already exists, and each attempt deserves its own transcript anyway.
 */
export function agentSessionId(runId: string, index: number, attempt = 0): string {
	return attempt > 0 ? `${runId}-a${index}r${attempt}` : `${runId}-a${index}`;
}

let counter = 0;

/**
 * A sortable id unique across processes: `wf-<base36 ms>-<counter>`.
 *
 * The timestamp is zero-padded to a fixed width, because base36 of a smaller
 * number is a SHORTER string and short strings do not sort before long ones
 * ("rs" > "1kg"). Nine digits carry milliseconds past the year 5000.
 */
export function newRunId(now: number = Date.now()): string {
	return `wf-${now.toString(36).padStart(9, "0")}-${++counter}`;
}

/** Create the run directory tree and write the opening run.json + script. */
export function createRun(agentDir: string, meta: RunMeta, script: string): string {
	const dir = runDir(agentDir, meta.runId);
	mkdirSync(join(dir, "agents"), { recursive: true });
	writeFileSync(join(dir, "script.js"), script, "utf8");
	writeMeta(agentDir, meta);
	return dir;
}

/** Replace run.json atomically, so a reader never sees a half-written file. */
export function writeMeta(agentDir: string, meta: RunMeta): void {
	const dir = runDir(agentDir, meta.runId);
	try {
		mkdirSync(dir, { recursive: true });
		const temporary = join(dir, "run.json.tmp");
		writeFileSync(temporary, JSON.stringify(meta, null, 2), "utf8");
		renameSync(temporary, join(dir, "run.json"));
	} catch {
		/* a store we cannot write must not take the run down */
	}
}

export function readMeta(agentDir: string, runId: string): RunMeta | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(runDir(agentDir, runId), "run.json"), "utf8")) as RunMeta;
		if (!raw || typeof raw.runId !== "string") return undefined;
		return { ...raw, usage: { ...emptyUsage(), ...raw.usage } };
	} catch {
		return undefined;
	}
}

export function readScript(agentDir: string, runId: string): string | undefined {
	try {
		return readFileSync(join(runDir(agentDir, runId), "script.js"), "utf8");
	} catch {
		return undefined;
	}
}

/** Every stored run, newest first. Unreadable directories are skipped. */
export function listRuns(agentDir: string): RunMeta[] {
	let names: string[];
	try {
		names = readdirSync(storeRoot(agentDir));
	} catch {
		return [];
	}
	const runs: RunMeta[] = [];
	for (const name of names) {
		const meta = readMeta(agentDir, name);
		if (meta) runs.push(meta);
	}
	return runs.sort((a, b) => b.startedAt - a.startedAt);
}

/** True when a pid is still around. EPERM means someone else owns it — alive. */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Mark runs whose owning process is gone as interrupted. This replaces the old
 * transcript-scraping orphan detector: a run that was in flight when its
 * session died is now a fact on disk, and it can be resumed rather than only
 * apologised for. Runs owned by a live pid are left alone — that is another
 * pi session legitimately working.
 */
export function reconcile(agentDir: string): RunMeta[] {
	const interrupted: RunMeta[] = [];
	for (const meta of listRuns(agentDir)) {
		if (isSettled(meta.status) || pidAlive(meta.pid)) continue;
		const updated: RunMeta = { ...meta, status: "interrupted", endedAt: meta.endedAt ?? Date.now() };
		writeMeta(agentDir, updated);
		interrupted.push(updated);
	}
	return interrupted;
}

/** Drop the oldest settled runs past `keep`. Active runs are never pruned. */
export function pruneRuns(agentDir: string, keep: number): void {
	const settled = listRuns(agentDir).filter((meta) => isSettled(meta.status));
	for (const meta of settled.slice(keep)) {
		try {
			rmSync(runDir(agentDir, meta.runId), { recursive: true, force: true });
		} catch {
			/* leave it for the next prune */
		}
	}
}

// ------------------------------------------------------------------- journal

/** Append one JSON line. Journal writes are best-effort: never fail a run. */
export function appendJournalLine(agentDir: string, runId: string, record: unknown): void {
	try {
		appendFileSync(join(runDir(agentDir, runId), "journal.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		/* a store we cannot write must not take the run down */
	}
}

export function readJournalLines(agentDir: string, runId: string): unknown[] {
	let raw: string;
	try {
		raw = readFileSync(join(runDir(agentDir, runId), "journal.jsonl"), "utf8");
	} catch {
		return [];
	}
	const records: unknown[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A torn final line is expected when the process died mid-append.
		}
	}
	return records;
}

/** Path of one agent's stderr capture. */
export function agentErrorPath(agentDir: string, runId: string, index: number): string {
	return join(agentsDir(agentDir, runId), `${agentSessionId(runId, index)}.err`);
}

/** The session file pi writes for one agent, if it got far enough to make one. */
export function agentSessionPath(agentDir: string, runId: string, index: number, attempt = 0): string | undefined {
	const dir = agentsDir(agentDir, runId);
	const id = agentSessionId(runId, index, attempt);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	// pi names session files <timestamp>_<id>.jsonl.
	const match = names.find((name) => name.endsWith(`_${id}.jsonl`));
	return match ? join(dir, match) : undefined;
}

export function ensureStore(agentDir: string): void {
	try {
		if (!existsSync(storeRoot(agentDir))) mkdirSync(storeRoot(agentDir), { recursive: true });
	} catch {
		/* best effort */
	}
}
