/**
 * Reading the working tree through git, and turning it into a ChangeSet.
 *
 * Every git call is asynchronous. A read is one `git status` plus one `git
 * show` per file that HEAD knows and this reader has not seen at this HEAD,
 * and the TUI keeps drawing while they run — which matters, because the
 * statusline's synchronous numstat is one cheap call and this is not.
 *
 * What is cached, and why:
 *   - HEAD's copy of a file, by commit and path. An edit to one file must not
 *     re-fetch every other file's baseline on the next read.
 *   - The description of a file, by everything it was built from: the commit,
 *     the status code, and the file's mtime and size. A poll that finds
 *     nothing changed rebuilds nothing, and hands back the SAME ChangeSet
 *     object, which is what lets the panel skip re-laying it out.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CONFIG } from "./config.ts";
import { type ChangedFile, type ChangeSet, changeSet, describe, parseStatus } from "./model.ts";

export type Reading =
	| { kind: "changes"; set: ChangeSet }
	/** cwd is not inside a work tree. */
	| { kind: "no-repo" }
	/** git did not answer this time — an index.lock mid-commit, a timeout. The last set still stands. */
	| { kind: "unavailable" };

/**
 * Run git. Resolves to stdout; to null when git ran and said no (a nonzero
 * exit: no such path in HEAD, an unborn branch, not a repository); to
 * undefined when git did not get to answer (killed by the timeout, or its
 * output overflowed the buffer). The two are kept apart because a "no" is a
 * fact worth caching and a non-answer is not: cached as a "no", a `git show`
 * that timed out once would describe that file as wholly new until the next
 * commit.
 */
function git(cwd: string, args: string[]): Promise<Buffer | null | undefined> {
	return new Promise((done) => {
		execFile(
			"git",
			args,
			{ cwd, encoding: "buffer", timeout: CONFIG.gitTimeoutMs, maxBuffer: CONFIG.gitMaxBuffer },
			(error, stdout) => {
				if (!error) return done(stdout);
				const code = (error as { code?: unknown }).code;
				// A nonzero exit is a number; no git binary at all is "ENOENT",
				// and that is a "no" too, not something to keep asking about.
				done(typeof code === "number" || code === "ENOENT" ? null : undefined);
			},
		);
	});
}

/**
 * The real path of `absolute`, resolved through the deepest ancestor that
 * exists, with the missing tail re-joined as named.
 */
function realpathOfNearest(absolute: string): string {
	let head = absolute;
	let tail = "";
	for (;;) {
		try {
			return tail === "" ? realpathSync(head) : join(realpathSync(head), tail);
		} catch {
			const parent = dirname(head);
			if (parent === head) return absolute;
			tail = tail === "" ? basename(head) : join(basename(head), tail);
			head = parent;
		}
	}
}

export class ChangeReader {
	private root: string | null | undefined;
	private readonly blobs = new Map<string, Buffer | null>();
	private readonly files = new Map<string, { key: string; file: ChangedFile }>();
	private last: ChangeSet | undefined;

	constructor(readonly cwd: string) {}

	/**
	 * The path a tool named, as git names it, or undefined when it lies
	 * outside the repository (or the root is not known yet).
	 *
	 * Git reports the root with symlinks resolved — on macOS `/var/...` comes
	 * back as `/private/var/...` — so the tool's path is resolved the same way
	 * before the two are compared. Through the nearest ancestor that still
	 * exists when the file itself is gone: a deleted file has no real path, but
	 * some directory above it does.
	 */
	toRepoPath(path: string): string | undefined {
		if (!this.root) return undefined;
		const rel = relative(this.root, realpathOfNearest(resolve(this.cwd, path)));
		// Outside the root, or the root itself. Not merely a name that begins
		// with two dots: "..hidden" is a file git lists like any other.
		return rel === "" || rel === ".." || rel.startsWith("../") ? undefined : rel;
	}

	async read(): Promise<Reading> {
		// Re-probed while unknown, so a `git init` mid-session is picked up.
		if (!this.root) {
			const out = await git(this.cwd, ["rev-parse", "--show-toplevel"]);
			if (out === undefined) return { kind: "unavailable" };
			this.root = out === null ? null : out.toString("utf8").trim();
		}
		if (!this.root) return { kind: "no-repo" };
		const root = this.root;

		// Null before the first commit — git says so — and then every file is wholly new.
		const headOut = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
		if (headOut === undefined) return { kind: "unavailable" };
		const head = headOut?.toString("utf8").trim() ?? "";
		const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		if (status === null || status === undefined) return { kind: "unavailable" };

		const seen = new Set<string>();
		const files: ChangedFile[] = [];
		let reused = 0;
		for (const entry of parseStatus(status.toString("utf8"))) {
			if (seen.has(entry.path)) continue;
			seen.add(entry.path);

			const absolute = join(root, entry.path);
			let stamp: string;
			try {
				const info = await stat(absolute);
				// A submodule shows as a modified directory; there is no text to diff.
				if (!info.isFile()) continue;
				stamp = `${info.mtimeMs}:${info.size}`;
			} catch {
				stamp = "gone";
			}

			// The origin is in the key: a staged rename can be re-pointed at
			// another source without the file itself changing.
			const key = `${head}|${entry.code}|${entry.from ?? ""}|${stamp}`;
			const cached = this.files.get(entry.path);
			if (cached !== undefined && cached.key === key) {
				files.push(cached.file);
				reused += 1;
				continue;
			}

			const old = head === "" ? null : await this.blob(root, head, entry.from ?? entry.path);
			// A non-answer spoils the whole read rather than this one file: the
			// description would be cached against the file's stamp and stay
			// wrong until the file changed again.
			if (old === undefined) return { kind: "unavailable" };
			// In neither HEAD nor the tree — staged as new, then deleted — there
			// is nothing to show.
			if (old === null && stamp === "gone") continue;
			// Present but unreadable is not gone: it stays in the list, and says why.
			const now = stamp === "gone" ? null : await readFile(absolute).catch(() => undefined);
			const file: ChangedFile =
				now === undefined
					? { path: entry.path, status: old === null ? "added" : "modified", added: 0, removed: 0, note: "unreadable" }
					: describe(entry.path, old, now);
			this.files.set(entry.path, { key, file });
			files.push(file);
		}

		// Forget what git no longer reports, so neither cache grows with the session.
		for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
		for (const key of this.blobs.keys()) if (!key.startsWith(`${head}:`)) this.blobs.delete(key);

		// Nothing changed since last time: same object, so the panel's layout memo holds.
		if (this.last !== undefined && reused === files.length && files.length === this.last.files.length) {
			return { kind: "changes", set: this.last };
		}
		this.last = changeSet(files);
		return { kind: "changes", set: this.last };
	}

	/**
	 * HEAD's copy of a path; null when HEAD has no such path; undefined when
	 * git did not answer, which is not cached — see git().
	 */
	private async blob(root: string, head: string, path: string): Promise<Buffer | null | undefined> {
		const key = `${head}:${path}`;
		if (this.blobs.has(key)) return this.blobs.get(key);
		const out = await git(root, ["show", key]);
		if (out !== undefined) this.blobs.set(key, out);
		return out;
	}
}
