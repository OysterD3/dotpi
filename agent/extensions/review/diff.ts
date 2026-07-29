/**
 * Measuring the diff, so the finder fleet can be sized to the work.
 *
 * This is a hint, not a contract: the review's own Phase 0 may widen the scope
 * further, and the prompt says as much so the agent scales up rather than
 * treating the number as a ceiling.
 *
 * Three sources, because a change can live in any of them: committed work, the
 * working tree, and untracked files. The last is easy to forget and the most
 * damaging to miss — `git diff` never shows it, so a branch of all-new files
 * measures as an empty change.
 *
 * Everything here is bounded on purpose. This runs in front of a command the
 * user is waiting on, to compute a number whose effect saturates almost
 * immediately, so it must never become the slow part of the command.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "./config.ts";

const run = promisify(execFile);

/** A ref range safe to hand to git: no flags, no shell metacharacters. */
const REF_RANGE = /^[@\w][@\w./~^-]*\.\.\.?[@\w][@\w./~^-]*$/;

/**
 * The point past which a bigger number changes nothing.
 *
 * `finderBudget` clamps at `maxFinders`, so once the count reaches this the
 * answer is already decided. Counting further would spend real time to refine a
 * value nothing reads.
 */
const ENOUGH = CONFIG.maxFinders * CONFIG.linesPerFinder;

/** Largest untracked file worth opening; past this the line count is guessed from its size. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Bytes per line assumed for a file too big to read. Rough on purpose — it only feeds a clamp. */
const ASSUMED_BYTES_PER_LINE = 40;

const GIT_OPTIONS = { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 } as const;

/** One git invocation, with the hook-disabling and limits every call here wants. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, ...GIT_OPTIONS });
		return stdout;
	} catch {
		return undefined;
	}
}

/** Changed lines reported by `--shortstat`, or undefined if git said nothing usable. */
async function shortstat(cwd: string, args: string[]): Promise<number | undefined> {
	const stdout = await git(cwd, ["diff", "--shortstat", ...args]);
	if (stdout === undefined) return undefined;
	const inserted = /(\d+) insertion/.exec(stdout)?.[1];
	const deleted = /(\d+) deletion/.exec(stdout)?.[1];
	if (inserted === undefined && deleted === undefined) return undefined;
	return Number(inserted ?? 0) + Number(deleted ?? 0);
}

/**
 * Changed lines in the diff under review, or undefined when git cannot say.
 *
 * `undefined` is a real answer and the caller must not turn it into zero: no
 * upstream configured, a fresh repo with no commits, or a target that is a path
 * rather than a range all land here, and each would otherwise size the fleet at
 * the minimum for what might be a very large change.
 */
export async function countDiffLines(cwd: string, target?: string): Promise<number | undefined> {
	// Only a ref range can be measured this way. A path target is left unmeasured
	// rather than guessed at — passing it here would count the wrong thing.
	if (target && !REF_RANGE.test(target)) return undefined;
	const range = target || "@{upstream}...HEAD";

	// Independent queries, so they overlap: sequentially these were three 5s
	// timeouts in a row in front of a command the user is waiting on.
	const [committed, working, untracked] = await Promise.all([
		shortstat(cwd, [range]),
		shortstat(cwd, ["HEAD"]),
		countUntracked(cwd),
	]);

	if (committed === undefined && working === undefined && untracked === undefined) return undefined;
	// The three are disjoint, not overlapping: merge-base→HEAD, HEAD→working
	// tree, and files git has never seen. Summing is exact; taking the largest
	// would discard whichever part of the change happened to be smaller.
	return (committed ?? 0) + (working ?? 0) + (untracked ?? 0);
}

/**
 * Lines in untracked files, which appear in no diff at all.
 *
 * Without this a branch made entirely of new files measures as zero and gets
 * the smallest fleet — the exact shape of a new module, and the one most worth
 * reviewing properly.
 *
 * Bounded three ways, because `--exclude-standard` only skips what is *already*
 * gitignored: a not-yet-ignored `node_modules` or build directory is exactly
 * the state a new project is in, and reading it whole to count newlines would
 * spend seconds and hundreds of megabytes on a number that stopped mattering at
 * ENOUGH lines.
 */
async function countUntracked(cwd: string): Promise<number | undefined> {
	const stdout = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (stdout === undefined) return undefined;

	const files = stdout.split("\0").filter(Boolean);
	let lines = 0;

	for (const file of files) {
		// Stop as soon as the answer cannot change.
		if (lines >= ENOUGH) return lines;
		try {
			const path = join(cwd, file);
			const { size } = await stat(path);
			// Big files are estimated rather than read: a line count precise to
			// the line is worth nothing here, and reading a 100MB blob is not.
			lines += size > MAX_FILE_BYTES ? Math.ceil(size / ASSUMED_BYTES_PER_LINE) : countLines(await readFile(path, "utf8"));
		} catch {
			// Unreadable, binary, or vanished: skip it rather than failing the estimate.
		}
	}

	return lines;
}

/** Newlines in `text`, without allocating the array `split` would. */
function countLines(text: string): number {
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}
