/**
 * On-disk backing for checkpoints: content-addressed blobs plus an index.
 *
 * Layout, per session, under <agent-dir>/file-history/<sessionId>/:
 *   index.json    the History record
 *   blobs/<sha>   file contents, deduplicated by digest
 *
 * Blobs are written with an atomic rename so a crash mid-write cannot leave a
 * truncated blob under a digest that claims to be complete. Everything here is
 * best-effort: losing history must never break a session, so failures are
 * reported to the caller rather than thrown at the agent.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { emptyHistory, type History } from "./history.ts";

export class HistoryStore {
	private readonly dir: string;
	private readonly blobsDir: string;
	private readonly indexPath: string;
	private history: History;

	constructor(agentDir: string, sessionId: string) {
		this.dir = join(agentDir, CONFIG.historyDirName, sessionId);
		this.blobsDir = join(this.dir, "blobs");
		this.indexPath = join(this.dir, "index.json");
		this.history = this.load();
	}

	get(): History {
		return this.history;
	}

	private load(): History {
		try {
			if (!existsSync(this.indexPath)) return emptyHistory();
			const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as History;
			if (!Array.isArray(parsed.checkpoints) || !Array.isArray(parsed.edits)) return emptyHistory();
			return parsed;
		} catch {
			// A corrupt index must not wedge the session; start fresh.
			return emptyHistory();
		}
	}

	save(): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			const tmp = `${this.indexPath}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.history), "utf8");
			renameSync(tmp, this.indexPath);
		} catch {
			// Best effort: a failed save costs history, not correctness.
		}
	}

	nextSeq(): number {
		return this.history.nextSeq++;
	}

	/**
	 * Store a file's current contents and return its digest.
	 *
	 * Returns `{ blob: null }` when the file does not exist — the caller records
	 * that as "restoring means deleting this file". Files that are too large or
	 * unreadable are flagged so restore can refuse rather than pretend.
	 */
	capture(path: string): { blob: string | null; skipped?: "too-large" | "unreadable" } {
		let stats;
		try {
			stats = statSync(path);
		} catch {
			return { blob: null };
		}

		if (!stats.isFile()) return { blob: null, skipped: "unreadable" };
		if (stats.size > CONFIG.maxFileBytes) return { blob: null, skipped: "too-large" };

		try {
			const contents = readFileSync(path);
			const digest = createHash("sha256").update(contents).digest("hex");
			const blobPath = join(this.blobsDir, digest);

			if (!existsSync(blobPath)) {
				mkdirSync(this.blobsDir, { recursive: true });
				const tmp = `${blobPath}.tmp`;
				writeFileSync(tmp, contents, { mode: stats.mode });
				renameSync(tmp, blobPath);
			}

			return { blob: digest };
		} catch {
			return { blob: null, skipped: "unreadable" };
		}
	}

	readBlob(digest: string): Buffer {
		return readFileSync(join(this.blobsDir, digest));
	}

	hasBlob(digest: string): boolean {
		return existsSync(join(this.blobsDir, digest));
	}

	/**
	 * Seed a new session's history from the one it replaced.
	 *
	 * Rewinding forks the session, which gives it a new id and would otherwise
	 * orphan every checkpoint — you could rewind once and never again. Claude Code
	 * copies its history forward for the same reason. No-op if the target already
	 * has history, so this can be called on every session start.
	 */
	static inherit(agentDir: string, fromSessionId: string, toSessionId: string): void {
		const root = join(agentDir, CONFIG.historyDirName);
		const source = join(root, fromSessionId);
		const target = join(root, toSessionId);

		try {
			if (!existsSync(source) || existsSync(target)) return;
			mkdirSync(root, { recursive: true });
			cpSync(source, target, { recursive: true });
		} catch {
			// Losing inherited history costs the ability to rewind further back,
			// not correctness.
		}
	}

	/** Drop history for sessions untouched for longer than the retention window. */
	static prune(agentDir: string): void {
		const root = join(agentDir, CONFIG.historyDirName);
		const cutoff = Date.now() - CONFIG.pruneAfterDays * 24 * 60 * 60 * 1000;

		try {
			for (const name of readdirSync(root)) {
				const path = join(root, name);
				try {
					if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
				} catch {}
			}
		} catch {
			// No history directory yet.
		}
	}
}
