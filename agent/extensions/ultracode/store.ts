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
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_STORE_DIR } from "./config.ts";
import { pruneWorktrees } from "./worktree.ts";
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
	/**
	 * The most agents in flight at once, and the turn count of the deepest
	 * single agent. Persisted because they are the two numbers that separate a
	 * fleet from a queue and a decomposed task from one agent grinding, and
	 * neither was recoverable from run.json before — only by hand-parsing
	 * journal timestamps. Absent on runs written before they were recorded.
	 */
	peakConcurrency?: number;
	deepestAgentTurns?: number;
	/**
	 * Worktree scopes this run left behind, with the branch holding the work.
	 *
	 * Persisted because the branches are RETAINED and the run's own result
	 * message is the only other place they are named — so a session that ends
	 * before you read it would leave committed work discoverable only by
	 * guessing at `git branch --list 'pi/wf/*'`.
	 */
	worktrees?: Array<{ name: string; branch: string; baseCommit: string; files: number }>;
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

/**
 * The pi session id for a SHARED session — one conversation that several
 * agent() calls continue in turn (`agent(p, { session: "explore" })`).
 *
 * Two constraints meet here. The id is a file name and a pi `--session-id`, so
 * it has to be sanitised; and it must be injective, because two script-level
 * names that collided would silently merge two chains into one transcript. A
 * slug alone is not injective ("my session" and "my-session" slug identically),
 * so the full name is hashed and appended. The slug is kept only so the file is
 * recognisable on disk.
 *
 * `-s` rather than `-a` keeps shared ids out of the agent-index namespace: an
 * agent named "1" must not land on the same file as agent index 1.
 */
export function sharedSessionId(runId: string, name: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24) || "session";
	const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
	return `${runId}-s${slug}-${digest}`;
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

/**
 * Interrupted runs that nothing has resumed yet — the work still owed.
 *
 * `reconcile` only reports runs it just marked, because it skips anything
 * already settled. That is right for "this died a moment ago", but it made the
 * notice a one-shot: a run that died and was not resumed in the very next
 * session was never mentioned again, and with `/workflows` scoped to the
 * current session it also left the panel. Its id survived only in run.json, on
 * disk, for a person to find by hand — while `R resume run` sat in the panel
 * unable to see it.
 *
 * A run counts as dealt with once some other run records it as a parent, which
 * is exactly what `resumedFrom` is written for. Aborted and errored runs are
 * deliberately excluded: the first was cancelled on purpose, and the second
 * already delivered its failure, with a resume hint, in the session that ran
 * it. Only an interrupted run's result message never arrived at all.
 */
export function unresumedInterrupted(metas: RunMeta[], cwd?: string): RunMeta[] {
	const resumed = new Set<string>();
	for (const meta of metas) {
		if (meta.resumedFrom) resumed.add(meta.resumedFrom);
	}
	return metas.filter(
		(meta) =>
			meta.status === "interrupted" &&
			!resumed.has(meta.runId) &&
			// Same project only. The run store is global — listRuns reads every
			// directory under ~/.pi/agent/workflow-runs — while a resume runs its
			// agents in the CURRENT session's cwd. Without this, an interrupted run
			// from one repository was advertised in every session in every other
			// repository, for good, and taking the hint would re-run that repo's
			// agents in the wrong tree. A meta with no cwd recorded is not matched
			// to anything rather than shown everywhere.
			(cwd === undefined || meta.cwd === cwd),
	);
}

/** Drop the oldest settled runs past `keep`. Active runs are never pruned. */
export function pruneRuns(agentDir: string, keep: number): void {
	const settled = listRuns(agentDir).filter((meta) => isSettled(meta.status));
	/** Projects whose git needs telling that a worktree directory has gone. */
	const orphanedIn = new Set<string>();
	for (const meta of settled.slice(keep)) {
		const dir = runDir(agentDir, meta.runId);
		// A run that opened worktree scopes registered them in the PROJECT's git,
		// not here. Deleting the directory out from under that leaves an entry
		// git reports as "prunable" and, worse, refuses to let anything reuse the
		// path: `worktree add` on it fails with "missing but already registered"
		// until someone prunes. Verified against a real repo.
		if (meta.cwd && existsSync(join(dir, "worktrees"))) orphanedIn.add(meta.cwd);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* leave it for the next prune */
		}
	}
	// After the directories are gone, so git sees them as missing. Best effort
	// and deliberately fire-and-forget: retention must not be able to fail, and
	// a stale registration is a nuisance rather than data loss. The scope
	// BRANCHES are untouched — they hold work, and pruning a run's bookkeeping
	// is not a decision to throw that away.
	for (const cwd of orphanedIn) void pruneWorktrees(cwd);
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
/**
 * The transcript pi wrote for one session id, or undefined.
 *
 * Takes the id rather than deriving it from (index, attempt): a shared-session
 * agent runs under `<runId>-s<slug>-<hash>`, not `<runId>-a<index>`, so
 * re-deriving it here searched for a filename pi never wrote and every chained
 * agent came back with no transcript at all — the /workflows row read
 * "session none" for exactly the agents whose accumulated conversation is the
 * point of the feature.
 */
export function sessionPathById(agentDir: string, runId: string, id: string): string | undefined {
	const dir = agentsDir(agentDir, runId);
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

/** The per-index transcript, for callers that have no session id to hand. */
export function agentSessionPath(agentDir: string, runId: string, index: number, attempt = 0): string | undefined {
	return sessionPathById(agentDir, runId, agentSessionId(runId, index, attempt));
}

export function ensureStore(agentDir: string): void {
	try {
		if (!existsSync(storeRoot(agentDir))) mkdirSync(storeRoot(agentDir), { recursive: true });
	} catch {
		/* best effort */
	}
}
