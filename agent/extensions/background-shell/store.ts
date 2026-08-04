/**
 * The on-disk shell store: `<agentDir>/background-shells/<shellId>/` holding
 * `shell.json` (metadata) and `output.log` (stdout+stderr, interleaved as they
 * arrived — the same stream a terminal would have shown).
 *
 * The store exists for three reasons. Output has to live somewhere unbounded —
 * a dev server can log for hours, and keeping that in memory on the render
 * path is how a footer ends up costing what the server does. The model's
 * bash_output reads are cursor-based over the same file, so "new output since
 * last check" is a byte offset, not a buffer to maintain. And a crashed pi
 * leaves records behind that the next session can reconcile — a shell whose
 * owning process is gone is marked interrupted, the way ultracode does for
 * workflow runs.
 *
 * Shells do NOT survive their session: session_shutdown kills them. What the
 * store preserves across a crash is the bookkeeping and the output, not the
 * process.
 */

import {
	appendFileSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ShellStatus = "running" | "done" | "failed" | "killed" | "interrupted";

export interface ShellMeta {
	shellId: string;
	command: string;
	cwd: string;
	/** The child's pid — the process group leader, so kill(-pid) reaches everything. */
	pid: number | undefined;
	/** The pi process that owns the shell. Dead owner + status running = interrupted. */
	ownerPid: number;
	sessionId?: string;
	status: ShellStatus;
	startedAt: number;
	endedAt?: number;
	/** null means killed by signal rather than exiting on its own. */
	exitCode?: number | null;
	/** Set when the kill came from the tool call's timeout parameter. */
	timedOut?: boolean;
	/**
	 * The interrupted notice for this shell reached a model. Until then the
	 * record is exempt from pruning — the store is global and any project's
	 * session runs reconcile(), so without this flag whichever session started
	 * first would consume (or prune away) a notice owed to another project.
	 */
	reported?: boolean;
}

/** Anything but running. Interrupted counts: nobody is left to finish it. */
export function isSettled(status: ShellStatus): boolean {
	return status !== "running";
}

export function storeRoot(agentDir: string): string {
	return join(agentDir, "background-shells");
}

export function shellDir(agentDir: string, shellId: string): string {
	return join(storeRoot(agentDir), shellId);
}

export function outputPath(agentDir: string, shellId: string): string {
	return join(shellDir(agentDir, shellId), "output.log");
}

export function ensureStore(agentDir: string): void {
	try {
		mkdirSync(storeRoot(agentDir), { recursive: true });
	} catch {
		/* a store we cannot create must not take the session down */
	}
}

let counter = 0;

/**
 * A sortable id unique across processes: `sh-<base36 ms>-<base36 pid>-<counter>`.
 * The pid component matters — the store is shared by every concurrent pi
 * session, and a per-process counter alone collides the moment two of them
 * start their Nth shell in the same millisecond.
 */
export function newShellId(now: number = Date.now()): string {
	return `sh-${now.toString(36).padStart(9, "0")}-${process.pid.toString(36)}-${++counter}`;
}

/** Replace shell.json atomically, so a reader never sees a half-written file. */
export function writeMeta(agentDir: string, meta: ShellMeta): void {
	const dir = shellDir(agentDir, meta.shellId);
	try {
		mkdirSync(dir, { recursive: true });
		const temporary = join(dir, "shell.json.tmp");
		writeFileSync(temporary, JSON.stringify(meta, null, 2), "utf8");
		renameSync(temporary, join(dir, "shell.json"));
	} catch {
		/* a store we cannot write must not take the shell down */
	}
}

export function readMeta(agentDir: string, shellId: string): ShellMeta | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(shellDir(agentDir, shellId), "shell.json"), "utf8")) as ShellMeta;
		return raw && typeof raw.shellId === "string" ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** Every readable shell record, newest first. Unreadable directories are skipped. */
export function listShells(agentDir: string): ShellMeta[] {
	let ids: string[];
	try {
		ids = readdirSync(storeRoot(agentDir));
	} catch {
		return [];
	}
	const metas: ShellMeta[] = [];
	for (const id of ids) {
		const meta = readMeta(agentDir, id);
		if (meta) metas.push(meta);
	}
	return metas.sort((a, b) => b.startedAt - a.startedAt);
}

