/**
 * Tunables for the scratchpad.
 */

export const SETTINGS_KEY = "scratchpad";

export const CONFIG = {
	/**
	 * Parent directory name under the system temp dir, before the uid segment.
	 *
	 * Under `/tmp`, not under `~/.pi`. That is the whole safety argument: this
	 * repo is a git repo and a public one, and a scratch file written inside it
	 * shows up in `git status`, gets swept up by a directory-wide `git add`, and
	 * is then published. A .gitignore entry would work right up until the day it
	 * did not. Somewhere the repo cannot reach is a stronger guarantee than a
	 * pattern that has to stay correct.
	 */
	rootName: "pi-scratchpad",

	/**
	 * Session directories untouched for this long are removed on the next start.
	 *
	 * Shorter than rewind's 30 days on purpose: file history is something you go
	 * back and use, a scratchpad is working space you have already got the value
	 * out of. A week covers "what was that script I wrote on Friday".
	 */
	pruneAfterDays: 7,

	/** Files listed by `/scratchpad` before the rest collapse into a count. */
	maxListed: 20,
};
