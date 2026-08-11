/**
 * Git worktree scopes: somewhere for concurrent agents to write without
 * destroying each other's edits.
 *
 * Two designs were available and only one of them works.
 *
 * QuintinShaw/pi-dynamic-workflows hangs isolation off a per-agent
 * `isolation: 'worktree'` flag and tears the worktree down in an unconditional
 * `finally` — `worktree remove --force` then `branch -D`, on the SUCCESS path
 * too. Their own test asserts the branch is gone afterwards. So an isolated
 * agent's work is deleted the moment it returns, and all that survives is the
 * text it wrote in its final message. That is worse than having no isolation
 * at all, because it looks like it worked.
 *
 * vekexasia/pi-extensible-workflows scopes it instead: `withWorktree(name, cb)`
 * makes a NAMED place that outlives the callback, and the branch is kept and
 * reported. This is that design, with three differences of our own:
 *
 *   - the base commit is snapshotted from your UNCOMMITTED tree, so a scope
 *     starts from the files you actually have rather than from HEAD. Done with
 *     a throwaway GIT_INDEX_FILE so your real index is never touched — no
 *     staging, no stashing, nothing to restore if we crash;
 *   - a scope that produced no change is removed on the way out. Retaining an
 *     empty worktree teaches you to ignore the list, and then you ignore the
 *     one that matters;
 *   - what changed is reported as a diffstat against the base, because neither
 *     of those projects has any merge-back path at all — both leave you to
 *     discover a branch and work out what to do with it.
 *
 * Everything here shells out to git rather than using a library: these are
 * exactly the commands a person would run, which is what makes the result
 * inspectable afterwards with the tools they already know.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WorktreeScope {
	/** The script-level name, as written in withWorktree("name", …). */
	name: string;
	/** Absolute path agents in this scope run in. */
	path: string;
	/** The retained branch holding the scope's commits. */
	branch: string;
	/** The commit the scope started from — the diff base. */
	baseCommit: string;
}

export interface WorktreeChange {
	scope: WorktreeScope;
	/** Files changed against baseCommit, and the +/- counts. */
	files: number;
	insertions: number;
	deletions: number;
	/** `git diff --stat` output, trimmed. Empty when nothing changed. */
	stat: string;
}

