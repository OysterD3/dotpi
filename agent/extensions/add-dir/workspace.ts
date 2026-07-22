/**
 * The set of directories the agent is told it may work in.
 *
 * Two origins, which behave differently and so are tracked separately:
 *
 *   persisted  read from settings.json at startup; survives restarts
 *   session    added with `/add-dir`; lives only in this conversation
 *
 * Session additions are written to the session as custom entries rather than kept
 * in a plain array, for one concrete reason: `/rewind` forks the session, and
 * `getBranch()` returns only the entries on the branch you ended up on. Replaying
 * the branch means rewinding past an `/add-dir` correctly un-adds the directory,
 * and resuming a session keeps what you added. An in-memory array would get both
 * of those wrong.
 *
 * Entries are replayed forward, not scanned backwards for the newest, because add
 * and remove are separate events and the answer is the accumulation of all of
 * them.
 */

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE } from "./config.ts";
import { expandPath, isWithin } from "./paths.ts";

export type Origin = "cwd" | "session" | "persisted";

export type WorkspaceDir = {
	path: string;
	origin: Origin;
	/** For persisted directories, the settings file it came from. */
	source?: string;
};

/** What a session entry records. `active: false` is a removal. */
export type DirEntryData = {
	dir: string;
	active: boolean;
};

type BranchEntry = { type: string; customType?: string; data?: unknown };

/** Rebuild the session-scoped list by replaying a branch in order. */
export function restoreSessionDirs(entries: BranchEntry[]): string[] {
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;

		const data = entry.data as DirEntryData | undefined;
		if (!data || typeof data.dir !== "string" || data.dir.length === 0) continue;

		const index = dirs.indexOf(data.dir);
		if (data.active) {
			if (index === -1) dirs.push(data.dir);
		} else if (index !== -1) {
			dirs.splice(index, 1);
		}
	}
	return dirs;
}

export class Workspace {
	private sessionDirs: string[] = [];
	private persistedDirs: Array<{ path: string; source: string }> = [];

	constructor(
		private readonly pi: ExtensionAPI,
		readonly cwd: string,
	) {}

	/**
	 * Adopt directories read from settings. Paths are expanded here rather than at
	 * read time so a hand-edited `~/projects/lib` behaves like one typed at the
	 * prompt; entries that no longer exist are kept, since a stale entry for a
	 * directory you are about to check out is better than a silent disappearance.
	 */
	adoptPersisted(dirs: string[], source: string): void {
		for (const dir of dirs) {
			let absolute: string;
			try {
				absolute = resolve(expandPath(dir, this.cwd));
			} catch {
				continue;
			}
			if (this.has(absolute)) continue;
			this.persistedDirs.push({ path: absolute, source });
		}
	}

	adoptSession(dirs: string[]): void {
		this.sessionDirs = dirs.filter((dir) => !this.persistedDirs.some((entry) => entry.path === dir));
	}

	/** Everything, cwd first. This is what the model is told about. */
	all(): WorkspaceDir[] {
		return [{ path: this.cwd, origin: "cwd" as const }, ...this.additional()];
	}

	/** Just the added directories, persisted before session. */
	additional(): WorkspaceDir[] {
		return [
			...this.persistedDirs.map((entry) => ({
				path: entry.path,
				origin: "persisted" as const,
				source: entry.source,
			})),
			...this.sessionDirs.map((path) => ({ path, origin: "session" as const })),
		];
	}

	paths(): string[] {
		return this.all().map((dir) => dir.path);
	}

	/** Is `dir` already covered — as an exact entry or as a child of one? */
	has(dir: string): boolean {
		return this.paths().some((known) => isWithin(dir, known));
	}

	find(dir: string): WorkspaceDir | undefined {
		return this.all().find((entry) => entry.path === dir);
	}

	/** Add for this session only, recording it in the session. */
	addSession(dir: string): void {
		if (!this.sessionDirs.includes(dir)) this.sessionDirs.push(dir);
		this.pi.appendEntry<DirEntryData>(ENTRY_TYPE, { dir, active: true });
	}

	/**
	 * Add without recording a session entry, for a directory that was just written
	 * to settings. Recording it would double-add it on the next resume — once from
	 * the file, once from the replayed entry.
	 */
	addPersisted(dir: string, source: string): void {
		this.sessionDirs = this.sessionDirs.filter((path) => path !== dir);
		if (!this.persistedDirs.some((entry) => entry.path === dir)) {
			this.persistedDirs.push({ path: dir, source });
		}
	}

	/** Drop a directory from this session. Persisted ones also need `unpersist`. */
	remove(dir: string): void {
		this.sessionDirs = this.sessionDirs.filter((path) => path !== dir);
		this.persistedDirs = this.persistedDirs.filter((entry) => entry.path !== dir);
		this.pi.appendEntry<DirEntryData>(ENTRY_TYPE, { dir, active: false });
	}
}
