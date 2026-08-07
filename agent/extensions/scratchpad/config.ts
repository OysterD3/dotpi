/**
 * Settings and shared constants for the scratchpad.
 */

export const SETTINGS_KEY = "scratchpad";

export type ScratchpadSettings = {
	enabled: boolean;
	/**
	 * Where the per-user root goes. Empty means `os.tmpdir()`, which is the right
	 * answer nearly always — see paths.ts for why TMPDIR beats a hardcoded `/tmp`.
	 * Set it to `/tmp` if you want the shorter, more memorable path back.
	 */
	root: string;
};

export function defaultSettings(): ScratchpadSettings {
	return { enabled: true, root: "" };
}

/**
 * Where the session's scratchpad is announced, and by whom.
 *
 * The permissions extension listens here and stops asking about writes that land
 * inside it — that is the entire mechanism behind "no approval prompt", because
 * a `tool_call` handler can only ever *block* a call, never clear one, so the
 * allow has to come from inside permissions' own decision engine.
 *
 * The channel string is duplicated on both sides rather than imported, matching
 * `WORKSPACE` and `AUTO.spendChannel` in permissions/config.ts and the rest of
 * this repo: every extension installs on its own, so the two sides share a
 * string, not a module. With permissions not installed nothing listens and
 * nothing breaks; with scratchpad not installed nothing publishes and
 * permissions simply never has a scratch directory to exempt.
 *
 * Announced once per session start, with the absolute path. There is no
 * "removed" message: the directory lives as long as the session does.
 */
export const ANNOUNCE = {
	channel: "scratchpad:dir",
};

export const CONFIG = {
	/**
	 * Cap on the slugified project path (see paths.ts).
	 *
	 * A deep cwd slugs to a long single path segment, and segments have their own
	 * limit (255 bytes on ext4/APFS) well below PATH_MAX. The tail is kept rather
	 * than the head because that is the distinctive part — `…-projects-app` tells
	 * you which project, `-Users-oysterlee-…` does not. Two projects colliding
	 * after truncation is harmless: the session directory below is unique, so
	 * they share a parent and nothing else.
	 */
	slugChars: 120,

	/** Top-level entries listed by `/scratchpad` before the rest become a count. */
	listLimit: 20,
};
