/**
 * The directory set the classifier is told is in scope.
 *
 * Half of what auto mode judges is "is this path inside the project", so being
 * wrong about which directories count is the difference between a mode you keep
 * on and one that prompts for every write to the second repo you are working in.
 *
 * Two sources, because there are two ways a directory gets into a workspace and
 * only one of them is written down:
 *
 *   persisted  `permissions.additionalDirectories` in the settings files, read
 *              by settings.ts under the same trust rule as `allow`
 *   session    `/add-dir`, which lives only in the conversation and reaches us
 *              over the event bus (see WORKSPACE in config.ts)
 *
 * Reading the settings key here duplicates what the add-dir extension does with
 * it, and that is deliberate rather than an oversight. Every extension in this
 * repo installs on its own; permissions must not stop understanding its own
 * settings file because a *different* extension is missing. The event channel
 * then adds what a file cannot know — and because both feed the same dedupe, a
 * directory arriving from both sources costs nothing.
 *
 * Pure but for `homedir()`, so the resolution is testable as a table.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Expand `~` and resolve against the working directory, or undefined when the
 * entry is not a usable path.
 *
 * A hand-edited `~/projects/lib` has to behave like one typed at the prompt, or
 * the classifier is shown a literal tilde that matches nothing the agent writes
 * — which looks exactly like the bug this file exists to fix. The null-byte
 * rejection matches add-dir's: a NUL in a path is never legitimate, and every fs
 * call would throw on it anyway.
 */
export function expandDir(input: string, cwd: string): string | undefined {
	if (input.includes("\0") || cwd.includes("\0")) return undefined;

	const trimmed = input.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed === "~") return resolve(homedir());
	if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));

	return resolve(cwd, trimmed);
}

/**
 * The workspace, current directory first and everything else in the order it was
 * given, with duplicates dropped.
 *
 * cwd leads because the classifier is told the first entry is the one relative
 * paths resolve against, and it is unconditionally present: a settings file that
 * also lists it, or lists it spelled differently, must not be able to displace
 * it or double it up.
 */
export function workspaceDirs(cwd: string, ...lists: ReadonlyArray<readonly string[]>): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];

	const push = (dir: string) => {
		if (seen.has(dir)) return;
		seen.add(dir);
		dirs.push(dir);
	};

	push(resolve(cwd));
	for (const list of lists) {
		for (const raw of list) {
			const absolute = expandDir(raw, cwd);
			if (absolute) push(absolute);
		}
	}

	return dirs;
}
