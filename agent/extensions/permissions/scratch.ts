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
 * ## Paths are compared as text
 *
 * A symlink inside the scratchpad pointing at `~/.ssh/config` reads, to this
 * function, as a path inside the scratchpad. Resolving it would need the
 * filesystem, and this file — like destructive.ts, which reads `rm` targets
 * literally for the same reason — stays pure. It is consistent with what the
 * whole extension claims to be: a guardrail against an agent doing something you
 * did not intend, not a sandbox against one trying to escape. The agent would
 * have had to create that symlink itself, through a call this same policy saw.
 *
 * Pure: no filesystem, no pi APIs.
 */

import { isAbsolute, posix, resolve } from "node:path";
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
 */
function unprivate(path: string): string {
	return path.replace(/^\/private\/var\//, "/var/").replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
}

/** Is `child` the same directory as `parent`, or somewhere beneath it? */
export function isWithin(child: string, parent: string): boolean {
	const rel = posix.relative(unprivate(parent), unprivate(child));
	if (rel === "") return true;
	if (/(?:^|\/)\.\.(?:\/|$)/.test(rel)) return false;
	return !posix.isAbsolute(rel);
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
	const { tool, input, cwd, scratchDir } = call;

	if (!scratchDir) return false;
	if (!PATH_TOOLS.has(tool)) return false;
	if (!isAbsolute(scratchDir)) return false;

	const path = ruleTarget(tool, input);
	if (path === undefined || path.length === 0 || path.includes("\0")) return false;

	return isWithin(resolve(cwd, path), scratchDir);
}
