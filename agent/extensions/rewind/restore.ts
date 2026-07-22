/**
 * Applying a code rewind.
 *
 * This is the only part of the extension that destroys work, so it is
 * deliberately timid. It follows Claude Code's rules: never follow a symlink,
 * never touch anything that is not a regular file, and refuse rather than force
 * when the path on disk is not what the checkpoint expects. A refusal is
 * reported, never silent — the whole point is that the user can trust what the
 * summary says was changed.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EditRecord } from "./history.ts";
import type { HistoryStore } from "./store.ts";

export type RestoreOutcome = {
	restored: string[];
	deleted: string[];
	/** Paths left untouched, with why. */
	refused: Array<{ path: string; reason: string }>;
};

/** Refuse anything that is not a plain file: symlinks, directories, devices. */
function inspect(path: string): { exists: boolean; refusal?: string } {
	let stats;
	try {
		stats = lstatSync(path);
	} catch {
		return { exists: false };
	}

	if (stats.isSymbolicLink()) return { exists: true, refusal: "path is a symlink" };
	if (stats.isDirectory()) return { exists: true, refusal: "path is a directory" };
	if (!stats.isFile()) return { exists: true, refusal: "path is not a regular file" };
	return { exists: true };
}

/** Restore every target. Never throws: a failure on one file must not abort the rest. */
export function applyRestore(store: HistoryStore, targets: Map<string, EditRecord>): RestoreOutcome {
	const outcome: RestoreOutcome = { restored: [], deleted: [], refused: [] };

	for (const [path, target] of targets) {
		if (target.skipped) {
			outcome.refused.push({
				path,
				reason: target.skipped === "too-large" ? "file was too large to check point" : "file was unreadable when check pointed",
			});
			continue;
		}

		const state = inspect(path);
		if (state.refusal) {
			outcome.refused.push({ path, reason: state.refusal });
			continue;
		}

		// null means the file did not exist at the checkpoint, so undo means delete.
		if (target.blob === null) {
			if (!state.exists) continue;
			try {
				rmSync(path);
				outcome.deleted.push(path);
			} catch (error) {
				outcome.refused.push({ path, reason: message(error) });
			}
			continue;
		}

		if (!store.hasBlob(target.blob)) {
			outcome.refused.push({ path, reason: "backup contents are missing" });
			continue;
		}

		try {
			const contents = store.readBlob(target.blob);
			mkdirSync(dirname(path), { recursive: true });
			// Write via rename so an interrupted restore cannot truncate the file.
			const tmp = `${path}.pi-rewind.tmp`;
			writeFileSync(tmp, contents);
			renameSync(tmp, path);
			outcome.restored.push(path);
		} catch (error) {
			outcome.refused.push({ path, reason: message(error) });
			try {
				const tmp = `${path}.pi-rewind.tmp`;
				if (existsSync(tmp)) rmSync(tmp);
			} catch {}
		}
	}

	return outcome;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
