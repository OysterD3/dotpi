/**
 * Where the scratchpad lives, and keeping it tidy.
 *
 * Layout:
 *
 *   <tmp>/pi-scratchpad-<uid>/<project-slug>/<session-id>/
 *
 * Three segments, each earning its place:
 *
 *   uid       `/tmp` is world-writable and shared between users. Without a
 *             per-user parent created 0700, another account on the machine can
 *             read what the agent writes — or pre-create the directory it is
 *             about to use and watch. This is the segment that makes the rest
 *             safe, so it is created first and separately.
 *   project   so two repos being worked on at once are legible when you go
 *             looking, rather than a wall of session ids.
 *   session   so parallel sessions cannot overwrite each other's files. Two
 *             agents both writing `check.ts` is not hypothetical; it is Tuesday.
 *
 * Deliberately NOT under `~/.pi`. See config.ts — that directory is a public git
 * repo, and "the scratch files are gitignored" is a guarantee that holds until
 * someone edits .gitignore.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CONFIG } from "./config.ts";

/**
 * A filesystem-safe stand-in for a path.
 *
 * The same shape pi uses for its own session directories: separators become
 * dashes so the result is one path segment. Anything outside a conservative
 * safe set is replaced rather than escaped — this is a display aid for someone
 * browsing /tmp, not a reversible encoding, and a slug that can contain `..` or
 * a separator is a directory-traversal bug waiting to be written.
 */
export function slug(path: string): string {
	const cleaned = path.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
	// A result of only dots is the one survivor of the character filter that is
	// still dangerous: `.` and `..` are in the safe set individually, and
	// join(root, "..") leaves the root entirely. Everything else that gets this
	// far is inert, because it contains no separator.
	if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "root";
	return cleaned.slice(0, 120);
}

/** The per-user root. Everything else lives inside it. */
export function rootFor(override?: string): string {
	if (override) return resolve(override);
	// `process.getuid` is absent on Windows; the username is the nearest thing.
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : slug(process.env.USERNAME ?? "user");
	return join(tmpdir(), `${CONFIG.rootName}-${uid}`);
}

export function projectDir(root: string, cwd: string): string {
	return join(root, slug(cwd));
}

export function sessionDir(root: string, cwd: string, sessionId: string): string {
	return join(projectDir(root, cwd), slug(sessionId));
}

/**
 * Create the directory, and the private root above it.
 *
 * The root is created 0700 in its own call rather than relying on `recursive`,
 * because `mkdirSync(a/b/c, { mode })` applies the mode to every level it
 * creates — and if the root already exists (the common case) the mode argument
 * is ignored entirely, so a permissive root created earlier would silently
 * stay permissive. Checking and setting it explicitly is the only way to know.
 *
 * Returns the path, or undefined when the filesystem says no — a scratchpad is
 * a convenience, and failing to make one must never fail the session.
 */
export function ensure(root: string, cwd: string, sessionId: string): string | undefined {
	try {
		if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
		const dir = sessionDir(root, cwd, sessionId);
		mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return undefined;
	}
}

export type Entry = { name: string; bytes: number };

/** Files in the scratchpad, largest first. Directories are summarised, not walked. */
export function list(dir: string): Entry[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.map((entry) => {
				try {
					const stat = statSync(join(dir, entry.name));
					return { name: entry.isDirectory() ? `${entry.name}/` : entry.name, bytes: stat.isDirectory() ? 0 : stat.size };
				} catch {
					return { name: entry.name, bytes: 0 };
				}
			})
			.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/**
 * Empty the scratchpad without removing it.
 *
 * Entry by entry rather than `rm -rf` on the directory itself, so the path the
 * agent was told about in this turn's system prompt still exists afterwards.
 */
export function clear(dir: string): number {
	let removed = 0;
	for (const entry of list(dir)) {
		try {
			rmSync(join(dir, entry.name.replace(/\/$/, "")), { recursive: true, force: true });
			removed++;
		} catch {}
	}
	return removed;
}

/**
 * Remove session directories nobody has touched for the retention window.
 *
 * Bounded to `root` by construction: it only ever reads two levels down from a
 * path this module computed, and every candidate is re-joined from that root
 * rather than taken from anywhere else. `rmSync(recursive)` is the one call here
 * that could ruin someone's day, so what it can be pointed at matters more than
 * how tidy the loop is.
 *
 * Every error is swallowed: pruning is housekeeping, and a permissions problem
 * on one stale directory must not stop a session from starting.
 */
export function prune(root: string, now: number, retainDays = CONFIG.pruneAfterDays): number {
	const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
	let removed = 0;

	let projects: string[];
	try {
		projects = readdirSync(root);
	} catch {
		return 0; // Nothing has been written yet.
	}

	for (const project of projects) {
		const projectPath = join(root, project);
		// Paranoia rather than politeness: a name that escapes the root would make
		// the rmSync below delete something that is not ours.
		if (!projectPath.startsWith(root + sep)) continue;

		let sessions: string[];
		try {
			sessions = readdirSync(projectPath);
		} catch {
			continue;
		}

		for (const session of sessions) {
			const path = join(projectPath, session);
			if (!path.startsWith(projectPath + sep)) continue;
			try {
				if (statSync(path).mtimeMs < cutoff) {
					rmSync(path, { recursive: true, force: true });
					removed++;
				}
			} catch {}
		}

		// A project directory with nothing left in it is noise in /tmp.
		try {
			if (readdirSync(projectPath).length === 0) rmSync(projectPath, { recursive: true, force: true });
		} catch {}
	}

	return removed;
}
