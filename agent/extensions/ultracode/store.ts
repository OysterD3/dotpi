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
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RUN_STORE_DIR } from "./config.ts";
import { SUBAGENT_PREAMBLE } from "./description.ts";
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

/**
 * The first run in a resume chain, which is the identity a worktree scope
 * belongs to.
 *
 * Every start allocates a fresh runId, resumes included, so scopes keyed on it
 * could never be reattached: a resumed run opened a brand-new empty scope,
 * every agent replayed from the journal without writing anything, and the empty
 * scope was then discarded — while the real work sat on the previous run's
 * branch with nothing pointing at it. Walking to the root makes a resume land
 * in the same place its parent did. Bounded, so a corrupted cycle cannot hang.
 */
export function rootRunId(agentDir: string, runId: string): string {
	let current = runId;
	for (let hops = 0; hops < 64; hops++) {
		const parent = readMeta(agentDir, current)?.resumedFrom;
		if (!parent || parent === current) return current;
		current = parent;
	}
	return current;
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

/** Path of the run's append-only journal. */
export function journalPath(agentDir: string, runId: string): string {
	return join(runDir(agentDir, runId), "journal.jsonl");
}

/** Append one JSON line. Journal writes are best-effort: never fail a run. */
export function appendJournalLine(agentDir: string, runId: string, record: unknown): void {
	try {
		appendFileSync(journalPath(agentDir, runId), `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		/* a store we cannot write must not take the run down */
	}
}

/** One thing an agent did, flattened for the live view. */
/**
 * How much of a transcript's end to read. Comfortably holds the `limit * 8`
 * records the parser looks at, while bounding a redraw to a fixed-size read no
 * matter how long the agent has been running.
 */
const ACTIVITY_TAIL_BYTES = 256 * 1024;

/** Per-block character bound before collapsing whitespace; see `flat`. */
const DETAIL_CHARS = 512;

export interface SessionEvent {
	kind: "text" | "thinking" | "tool";
	/** Tool name for "tool", otherwise empty. */
	name: string;
	/** A single line, already collapsed — the caller only truncates to width. */
	detail: string;
}

/**
 * The last few things an agent did, read from its live pi session file.
 *
 * This is what makes a running agent watchable. `/workflows` could previously
 * show only what the orchestrator knew — status, turn count, spend — which says
 * an agent is busy but never what it is busy WITH. The session file is a real
 * pi transcript being appended to as the child works, so tailing it is the
 * difference between a spinner and a monitor.
 *
 * Only the tail is READ, not merely parsed. These files reach megabytes on a
 * long agent and the panel re-renders on every turn, so slurping the whole
 * thing and then slicing would still put the cost of watching in proportion to
 * how long you have been watching — on the render path.
 */
export function sessionActivity(sessionFile: string, limit = 12): SessionEvent[] {
	let raw: string;
	/** Whether the read began mid-file, so line one is a fragment. */
	let clipped = false;
	let fd: number | undefined;
	try {
		fd = openSync(sessionFile, "r");
		const size = fstatSync(fd).size;
		const from = Math.max(0, size - ACTIVITY_TAIL_BYTES);
		const span = size - from;
		const buffer = Buffer.allocUnsafe(span);
		const got = readSync(fd, buffer, 0, span, from);
		// A byte offset can land inside a multi-byte character; the mojibake is
		// confined to the partial first line, which is dropped below anyway.
		raw = buffer.toString("utf8", 0, got);
		clipped = from > 0;
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const lines = raw.split("\n");
	// The first line is half a record when the read started mid-file.
	if (clipped) lines.shift();
	// Generous relative to `limit`: one assistant message can carry several
	// blocks, and a run of tool results can push the interesting text back.
	const tail = lines.slice(Math.max(0, lines.length - limit * 8));
	const events: SessionEvent[] = [];
	// Collapse only what could be displayed. A single block is routinely tens of
	// kilobytes — a reasoning trace, a file read back — and the caller truncates
	// to terminal width regardless, so running the whitespace regex over the
	// whole thing is work thrown away. The bound is far above any terminal width
	// so that leading indentation cannot eat the entire budget.
	const flat = (text: unknown) => String(text ?? "").slice(0, DETAIL_CHARS).replace(/\s+/g, " ").trim();
	/** Last resort for a tool whose arguments use none of the known names. */
	const firstString = (args: Record<string, unknown>) => {
		for (const value of Object.values(args)) if (typeof value === "string" && value.trim()) return value;
		return "";
	};

	for (const line of tail) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			// A torn final line is expected: the child is appending as we read.
			continue;
		}
		const message = entry?.message;
		if (entry?.type !== "message" || !message) continue;
		// Only what the agent itself produced is activity. A pi transcript stores
		// tool RESULTS as messages carrying the same content shape, so without
		// this every result's text renders as something the agent said — which is
		// precisely the drowning this view exists to avoid. The string branch
		// already checked the role; the array branch is where results actually
		// arrive, so it is the branch that needed it.
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") {
			const detail = flat(content);
			if (detail) events.push({ kind: "text", name: "", detail });
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content as Array<Record<string, unknown>>) {
			if (!part || typeof part !== "object") continue;
			if (part.type === "text") {
				const detail = flat(part.text);
				if (detail) events.push({ kind: "text", name: "", detail });
			} else if (part.type === "thinking") {
				const detail = flat(part.thinking);
				if (detail) events.push({ kind: "thinking", name: "", detail });
			} else if (part.type === "toolCall") {
				const args = (part.arguments ?? part.input) as Record<string, unknown> | undefined;
				// What the call is ABOUT, and the query outranks the scope: for a
				// search, `path` is usually "." or the repo root and says nothing
				// while the pattern is the entire point. The trailing fallback keeps
				// a tool that names its inputs anything else from rendering blank.
				const subject = args
					? flat(args.command ?? args.pattern ?? args.query ?? args.file_path ?? args.path ?? firstString(args))
					: "";
				events.push({ kind: "tool", name: String(part.name ?? "?"), detail: subject });
			}
		}
	}
	return events.slice(-limit);
}

export function readJournalLines(agentDir: string, runId: string): unknown[] {
	let raw: string;
	try {
		raw = readFileSync(journalPath(agentDir, runId), "utf8");
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

/** How much of a session file's head to read hunting for the opening user message. */
const PROMPT_HEAD_BYTES = 256 * 1024;

/** One block of a pi message's `content`, the shape that matters here. */
interface TextPart {
	type?: string;
	text?: unknown;
}

/** The text of a user message's content, string or array-of-parts alike. */
function userMessageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = (content as TextPart[])
		.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
	return text || undefined;
}

export interface AgentPromptLookup {
	/** The task text, preamble stripped. */
	text: string;
	/**
	 * True when `ordinal` asked for the k-th chained agent's own task but the
	 * head-bound scan (see PROMPT_HEAD_BYTES) found fewer preamble-bearing
	 * messages than that. `text` is then the LAST one the scan DID find — in
	 * practice almost always the chain's opening task, since a truncated scan
	 * nearly always means an earlier agent in the chain ran long enough to push
	 * everything after it past the bound — rather than the one this row
	 * actually ran. The caller must say so rather than passing it off as this
	 * agent's own prompt.
	 */
	isChainOpenerFallback: boolean;
}

/**
 * The task an agent was actually given, read from its own transcript.
 *
 * The store keeps only a HASH of the prompt (journal.ts's agentKey) — enough
 * for a resume to decide whether a cached result still applies, but not the
 * text itself. The text still exists in the agent's own session file,
 * prefixed with SUBAGENT_PREAMBLE (tool.ts prepends that to every subagent
 * prompt; see description.ts). Stripped here so a reader sees the task it was
 * given, not the boilerplate every agent gets.
 *
 * NOT simply "the first user message": a context-seeded agent (context.ts's
 * seedAgentSession) writes the forked context bundle as its FIRST user
 * message, with the task following as a LATER one — the preamble is what
 * every task turn carries and the bundle never does, so scanning for it is
 * what tells the two apart. Without this, a context-seeded agent's "prompt"
 * was thousands of lines of forked context rather than the one-line task.
 *
 * `ordinal` picks among MULTIPLE preamble-bearing messages, for a session
 * several agents share in turn (`agent(p, { session: "..." })` — see
 * "Shared sessions" in description.ts): the file then carries one such
 * message per agent, in the order they ran, and the caller (tui.ts's
 * promptFor) works out which position THIS row is. See
 * AgentPromptLookup.isChainOpenerFallback for what happens when the scan
 * cannot reach that far.
 *
 * Reads only the HEAD of the file, bounded, rather than the whole thing: the
 * messages this is hunting for are always near the top relative to how long
 * an agent's transcript eventually gets, and a long-running (or long-chained)
 * transcript can reach megabytes past them. A prompt so large the opening
 * message itself does not fit in the bound is the one case this gives up on
 * — rare enough, next to a normal task prompt, not to be worth a second
 * unbounded read on every miss.
 */
export function readAgentPrompt(sessionFile: string, ordinal = 0): AgentPromptLookup | undefined {
	let raw: string;
	let fd: number | undefined;
	try {
		fd = openSync(sessionFile, "r");
		const size = fstatSync(fd).size;
		const span = Math.min(size, PROMPT_HEAD_BYTES);
		const buffer = Buffer.allocUnsafe(span);
		const got = readSync(fd, buffer, 0, span, 0);
		raw = buffer.toString("utf8", 0, got);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}

	/** Every user message's text, in file order, so the fallback below can use the first one regardless of which (if any) carried the preamble. */
	let firstUser: string | undefined;
	/** Preamble-bearing messages only, stripped — one per agent that ran a task in this file. */
	const tasks: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			// A torn line is expected at the tail of a bounded read (or mid-write);
			// skip it rather than fail the whole lookup.
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = userMessageText(entry.message.content);
		if (!text) continue;
		if (firstUser === undefined) firstUser = text;
		if (text.startsWith(SUBAGENT_PREAMBLE)) tasks.push(text.slice(SUBAGENT_PREAMBLE.length));
	}

	if (tasks.length === 0) {
		// Nothing in the bound carried the preamble at all — a context-seeded
		// agent whose task turn has not landed yet, or a session this was never
		// written for. The first user message is the best available answer
		// either way; it is not treated as a chain-ordinal miss because there is
		// no chain to be behind on.
		return firstUser !== undefined ? { text: firstUser, isChainOpenerFallback: false } : undefined;
	}
	if (ordinal < tasks.length) return { text: tasks[ordinal]!, isChainOpenerFallback: false };
	return { text: tasks[tasks.length - 1]!, isChainOpenerFallback: true };
}

/** Substring that marks one tool-call block in a session file; see countToolCalls. */
const TOOL_CALL_MARKER = '"type":"toolCall"';

export interface ToolCallTally {
	/** Byte offset already scanned. */
	offset: number;
	/** Tool calls counted in [start, offset), where `start` is 0 unless `capped` — see below. */
	count: number;
	/**
	 * True once this file's FIRST tally started away from byte 0 because the
	 * file was already bigger than FIRST_TALLY_CAP_BYTES — a foreign transcript
	 * this process never tallied incrementally, seen for the first time already
	 * megabytes in. `count` is then a FLOOR ("at least this many"), not an exact
	 * total: calls before the start point are real but never counted, and stay
	 * uncounted for the life of this tally chain, since every later call resumes
	 * from `offset` rather than re-scanning the skipped head.
	 */
	capped: boolean;
}

/** Bytes requested per readSync call while filling the scan buffer below. */
const DEFAULT_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * How far into an already-large file the very first tally may start, so that
 * looking at a foreign run's transcript for the first time — already
 * megabytes long, since this process never tallied it incrementally — does
 * not put one giant synchronous read on the render path. See ToolCallTally.capped.
 */
const FIRST_TALLY_CAP_BYTES = 32 * 1024 * 1024;

/**
 * How many tool calls a session file has recorded so far, read incrementally.
 *
 * "Activity · last K of M tool calls" needs M, and M only grows while an agent
 * works — but the file backing it reaches megabytes, and the panel re-checks
 * on every tick that sees the size change. Re-parsing the whole file each time
 * would make the cost of watching grow with how long you have been watching,
 * on the render path (the same reasoning sessionActivity's tail-only read is
 * built on). Passing back the PREVIOUS tally lets the caller resume from where
 * it left off: only the bytes appended since are ever read, and a substring
 * scan for one marker is cheaper than parsing JSON to count the same thing.
 *
 * Not exact — a tool's own output happening to embed the literal marker text
 * would over-count by one — but this feeds a display counter, not a billed
 * figure, and a JSONL transcript containing `"type":"toolCall"` as prose in
 * its own content is rare enough not to guard against. A marker that straddles
 * the boundary between two calls (half in the bytes already scanned, half in
 * the newly appended ones) is undercounted by at most one for the same reason:
 * cheap over correct, for a number that is display-only and reaches into the
 * hundreds.
 *
 * A file smaller than the previous tally's offset (a schema retry starts a
 * fresh attempt under a new session id rather than truncating this one, so
 * this is defensive rather than expected) is treated as a different file:
 * state resets and the count restarts from 0 (or from FIRST_TALLY_CAP_BYTES
 * short of the end, same as any other first look — see `capped`).
 *
 * `readChunkBytes` is a parameter rather than baked into the read loop below
 * so a test can shrink it well under a real file's size and force the
 * multi-chunk path deterministically, without depending on the OS actually
 * handing back a short read to exercise it.
 */
export function countToolCalls(file: string, previous?: ToolCallTally, readChunkBytes = DEFAULT_READ_CHUNK_BYTES): ToolCallTally {
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		return previous ?? { offset: 0, count: 0, capped: false };
	}
	let from: number;
	let baseCount: number;
	let capped: boolean;
	if (previous && previous.offset <= size) {
		from = previous.offset;
		baseCount = previous.count;
		capped = previous.capped;
	} else {
		// No usable previous tally — either the very first look at this file, or
		// it shrank (see the doc comment above) and is treated as a new one.
		// Starting from the last FIRST_TALLY_CAP_BYTES rather than 0 is what
		// keeps that first look bounded; see `capped`.
		from = Math.max(0, size - FIRST_TALLY_CAP_BYTES);
		baseCount = 0;
		capped = from > 0;
	}
	if (from >= size) return { offset: size, count: baseCount, capped };
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const span = size - from;
		const buffer = Buffer.allocUnsafe(span);
		// readSync is not guaranteed to fill the whole request in one call — a
		// short read used to be scanned anyway, which ran the marker search over
		// whatever allocUnsafe happened to leave in the untouched tail of the
		// buffer. Loop until the full span is actually in hand (or the file
		// genuinely has no more to give, e.g. a race with a concurrent
		// truncate), reading at most `readChunkBytes` at a time.
		let read = 0;
		while (read < span) {
			const want = Math.min(readChunkBytes, span - read);
			const got = readSync(fd, buffer, read, want, from + read);
			if (got <= 0) break;
			read += got;
		}
		let count = baseCount;
		const scanned = buffer.subarray(0, read);
		let index = scanned.indexOf(TOOL_CALL_MARKER);
		while (index !== -1) {
			count++;
			index = scanned.indexOf(TOOL_CALL_MARKER, index + TOOL_CALL_MARKER.length);
		}
		// `from + read`, not `size`: a short read that stopped early is honestly
		// reported as scanned only that far, so the NEXT call resumes from where
		// scanning actually stopped rather than silently skipping the gap.
		return { offset: from + read, count, capped };
	} catch {
		return previous ?? { offset: 0, count: 0, capped: false };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function ensureStore(agentDir: string): void {
	try {
		if (!existsSync(storeRoot(agentDir))) mkdirSync(storeRoot(agentDir), { recursive: true });
	} catch {
		/* best effort */
	}
}
