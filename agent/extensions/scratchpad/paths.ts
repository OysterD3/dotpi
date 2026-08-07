/**
 * Where the scratchpad lives, as a pure path computation.
 *
 * The shape is `<tmp>/pi-<uid>/<project-slug>/<session-id>/scratchpad`, and each
 * of the four levels is doing a job:
 *
 *   pi-<uid>        the system temp directory is shared by every user and every
 *                   process on the machine. A per-uid root created 0700 means two
 *                   users on one box never collide and never read each other's
 *                   working files. On a platform with no uid (Windows) the
 *                   segment degrades to `pi-user`, which is still ours and still
 *                   distinct from everyone else's temp files.
 *   <project-slug>  so `ls` in the root tells you which project a directory
 *                   belongs to. Same slugging as the memory store's
 *                   (non-alphanumerics to "-"), because a config that shows you
 *                   `-Users-me--pi` in one place should not show you a hash in
 *                   another.
 *   <session-id>    the isolation that matters. Two pi sessions in the same
 *                   project — the common case, one per terminal tab — must not
 *                   overwrite each other's `plan.md`. A resumed session (`pi -c`)
 *                   keeps its id, so it finds its own files again, and the path
 *                   in the system prompt is stable across the resume.
 *   scratchpad      a named leaf, so the session directory has room for anything
 *                   else that later wants to be session-scoped without turning
 *                   the scratchpad into a mixed bag.
 *
 * ## Why os.tmpdir() rather than a hardcoded /tmp
 *
 * `os.tmpdir()` honours `TMPDIR`, and on macOS that is already a per-user
 * directory under `/var/folders/…` that the OS reaps on its own. Hardcoding
 * `/tmp` would put files in the world-writable directory instead and lose that.
 * On Linux it is `/tmp`, on Windows `%TEMP%`.
 *
 * The default also gets something a custom `scratchpad.root` does not, and the
 * difference is worth stating precisely because this comment used to overclaim
 * it. `permissions/destructive.ts` recognises scratch space by a hardcoded list
 * of temp spellings (`/tmp/`, `/private/tmp/`, `/var/folders/`,
 * `/private/var/folders/`), and the auto classifier's prompt names the same
 * ones. Neither consults the announced scratchpad. So under the default root a
 * cleanup `rm -rf <scratch>` is exempt from the recursive-delete pattern and a
 * shell redirect into it reads as ordinary scratch work; under `~/scratch`,
 * neither is, and those bash calls prompt or get classified like any other path
 * outside the project. The path-tool exemption works for any root — it consults
 * the directory rather than a list — and permissions now puts the scratchpad in
 * the workspace it shows the classifier, which recovers most of the rest.
 *
 * Pure but for the caller passing in `tmp`, `uid` and the session id, so the
 * whole layout is testable as a table.
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { CONFIG } from "./config.ts";

/**
 * A configured `scratchpad.root`, with `~` expanded — or undefined when it is
 * not a usable root.
 *
 * `~` has to be expanded because nothing downstream will: `join` treats it as an
 * ordinary directory name, so `scratchpad.root: "~/scratch"` would create a
 * literal `~` folder next to wherever pi happened to be started.
 *
 * A *relative* root is rejected rather than resolved, which is the correction to
 * how this was first written. `resolve("scratch")` resolves against
 * `process.cwd()` — the project — so `scratchpad.root: "scratch"` quietly built
 * the scratchpad inside the user's repository and then had permissions
 * auto-approve every write into it, while the system prompt told the model the
 * directory was "outside the user's project, so nothing you put there shows up
 * in their diff". That is the exact failure the feature exists to prevent, with
 * the prompt suppressed as well. There is no sensible base to resolve against
 * here — the whole point of the setting is to name somewhere that is not the
 * project — so the honest answer is to refuse it and say so.
 */
export function expandRoot(input: string): string | undefined {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? normalize(trimmed) : undefined;
}

/**
 * The project's directory name, slugged the way the memory store slugs a cwd:
 * every non-alphanumeric becomes "-", so `/Users/me/.pi` reads `-Users-me--pi`.
 *
 * Truncated from the left when over-long — see CONFIG.slugChars for why the tail
 * is the half worth keeping.
 */
export function projectSlug(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	return slug.length <= CONFIG.slugChars ? slug : slug.slice(-CONFIG.slugChars);
}

/**
 * A session id reduced to something safe to use as one path segment.
 *
 * pi's ids are already uuid-shaped, so in practice this changes nothing. It
 * exists because the id reaches us as a string from the session file and ends up
 * concatenated into a filesystem path: a `../` in it would put the scratchpad
 * somewhere other than under our own root, and that is the one way this function
 * could matter. An empty result falls back to the process id, which is unique
 * among live sessions and — unlike a random suffix — stable for the process, so
 * nothing is lost mid-session.
 */
export function sessionSegment(sessionId: string | undefined): string {
	const cleaned = (sessionId ?? "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "");
	return cleaned.length > 0 ? cleaned : `pid-${process.pid}`;
}

export type PathParts = {
	/** The system temp directory, or a configured override. */
	tmp: string;
	/** `process.getuid?.()`, absent on platforms that have no such thing. */
	uid: number | undefined;
	cwd: string;
	sessionId: string | undefined;
};

/**
 * The per-user root, `<tmp>/pi-<uid>`.
 *
 * Split out because it is the one level that has to be created and verified on
 * its own before anything is made under it — it is the boundary between the
 * shared temp directory and ours, and so the only place a symlink another user
 * planted can be caught (see prepareRoot in index.ts). It was briefly inlined
 * back when the only caller was `scratchpadPath`.
 */
export function userRoot(tmp: string, uid: number | undefined): string {
	return join(tmp, `pi-${uid ?? "user"}`);
}

/** The scratchpad for one session, below an already-verified root. */
export function scratchpadUnder(root: string, cwd: string, sessionId: string | undefined): string {
	return join(root, projectSlug(cwd), sessionSegment(sessionId), "scratchpad");
}

/** The full scratchpad path for one session. */
export function scratchpadPath(parts: PathParts): string {
	return scratchpadUnder(userRoot(parts.tmp, parts.uid), parts.cwd, parts.sessionId);
}
