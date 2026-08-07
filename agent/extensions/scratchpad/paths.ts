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
 * On Linux it is `/tmp`, on Windows `%TEMP%`. All of those spellings are already
 * recognised as scratch space by permissions/destructive.ts, which is what keeps
 * a cleanup `rm -rf` of a scratchpad from raising a prompt.
 *
 * Pure but for the caller passing in `tmp`, `uid` and the session id, so the
 * whole layout is testable as a table.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG } from "./config.ts";

/**
 * A configured `scratchpad.root`, made absolute.
 *
 * `~` has to be expanded here because nothing downstream will: `join` treats it
 * as an ordinary directory name, so `scratchpad.root: "~/scratch"` would create
 * a literal `~` folder next to wherever pi happened to be started. The absolute
 * resolution matters for a second, quieter reason — permissions refuses to
 * exempt a scratchpad that is not an absolute path, so a relative root would
 * create a working directory and silently lose the no-prompt half of the
 * feature, which is the failure nobody would think to look for.
 */
export function expandRoot(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
	return resolve(trimmed);
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

/** The full scratchpad path for one session. */
export function scratchpadPath(parts: PathParts): string {
	return join(
		parts.tmp,
		`pi-${parts.uid ?? "user"}`,
		projectSlug(parts.cwd),
		sessionSegment(parts.sessionId),
		"scratchpad",
	);
}
