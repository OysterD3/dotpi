/**
 * The session scratchpad, and why a write into it never asks.
 *
 * The scratchpad extension creates one directory per session under the system
 * temp directory and tells the model to put every temporary file there. It
 * announces the path on `scratchpad:dir`; index.ts keeps the last one it saw and
 * passes it into `decide`, which treats a path-tool call landing inside it
 * exactly as if an `allow` rule had matched.
 *
 * ## Why this is worth a rule of its own
 *
 * Only `write` and `edit` actually change, and that is the whole point rather
 * than a limitation. In `auto` mode `read`, `grep`, `find` and `ls` are already
 * waved through by `skipReadOnly`, and bash is deliberately left alone below —
 * so what is left is the one operation the scratchpad exists for. Without this,
 * every scratch file the model writes costs a classifier call and can come back
 * as a prompt, and a model that expects to interrupt its user for a throwaway
 * file writes fewer of them. Making the promise in the system prompt ("writes
 * here are pre-approved") true is what makes the directory get used.
 *
 * ## What it deliberately does not cover
 *
 * `bash` is not exempted. A command is not judged by the paths it mentions:
 * `curl … > $SCRATCH/x.sh && sh $SCRATCH/x.sh` writes only inside the scratchpad
 * and is exactly the thing the classifier exists to catch. Bash keeps going to
 * the classifier, whose own prompt already treats scratch space as safe *as a
 * destination* and unsafe as a source of code to run.
 *
 * Nothing here can loosen a `deny` rule or the destructive table — the check
 * sits at the allow step, which both of those have already run ahead of. So
 * `Read(**\/.env)` still blocks a `.env` inside the scratchpad, and `denyAll` is
 * excluded outright: its allow rules are the only way anything runs at all, and
 * an implicit rule that is not written in any settings file has no business
 * being one of them.
 *
 * ## Two halves, because text is not enough
 *
 * `targetsScratchpad` and `usableScratchDir` are pure — they are what decide.ts
 * calls, and decide.ts stays table-testable. But a purely lexical answer is not
 * safe on its own: a symlink inside the scratchpad pointing at `~/.ssh/id_rsa`
 * reads, to a text comparison, as a path inside the scratchpad. So
 * `escapesScratchpad` confirms the lexical answer against the filesystem, and
 * index.ts calls it on the one decision that needs it, keeping the fs access out
 * of the precedence engine. See its own header for why the earlier "the agent
 * would have had to create that symlink itself" argument did not hold.
 *
 * This is still a guardrail rather than a sandbox — a check outside the syscall
 * can always be raced — but the gap is now a race window rather than a standing
 * invitation.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ruleTarget } from "./rules.ts";
import { PATH_TOOLS } from "./tools.ts";

/**
 * `/private/var/…` and `/private/tmp/…` name the same places as `/var` and
 * `/tmp`. macOS resolves the temp directory to one spelling and hands tools the
 * other, so both sides are rewritten before comparing — without it a scratchpad
 * announced as `/private/var/folders/…/scratchpad` would not contain the
 * `/var/folders/…/scratchpad/plan.md` the model just asked to write. Duplicated
 * from add-dir/paths.ts rather than imported: every extension in this repo
 * installs on its own.
 *
 * Only on macOS, which the copy this was taken from gets wrong. The rewrite
 * asserts that two spellings name one directory, and that is a fact about
 * macOS's layout, not about path syntax. On Linux `/private/tmp` is an ordinary
 * directory nobody promised anything about, so rewriting it there makes a write
 * to `/private/tmp/…/scratchpad/x` — a different file entirely — compare as
 * inside the scratchpad and skip its prompt.
 */
const REWRITE_PRIVATE = process.platform === "darwin";

