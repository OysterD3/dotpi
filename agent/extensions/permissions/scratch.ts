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
 * destination* and unsafe as a source of code to run — unless it is shown the
 * code, which is what `scratchScripts` below is for.
 *
 * Nothing here can loosen a `deny` rule or the destructive table — the check
 * sits at the allow step, which both of those have already run ahead of. So
 * `Read(**\/.env)` still blocks a `.env` inside the scratchpad.
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

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { AUTO } from "./config.ts";
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

/** Extensions of the files an interpreter runs as a script. */
const SCRIPT_FILE = /\.(?:py|js|mjs|cjs|ts|mts|cts|sh|bash|zsh|rb|pl|php|lua)$/;

/**
 * The words of a command as the shell will pass them, quotes removed.
 *
 * Not a shell parser. It has to be right about one thing — which strings are
 * one whole argument — so that `python3 "/tmp/a /S/x.py"` is not read as
 * naming `/S/x.py`. Syntax it cannot follow exactly makes it give up
 * (undefined): a heredoc, whose body can hold an odd quote that turns every
 * word after it inside out; `$'…'`; a command substitution; a backtick; a
 * quote left open. A word holding an expansion — `$`, a glob, brace, or a
 * leading `~` — is left out, since its value is not known here.
 */
export function plainWords(command: string): string[] | undefined {
	if (/<<|\$['"(]|`/.test(command)) return undefined;

	const words: string[] = [];
	let word = "";
	let open = false;
	let known = true;
	let quote: "'" | '"' | undefined;
	const end = () => {
		if (open && known) words.push(word);
		word = "";
		open = false;
		known = true;
	};

	for (let at = 0; at < command.length; at++) {
		const char = command[at]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\" && /["\\$`\n]/.test(command[at + 1] ?? "")) word += command[++at];
			else {
				if (char === "$") known = false;
				word += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			open = true;
		} else if (char === "\\") {
			word += command[++at] ?? "";
			open = true;
		} else if (/\s/.test(char) || ";&|<>()".includes(char)) {
			end();
		} else if (char === "#" && !open) {
			const eol = command.indexOf("\n", at);
			if (eol < 0) break;
			at = eol;
		} else {
			if ("$*?[{".includes(char) || (char === "~" && !open)) known = false;
			word += char;
			open = true;
		}
	}
	if (quote) return undefined;
	end();
	return words;
}

/**
 * The scratchpad scripts a bash command names, with their text as it is now.
 *
 * The classifier is shown only the command, and its prompt says code it cannot
 * read is unsafe. So `python3 <scratch>/check.py` was flagged nearly every
 * time — "runs a script whose contents are not shown" — although the agent
 * wrote that file itself a moment earlier. The write never went to the
 * classifier either: path-tool writes into the scratchpad are exempt (above).
 * Showing the text lets the classifier judge the script the way it judges a
 * `python -c` snippet. The model still decides; it is given more to read.
 *
 * Only absolute paths. A relative name depends on where the command is when it
 * runs, and a guess at that is a file shown under a label while another one
 * runs; the agent writes the absolute path in practice anyway.
 *
 * Only files that are really inside the scratchpad. `realpathSync.native` is
 * the file the kernel will open: Node's own `realpathSync` removes `sub/..` as
 * text first, so with `sub` a symlink out of the scratchpad it passed a check
 * on one file while the read got another. This is a read no tool call makes,
 * so neither a symlink nor a hard link named `x.py` may be how a key reaches
 * the classifier's provider; index.ts also drops a file a `deny` rule covers.
 * A file that is not text is not shown: a zip runs as a `.py` too.
 *
 * The text is what is on disk when the check runs. index.ts asks for it only
 * when no other call in the same batch can change the file first, and reads it
 * again after the verdict; the classifier is told that a command which changes
 * the file itself makes the text shown out of date.
 */
export function scratchScripts(
	command: string,
	cwd: string,
	scratchDir: string | undefined,
): { path: string; real: string; text: string }[] {
	const dir = usableScratchDir(scratchDir, cwd);
	if (!dir) return [];
	const words = plainWords(command);
	if (!words) return [];

	const found = new Map<string, { path: string; real: string; text: string }>();
	try {
		const root = realpathSync.native(dir);
		for (const word of words) {
			if (found.size >= AUTO.scriptFiles) break;
			if (!isAbsolute(word) || !SCRIPT_FILE.test(word)) continue;
			try {
				const real = realpathSync.native(word);
				if (found.has(real) || !isWithin(real, root)) continue;
				const stats = statSync(real);
				if (!stats.isFile() || stats.nlink > 1 || stats.size > AUTO.scriptBytes) continue;
				const text = readFileSync(real, "utf8");
				if (text.includes("\u0000") || text.includes("\uFFFD")) continue;
				found.set(real, { path: word, real, text });
			} catch {
				// Gone or unreadable: left unshown, which is where it was before.
			}
		}
	} catch {
		// No scratchpad on disk: nothing to show.
	}
	return [...found.values()];
}

/**
 * `path` with every symlink in its existing prefix resolved, and the part that
 * does not exist yet appended unchanged.
 *
 * An entry that exists but does not resolve — a dangling symlink, or a loop —
 * is undefined, not "a file that does not exist yet": a write follows a
 * dangling link and creates its target, wherever that is, so walking up past
 * it would judge the link's own directory instead.
 *
 * The loop is bounded rather than `while (true)`: `dirname` reaching a fixed
 * point is the intended exit, but a bound means a path this file did not
 * anticipate cannot hang a permission check.
 */
export function realOrNearest(path: string): string | undefined {
	let current = path;

	for (let depth = 0; depth < 64; depth++) {
		try {
			return resolve(realpathSync(current), relative(current, path));
		} catch {
			if (exists(current)) return undefined;
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}

	return undefined;
}

/** Whether an entry is there at all, a symlink itself and not its target. */
function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