/** True when a pid is still around. EPERM means someone else owns it — alive. */
export function pidAlive(pid: number | undefined): boolean {
	if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Mark shells whose owning pi process died as interrupted, and return them.
 *
 * Bookkeeping only, deliberately: the child itself may or may not have died
 * with its owner, and killing a live orphan from here would be acting on a
 * process this session never started. The interrupted notice tells the model,
 * and pidAlive(meta.pid) tells the notice whether the orphan is still up.
 */
export function reconcile(agentDir: string): ShellMeta[] {
	const interrupted: ShellMeta[] = [];
	for (const meta of listShells(agentDir)) {
		if (isSettled(meta.status) || pidAlive(meta.ownerPid)) continue;
		const updated: ShellMeta = { ...meta, status: "interrupted", endedAt: meta.endedAt ?? Date.now() };
		writeMeta(agentDir, updated);
		interrupted.push(updated);
	}
	return interrupted;
}

/**
 * Drop settled shell directories beyond the newest `keep`. Running ones are
 * never touched, and neither is an interrupted record whose notice is still
 * owed — pruning it would destroy the only evidence a live orphan exists.
 */
export function pruneShells(agentDir: string, keep: number): void {
	const settled = listShells(agentDir).filter(
		(meta) => isSettled(meta.status) && !(meta.status === "interrupted" && !meta.reported),
	);
	for (const meta of settled.slice(keep)) {
		try {
			rmSync(shellDir(agentDir, meta.shellId), { recursive: true, force: true });
		} catch {
			/* pruning is a courtesy */
		}
	}
}

/** Append a chunk to output.log. Best-effort: output loss must not kill the shell. */
export function appendOutput(agentDir: string, shellId: string, chunk: string | Buffer): void {
	try {
		appendFileSync(outputPath(agentDir, shellId), chunk);
	} catch {
		/* ignored */
	}
}

export interface OutputRead {
	text: string;
	/** Where the next read should start — the file size at read time. */
	nextOffset: number;
	/** Bytes skipped between the cursor and where reading began (firehose case). */
	skipped: number;
	/**
	 * Absolute BYTE offset where the read's final (possibly torn) line begins —
	 * the position just after the last newline, or where reading began when the
	 * whole read is one line. Byte-exact by construction (newline is a single
	 * byte in UTF-8), which is what makes it safe to rewind a cursor to: byte
	 * lengths recomputed from the DECODED text overcount when the read tore a
	 * multibyte character, since the torn bytes decode to a replacement char.
	 */
	lastLineStart: number;
}

/**
 * Read output.log from `offset` to the end, tail-biased: if more than
 * `capBytes` accumulated since the cursor, skip ahead and read only the last
 * `capBytes` of it. The end is what you want from a shell, and the skip is
 * reported rather than silently paged through — a reader that lags a firehose
 * one page at a time never catches up.
 *
 * Byte-range reads can split a multibyte character at either edge; the
 * replacement character that produces is cosmetic and accepted, as in pi's own
 * bounded tail reads.
 */
export function readOutputFrom(agentDir: string, shellId: string, offset: number, capBytes: number): OutputRead {
	try {
		const fd = openSync(outputPath(agentDir, shellId), "r");
		try {
			const size = fstatSync(fd).size;
			if (size <= offset) return { text: "", nextOffset: size, skipped: 0, lastLineStart: size };
			const unread = size - offset;
			const start = unread > capBytes ? size - capBytes : offset;
			const buffer = Buffer.alloc(size - start);
			const bytes = readSync(fd, buffer, 0, buffer.length, start);
			const read = buffer.subarray(0, bytes);
			const lastNewline = read.lastIndexOf(0x0a);
			return {
				text: read.toString("utf8"),
				nextOffset: size,
				skipped: start - offset,
				lastLineStart: start + (lastNewline >= 0 ? lastNewline + 1 : 0),
			};
		} finally {
			closeSync(fd);
		}
	} catch {
		return { text: "", nextOffset: offset, skipped: 0, lastLineStart: offset };
	}
}

/**
 * ANSI escape sequences (CSI, OSC, and lone two-byte forms). Shell output is
 * raw terminal traffic — colour codes, cursor movement, progress-bar erases —
 * and none of it may reach the editor slot, where pi-tui passes it through
 * verbatim and a stray cursor-move corrupts the whole frame.
 */
const ANSI_PATTERN = /[\u001B\u009B](?:\[[0-9;:<=>?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/**
 * Raw shell output → display lines: escapes stripped, a lone CR treated as a
 * line break (progress bars redraw with `\r`; successive frames become
 * successive lines rather than one line of garbage), remaining control
 * characters dropped (tab survives).
 */
export function sanitizeOutput(text: string): string[] {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.split(/\r\n|\r|\n/);
}

/**
 * The last `maxBytes` of output.log as sanitized lines, for the panel's
 * detail view and the exit report. When the window starts mid-file the torn
 * first line is dropped — unless it is the only content (one huge line), in
 * which case it is kept with an ellipsis rather than pretending the shell was
 * silent.
 */
export function tailOutput(agentDir: string, shellId: string, maxBytes: number): string[] {
	try {
		const fd = openSync(outputPath(agentDir, shellId), "r");
		try {
			const size = fstatSync(fd).size;
			if (size === 0) return [];
			const start = Math.max(0, size - maxBytes);
			const buffer = Buffer.alloc(size - start);
			const bytes = readSync(fd, buffer, 0, buffer.length, start);
			const lines = sanitizeOutput(buffer.subarray(0, bytes).toString("utf8"));
			if (lines.at(-1) === "") lines.pop();
			if (start > 0 && lines.length > 0) {
				if (lines.length > 1) lines.shift();
				else lines[0] = `…${lines[0]}`;
			}
			return lines;
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

/** Current size of output.log — the panel's cache key (the file is append-only). */
export function outputSize(agentDir: string, shellId: string): number {
	try {
		const fd = openSync(outputPath(agentDir, shellId), "r");
		try {
			return fstatSync(fd).size;
		} finally {
			closeSync(fd);
		}
	} catch {
		return 0;
	}
}
