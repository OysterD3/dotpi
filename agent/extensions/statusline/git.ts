/**
 * Git facts for the statusline: how many lines differ from HEAD.
 *
 * Branch name comes from pi's own `footerData.getGitBranch()`; only the diff counts
 * need shelling out.
 */

import { execFileSync } from "node:child_process";
import { CONFIG } from "./config.ts";

/** The canonical empty tree object, per `git hash-object -t tree /dev/null`. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type DiffCounts = { added: number; removed: number };

/** Run git, returning stdout, or null if it failed for any reason. */
function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1500,
		});
	} catch {
		return null;
	}
}

export function parseNumstat(out: string): DiffCounts {
	let added = 0;
	let removed = 0;
	for (const line of out.split("\n")) {
		const [a, r] = line.split("\t");
		// "-" marks a binary file, which has no line counts to add.
		if (a && a !== "-") added += Number(a) || 0;
		if (r && r !== "-") removed += Number(r) || 0;
	}
	return { added, removed };
}

/**
 * Added/removed lines in the working tree, or null when cwd is not a git work tree.
 *
 * `git diff HEAD` covers staged and unstaged changes together, but fails outright in a
 * repo with no commits yet ("ambiguous argument 'HEAD'"), so that case falls back to
 * diffing against the empty tree. Untracked files are counted by neither — git has no
 * previous version to diff them against.
 *
 * A negative result is cached just like a positive one, otherwise a non-repo cwd
 * re-spawns git on every single render.
 */
export function makeGitDiffCounter(cwd: string) {
	let cache: DiffCounts | null = null;
	let stamp = 0;
	let knownWorkTree = false;

	return (): DiffCounts | null => {
		const now = Date.now();
		if (stamp !== 0 && now - stamp < CONFIG.gitPollMs) return cache;
		stamp = now;

		// Once true this cannot become false for a fixed cwd, so only re-probe while
		// false — that way a `git init` mid-session is still picked up.
		if (!knownWorkTree) {
			knownWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
		}
		if (!knownWorkTree) {
			cache = null;
			return cache;
		}

		const out =
			git(cwd, ["diff", "--numstat", "HEAD"]) ?? git(cwd, ["diff", "--numstat", EMPTY_TREE]);
		cache = out === null ? null : parseNumstat(out);
		return cache;
	};
}
