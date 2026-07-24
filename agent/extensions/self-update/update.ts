/**
 * The update itself: resolve the repo root, remember HEAD, pull with rebase +
 * autostash, and report only if HEAD actually moved.
 *
 * `--rebase --autostash` is what makes this safe on a machine that edits its own
 * config: pi rewrites settings.json at runtime, so the working tree is usually
 * dirty; autostash tucks those changes away, pulls, and reapplies them, and
 * rebase replays any local commits on top. If the pull fails (offline, or a
 * genuine conflict), the rebase is aborted so the tree is left clean, and the
 * run stays silent — a stale checkout is better than a nagging banner or a
 * half-rebased repo. All git access goes through an injected `exec`, so the
 * whole flow is testable without a real repository.
 */

export type ExecResult = { stdout: string; stderr: string; code: number | null };
export type Exec = (command: string, args: string[], opts?: { timeout?: number }) => Promise<ExecResult>;
export type Notify = (message: string, level: "info" | "warning" | "error") => void;

export type UpdateStatus = "updated" | "noop" | "failed" | "not-repo";
export interface UpdateOutcome {
	status: UpdateStatus;
	newCommits?: number;
}

async function git(exec: Exec, args: string[], timeoutMs: number): Promise<ExecResult> {
	return exec("git", args, { timeout: timeoutMs });
}

export async function repoRoot(exec: Exec, cwd: string, timeoutMs: number): Promise<string | null> {
	const res = await git(exec, ["-C", cwd, "rev-parse", "--show-toplevel"], timeoutMs);
	return res.code === 0 ? res.stdout.trim() || null : null;
}

export async function head(exec: Exec, root: string, timeoutMs: number): Promise<string | null> {
	const res = await git(exec, ["-C", root, "rev-parse", "HEAD"], timeoutMs);
	return res.code === 0 ? res.stdout.trim() || null : null;
}

export async function pull(exec: Exec, root: string, timeoutMs: number): Promise<ExecResult> {
	return git(exec, ["-C", root, "pull", "--rebase", "--autostash"], timeoutMs);
}

async function abortRebase(exec: Exec, root: string, timeoutMs: number): Promise<void> {
	// Best effort: errors (e.g. "no rebase in progress") are expected and ignored.
	try {
		await git(exec, ["-C", root, "rebase", "--abort"], timeoutMs);
	} catch {
		/* ignore */
	}
}

async function newCommitCount(exec: Exec, root: string, oldHead: string, timeoutMs: number): Promise<number> {
	const res = await git(exec, ["-C", root, "rev-list", "--count", `${oldHead}..HEAD`], timeoutMs);
	const n = Number.parseInt(res.stdout.trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

export async function runUpdate(exec: Exec, agentDir: string, notify: Notify, timeoutMs: number): Promise<UpdateOutcome> {
	const root = await repoRoot(exec, agentDir, timeoutMs);
	if (!root) return { status: "not-repo" };

	const before = await head(exec, root, timeoutMs);
	if (!before) return { status: "not-repo" };

	const pulled = await pull(exec, root, timeoutMs);
	if (pulled.code !== 0) {
		await abortRebase(exec, root, timeoutMs);
		return { status: "failed" };
	}

	const after = await head(exec, root, timeoutMs);
	if (after && after !== before) {
		const newCommits = await newCommitCount(exec, root, before, timeoutMs);
		notify(
			`pi config updated${newCommits > 0 ? ` (${newCommits} new commit${newCommits === 1 ? "" : "s"})` : ""} — restart pi or /reload to apply.`,
			"info",
		);
		return { status: "updated", newCommits };
	}
	return { status: "noop" };
}