/** git, in a directory, with output as text. Throws with stderr on failure. */
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	try {
		const { stdout } = await run("git", args, { cwd, env: env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
		return stdout.trim();
	} catch (error) {
		const detail = (error as { stderr?: string }).stderr?.trim() || String(error);
		throw new Error(`git ${args[0]} failed: ${detail}`);
	}
}

/** The repository root containing `cwd`, or undefined when there is none. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
	try {
		return await git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

/**
 * A commit capturing the working tree AS IT IS, including uncommitted edits.
 *
 * The whole thing runs against a throwaway index file, so `git add -A` here
 * does not stage anything in the user's real index. That matters more than it
 * looks: a workflow that stages your files as a side effect of isolating an
 * agent is a workflow you cannot run on a dirty tree, which is exactly when
 * you want it.
 *
 * Falls back to HEAD when the tree is clean, so the common case makes no
 * commit object at all.
 */
export async function snapshotCommit(root: string, message: string): Promise<string> {
	// A freshly `git init`-ed project has no HEAD, and that is the case most
	// likely to want parallel isolated implementations. Unconditionally
	// rev-parsing it failed the whole run with a raw git error, so an empty
	// repository is a supported starting point: the snapshot simply has no
	// parent.
	const head = await git(root, ["rev-parse", "HEAD"]).catch(() => undefined);
	const dirty = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
	if (!dirty && head) return head;

	const indexDir = mkdtempSync(join(tmpdir(), "pi-wt-index-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, "index") };
	try {
		if (head) await git(root, ["read-tree", head], env);
		await git(root, ["add", "-A"], env);
		const tree = await git(root, ["write-tree"], env);
		const parent = head ? ["-p", head] : [];
		return await git(root, ["commit-tree", tree, ...parent, "-m", message], env);
	} finally {
		rmSync(indexDir, { recursive: true, force: true });
	}
}

/**
 * Create a scope, or reuse one that already exists under the same name.
 *
 * Reuse is what makes a scope a place rather than an event: two withWorktree()
 * calls with the same name in one run are the same directory, so a later stage
 * sees what an earlier one built.
 */
export async function createScope(root: string, dir: string, runId: string, name: string): Promise<WorktreeScope> {
	// Readable AND injective. Truncating alone is not enough — two long names
	// that share a prefix would slug identically and silently share one
	// directory, which is the same class of bug as QuintinShaw cutting
	// `${runId}-${index}-${label}` to 32 chars, just ours. The digest of the
	// FULL name is what makes distinct scopes distinct; the readable part only
	// exists so the directory is recognisable on disk.
	const readable = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "scope";
	const slug = `${readable}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
	// runId is never truncated, so it cannot be cut off the front of the branch.
	const branch = `pi/wf/${runId}/${slug}`;
	const path = join(dir, slug);
	// The base commit is kept as a real ref, not just returned. A scope reopened
	// later — a second withWorktree() with the same name, or a resumed run —
	// needs the tree it started from to say what it changed, and deriving that
	// from history afterwards is guesswork.
	const baseRef = `refs/pi-workflow-base/${runId}/${slug}`;

	const existingBase = await git(root, ["rev-parse", "--verify", "--quiet", baseRef]).catch(() => "");
	const worktreeLive = await git(path, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");

	if (existingBase && worktreeLive === "true") {
		return { name, path, branch, baseCommit: existingBase };
	}
	if (existingBase) {
		// The branch outlived its directory (a pruned run dir, a manual remove).
		// Reattach rather than starting over, so earlier work stays reachable.
		mkdirSync(dir, { recursive: true });
		await git(root, ["worktree", "add", path, branch]);
		return { name, path, branch, baseCommit: existingBase };
	}

	mkdirSync(dir, { recursive: true });
	const baseCommit = await snapshotCommit(root, `pi workflow ${runId}: base for scope "${name}"`);
	await git(root, ["worktree", "add", "-b", branch, path, baseCommit]);
	await git(root, ["update-ref", baseRef, baseCommit]);
	return { name, path, branch, baseCommit };
}

/**
 * Commit whatever the scope's agents left behind.
 *
 * Called on the way out so the work is durable even if nobody looks at it for
 * a week. Returns false when there was nothing to commit.
 */
export async function commitScope(scope: WorktreeScope, message: string): Promise<boolean> {
	const dirty = await git(scope.path, ["status", "--porcelain", "--untracked-files=all"]);
	if (!dirty) return false;
	await git(scope.path, ["add", "-A"]);
	await git(scope.path, ["commit", "--no-verify", "-m", message]);
	return true;
}

/** What a scope changed against the tree it started from. */
export async function scopeChange(scope: WorktreeScope): Promise<WorktreeChange> {
	const stat = await git(scope.path, ["diff", "--stat", `${scope.baseCommit}..HEAD`]);
	const numstat = await git(scope.path, ["diff", "--numstat", `${scope.baseCommit}..HEAD`]);
	let insertions = 0;
	let deletions = 0;
	let files = 0;
	for (const line of numstat.split("\n")) {
		if (!line.trim()) continue;
		files++;
		const [added, removed] = line.split("\t");
		// "-" for binary files; count the file, not phantom lines.
		insertions += Number.parseInt(added ?? "0", 10) || 0;
		deletions += Number.parseInt(removed ?? "0", 10) || 0;
	}
	return { scope, files, insertions, deletions, stat };
}

/**
 * Drop a scope that changed nothing, branch included.
 *
 * The only case where deleting is right, and the opposite of the mistake this
 * module exists to avoid: there is provably nothing to lose, and a list of
 * empty scopes is a list nobody reads.
 */
export async function discardEmptyScope(root: string, scope: WorktreeScope): Promise<void> {
	await git(root, ["worktree", "remove", "--force", scope.path]).catch(() => undefined);
	await git(root, ["branch", "-D", scope.branch]).catch(() => undefined);
	// The base ref too, or re-creating the scope would reuse a stale base and
	// report a diff against a tree that no longer relates to it.
	const slug = scope.branch.split("/").pop() ?? "scope";
	const runId = scope.branch.split("/").at(-2) ?? "";
	await git(root, ["update-ref", "-d", `refs/pi-workflow-base/${runId}/${slug}`]).catch(() => undefined);
}

/** Clear registrations left behind when a run directory was pruned. */
export async function pruneWorktrees(root: string): Promise<void> {
	await git(root, ["worktree", "prune"]).catch(() => undefined);
}