function unprivate(path: string): string {
	if (!REWRITE_PRIVATE) return path;
	return path.replace(/^\/private\/var\//, "/var/").replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
}

/**
 * Is `child` the same directory as `parent`, or somewhere beneath it?
 *
 * Platform-native `relative`, not `posix.relative`. The paths reaching this come
 * from `resolve`/`join`, so on Windows they are backslash-separated, and
 * `posix.relative` sees no separator at all in one of those: it treats the whole
 * string as a single relative segment, resolves it against the process cwd, and
 * returns something starting `..`. Every containment test then answers false and
 * the exemption silently never fires on Windows — the failure mode that looks
 * like the feature working, since nothing errors and calls merely keep
 * prompting. Native `relative` also case-folds on Windows, which is correct
 * there and must not be done on the case-sensitive platforms.
 */
export function isWithin(child: string, parent: string): boolean {
	const rel = relative(unprivate(parent), unprivate(child));
	if (rel === "") return true;
	if (rel.split(/[\\/]/).includes("..")) return false;
	return !isAbsolute(rel);
}

/**
 * Is this announced directory one we are willing to stop prompting for?
 *
 * The channel is the trust boundary, and before this there was none: the
 * subscriber took any non-empty string, so a single `{ dir: "/" }` from any
 * extension in the session — or from a buggy one that picked the same channel
 * name — made `isWithin(anything, "/")` true and turned off prompting for every
 * `read`, `write` and `edit` on the machine, permanently, with nothing in the
 * UI saying so. Extensions are not a security boundary against each other, but
 * "unbounded" and "bounded to a directory that cannot contain your project" are
 * very different blast radii for an accident, and the bound is four lines.
 *
 * The rules, each rejecting rather than reasoning:
 *
 *   - Absolute, no NUL. A relative scratchpad has no fixed meaning here.
 *   - It must not contain the working directory. That is what rejects `/`,
 *     `/Users`, `/home/me`, and the repo's own parent — every directory whose
 *     exemption would cover the project itself.
 *   - It must not be inside the working directory. A scratchpad in the repo is
 *     the thing the whole feature exists to prevent; auto-approving writes there
 *     would be the exact failure with the prompt removed as well.
 *   - At least two segments below the filesystem root, so a bare `/tmp` — shared
 *     with every process on the machine — cannot be the exempt directory.
 *
 * Judged against the cwd on every call rather than once at announce time,
 * because the cwd is what the second and third rules are relative to and this
 * file never sees a session.
 */
export function usableScratchDir(dir: string | undefined, cwd: string): string | undefined {
	if (!dir || dir.includes("\0") || cwd.includes("\0")) return undefined;
	if (!isAbsolute(dir)) return undefined;

	const segments = dir.split(/[\\/]/).filter((segment) => segment.length > 0);
	if (segments.length < 2) return undefined;

	if (isWithin(cwd, dir)) return undefined;
	if (isWithin(dir, cwd)) return undefined;

	return dir;
}

/**
 * True when this call is a path tool writing to, editing, or reading a path
 * inside the scratchpad.
 *
 * The path comes out of `ruleTarget`, the same extraction the rule engine uses,
 * rather than reading `input.path` here. That keeps one idea of "the path this
 * call targets": if pi ever moves or renames the key, `rules.ts` gets fixed and
 * this follows, instead of silently returning false forever and quietly costing
 * the exemption. `ruleTarget` also answers for bash, hence the PATH_TOOLS guard
 * above it rather than after.
 *
 * Relative paths are resolved against the cwd first, the way the tool itself
 * will resolve them, so `write` with `../../tmp/…` is judged on where it lands
 * rather than on how it was spelled. A null byte rejects for the ordinary reason
 * that it is never legitimate in a path — not because anything here would throw
 * on one; `resolve` carries a NUL through happily, and it is Node's fs layer
 * that eventually refuses it.
 *
 * Takes the `Call` shape rather than four positional arguments: `cwd` and
 * `scratchDir` are adjacent absolute-directory strings, which is exactly the
 * pair a positional signature invites a caller to swap.
 */
export type ScratchCall = {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	scratchDir?: string;
};

export function targetsScratchpad(call: ScratchCall): boolean {
	const { tool, input, cwd } = call;

	if (!PATH_TOOLS.has(tool)) return false;

	const scratchDir = usableScratchDir(call.scratchDir, cwd);
	if (!scratchDir) return false;

	const path = ruleTarget(tool, input);
	if (path === undefined || path.length === 0 || path.includes("\0")) return false;

	return isWithin(resolve(cwd, path), scratchDir);
}

/**
 * The impure half: does this path only *look* like it is in the scratchpad?
 *
 * `targetsScratchpad` compares text, and the comment that used to sit here
 * argued the residual symlink risk was bounded because "the agent would have had
 * to create that symlink itself, through a call this same policy saw". That
 * argument was wrong, and worth recording as wrong rather than quietly deleting:
 * the call that creates the symlink is a `bash` one, and bash in the scratchpad
 * goes to the classifier, whose own prompt says in capitals that scratch space
 * is SAFE and that the carve-out "is about WHERE THE FILE LANDS and nothing
 * else". So `ln -s ~/.ssh/id_rsa <scratch>/notes.txt` is precisely the call that
 * gets waved through, and the following `read` was then lexically inside the
 * scratchpad and exempt. The policy was clearing a call it should not.
 *
 * So the lexical answer is confirmed against the filesystem before it is acted
 * on. A path that does not exist yet — every fresh `write` — is resolved to its
 * deepest existing ancestor, which is what catches a planted `link -> /home/me`
 * being written *through*. An unreadable or missing scratchpad root resolves to
 * nothing and is treated as an escape, since failing closed here only costs a
 * prompt.
 *
 * This is TOCTOU-racy in the strict sense — the symlink could be planted between
 * this check and the tool's own `open`. That is inherent to a check that is not
 * inside the syscall, and it is a much narrower window than "no check at all".
 * It stays out of decide.ts so the precedence engine can remain pure and
 * table-testable; index.ts calls it on the one decision that needs it.
 */
export function escapesScratchpad(path: string, cwd: string, scratchDir: string): boolean {
	const root = realOrNearest(scratchDir);
	if (root === undefined) return true;

	const target = realOrNearest(resolve(cwd, path));
	if (target === undefined) return true;

	return !isWithin(target, root);
}

/**
 * `path` with every symlink in its existing prefix resolved, and the part that
 * does not exist yet appended unchanged.
 *
 * The loop is bounded rather than `while (true)`: `dirname` reaching a fixed
 * point is the intended exit, but a bound means a path this file did not
 * anticipate cannot hang a permission check.
 */
function realOrNearest(path: string): string | undefined {
	let current = path;

	for (let depth = 0; depth < 64; depth++) {
		try {
			return resolve(realpathSync(current), relative(current, path));
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}

	return undefined;
}
