/**
 * Worktree scopes, against a REAL git repository in a temp dir.
 *
 * Mocked git would prove nothing here: every claim this module makes is a claim
 * about what git actually does — that a throwaway GIT_INDEX_FILE leaves the
 * user's index alone, that a scope starts from uncommitted work, that a branch
 * survives the callback. Those are only true if git says so.
 *
 * Run: node --experimental-transform-types agent/extensions/ultracode/worktree.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitScope, createScope, discardEmptyScope, pruneWorktrees, repoRoot, scopeChange, snapshotCommit } from "./worktree.ts";

const ROOT = mkdtempSync(join(tmpdir(), "wt-test-"));
const REPO = join(ROOT, "repo");
mkdirSync(REPO, { recursive: true });

const git = (args: string[], cwd = REPO) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "Test"]);
writeFileSync(join(REPO, "tracked.txt"), "one\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "initial"]);

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

console.log("--- repoRoot ---");
check("finds the root", await repoRoot(REPO), git(["rev-parse", "--show-toplevel"]));
check("undefined outside a repo", await repoRoot(tmpdir()), undefined);

console.log("\n--- snapshotCommit ---");
{
	// Clean tree: no new object, just HEAD. The common case must be free.
	check("a clean tree is HEAD", await snapshotCommit(REPO, "m"), git(["rev-parse", "HEAD"]));

	// Dirty tree, INCLUDING an untracked file — the case that matters, since a
	// scope is usually opened on work in progress.
	writeFileSync(join(REPO, "tracked.txt"), "one\ntwo\n");
	writeFileSync(join(REPO, "untracked.txt"), "new\n");
	const indexBefore = git(["status", "--porcelain"]);
	const snap = await snapshotCommit(REPO, "snapshot");
	check("a dirty tree gets its own commit", snap !== git(["rev-parse", "HEAD"]), true);
	check("the snapshot contains the edit", git(["show", `${snap}:tracked.txt`]), "one\ntwo");
	check("and the untracked file", git(["show", `${snap}:untracked.txt`]), "new");
	// The whole reason for the throwaway index: running this must not stage
	// anything, or a workflow could not be run on a dirty tree without
	// rearranging it underneath you.
	check("the real index is untouched", git(["status", "--porcelain"]), indexBefore);
	check("nothing was staged", git(["diff", "--cached", "--name-only"]), "");
}

console.log("\n--- a scope is a place, and it keeps the work ---");
const scopeDir = join(ROOT, "scopes");
{
	const scope = await createScope(REPO, scopeDir, "wf-1", "backend");
	check("the scope starts from the dirty tree", readFileSync(join(scope.path, "untracked.txt"), "utf8"), "new\n");
	check("on its own branch", /^pi\/wf\/wf-1\/backend-[0-9a-f]{8}$/.test(scope.branch), true);

	// An agent writes in the scope.
	writeFileSync(join(scope.path, "api.ts"), "export const x = 1\n");
	check("committing returns true when there was work", await commitScope(scope, "agent work"), true);
	check("and false when there is none", await commitScope(scope, "again"), false);

	const change = await scopeChange(scope);
	check("the change is measured against the base", change.files, 1);
	check("with line counts", [change.insertions, change.deletions], [1, 0]);

	// THE regression that matters. The other implementation force-removes the
	// worktree and deletes the branch in a finally, so the agent's work is gone
	// the moment it returns. Ours keeps both.
	const branches = git(["branch", "--list", scope.branch]);
	check("the branch SURVIVES", branches.includes(scope.branch), true);
	check("and the commit is on it", git(["show", `${scope.branch}:api.ts`]), "export const x = 1");
	// And the user's working tree is untouched by any of it.
	check("the project tree never saw api.ts", git(["status", "--porcelain"]).includes("api.ts"), false);
}

console.log("\n--- reuse: the same name is the same place ---");
{
	const again = await createScope(REPO, scopeDir, "wf-1", "backend");
	check("reopening finds the existing scope", readFileSync(join(again.path, "api.ts"), "utf8"), "export const x = 1\n");
}

console.log("\n--- two scopes do not collide ---");
{
	const a = await createScope(REPO, scopeDir, "wf-2", "alpha");
	const b = await createScope(REPO, scopeDir, "wf-2", "beta");
	check("different directories", a.path !== b.path, true);
	check("different branches", a.branch !== b.branch, true);
	// The point of isolation: both write the SAME path without destroying each
	// other, which is exactly what concurrent agents in one tree cannot do.
	writeFileSync(join(a.path, "shared.ts"), "from alpha\n");
	writeFileSync(join(b.path, "shared.ts"), "from beta\n");
	await commitScope(a, "alpha");
	await commitScope(b, "beta");
	check("alpha kept its version", readFileSync(join(a.path, "shared.ts"), "utf8"), "from alpha\n");
	check("beta kept its version", readFileSync(join(b.path, "shared.ts"), "utf8"), "from beta\n");
}

console.log("\n--- an empty scope is discarded ---");
{
	const empty = await createScope(REPO, scopeDir, "wf-3", "nothing");
	const change = await scopeChange(empty);
	check("it changed nothing", change.files, 0);
	await discardEmptyScope(REPO, empty);
	check("worktree gone", git(["worktree", "list"]).includes(empty.path), false);
	check("branch gone too — there was provably nothing to lose", git(["branch", "--list", empty.branch]), "");
}

console.log("\n--- long names do not collide ---");
{
	// The other implementation slugs `${runId}-${index}-${label}` and truncates
	// the WHOLE thing to 32 chars, so a long workflow name makes every agent
	// resolve to one path. Ours truncates only the scope slug and puts the runId
	// first, where it cannot be cut off.
	// Two names that are identical for the first 24 characters. Truncation alone
	// put both in ONE directory — caught here, which is why the digest exists.
	const long1 = await createScope(REPO, scopeDir, "wf-4", "an-extremely-long-scope-name-that-goes-well-past-any-limit-one");
	const long2 = await createScope(REPO, scopeDir, "wf-4", "an-extremely-long-scope-name-that-goes-well-past-any-limit-two");
	check("still distinct paths", long1.path !== long2.path, true);
	check("and distinct branches", long1.branch !== long2.branch, true);
	// Still recognisable on disk, not just a hash.
	check("the readable part survives", long1.path.includes("an-extremely-long-scope"), true);
}

console.log("\n--- a deleted run directory leaves git needing a prune ---");
{
	// The lifecycle bug. Retention deletes a run directory; any worktrees inside
	// it stay registered in the PROJECT's git as "prunable", and — verified here
	// rather than assumed — git then REFUSES to reuse that path at all.
	const runDir = join(ROOT, "doomed");
	const scope = await createScope(REPO, runDir, "wf-9", "temporary");
	writeFileSync(join(scope.path, "work.ts"), "kept\n");
	await commitScope(scope, "work");

	rmSync(runDir, { recursive: true, force: true });
	check("git still lists it", git(["worktree", "list"]).includes(scope.path), true);
	check("and calls it prunable", git(["worktree", "list"]).includes("prunable"), true);

	await pruneWorktrees(REPO);
	check("pruning clears the registration", git(["worktree", "list"]).includes(scope.path), false);
	// The branch is NOT collateral. Pruning a run's bookkeeping is not a
	// decision to throw away the work the run committed.
	check("but the branch survives the prune", git(["branch", "--list", scope.branch]).includes("pi/wf/wf-9"), true);
	check("with its commit intact", git(["show", `${scope.branch}:work.ts`]), "kept");
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
