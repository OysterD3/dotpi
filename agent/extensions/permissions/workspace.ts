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
 * Pure but for `homedir()`, so the resolution is testable as a table — except
 * `escapesWorkspace` at the end, which reads the filesystem on purpose.
 *
 * The same list is what `acceptChanges` lets edits into without a prompt; the
 * second half of this file is that check.
 */

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTECTED } from "./config.ts";
import { ruleTarget } from "./rules.ts";
import { isWithin, realOrNearest } from "./scratch.ts";

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

/** pi's own set, from its utils/paths.js: these become a plain space in a tool path. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The absolute path pi's write and edit tools will actually touch, or undefined
 * when there is no such path.
 *
 * A copy of pi's `resolveToCwd` (not exported from the package): an `@` prefix
 * is dropped, `~` is the home directory, and a `file://` URL is a path. A plain
 * `resolve(cwd, path)` gets all three wrong in the dangerous direction — it
 * reads `~/.zshrc` as `<cwd>/~/.zshrc`, inside the workspace, while the tool
 * writes the real one. `join`, not `resolve`, after the tilde, as pi does:
 * `~//work/x` is under the home directory, not `/work/x`.
 */
export function resolveToolPath(path: string, cwd: string): string | undefined {
	if (path.includes("\0")) return undefined;
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32") normalized = windowsShellPath(normalized);
	if (normalized === "~") return resolve(homedir());
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return resolve(join(homedir(), normalized.slice(2)));
	}
	if (normalized.startsWith("file://")) {
		try {
			return resolve(fileURLToPath(normalized));
		} catch {
			return undefined;
		}
	}
	return resolve(cwd, normalized);
}

/** pi's normalizeWindowsShellPath: `/c/x`, `/mnt/c/x` and `/cygdrive/c/x` are `C:\x`. */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
	if (!match) return path;
	return `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

export type WorkspaceCall = {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	/** The workspace directories, as `workspaceDirs` builds them. */
	workspace?: readonly string[];
	/** pi's agent dir, whose config files (PROTECTED.agentFiles) are protected wherever they are. */
	agentDir?: string;
};

/**
 * True when this call is a `write` or `edit` whose path lands inside the
 * workspace and on no protected path (PROTECTED in config.ts) — as text.
 *
 * Text is not enough on its own, for the same reason as in scratch.ts: a
 * symlink inside the workspace can point anywhere. index.ts confirms a yes with
 * `escapesWorkspace` below.
 */
export function editsWorkspace(call: WorkspaceCall): boolean {
	if (call.tool !== "write" && call.tool !== "edit") return false;
	const path = ruleTarget(call.tool, call.input);
	if (path === undefined || path.length === 0) return false;
	const target = resolveToolPath(path, call.cwd);
	return target !== undefined && insideUnprotected(target, call.workspace ?? [], call.agentDir);
}

/**
 * The impure half: does this edit only *look* like it is in the workspace?
 * The target and every workspace directory are resolved through their symlinks
 * (see realOrNearest in scratch.ts), and the question is asked again. A link
 * from the workspace to `~/.ssh`, or from `docs/` into `.git/hooks`, escapes,
 * and so does a dangling one.
 *
 * A file with more than one hard link escapes too. Its other names can be
 * anywhere on the same volume, and nothing here can find them; an edit that
 * changes `~/.bashrc` through a second name in the workspace is still an edit to
 * `~/.bashrc`. Hard links in a working tree are rare, so this costs a prompt
 * almost never.
 */
export function escapesWorkspace(call: WorkspaceCall): boolean {
	const path = ruleTarget(call.tool, call.input);
	const target = path === undefined ? undefined : resolveToolPath(path, call.cwd);
	const real = target === undefined ? undefined : realOrNearest(target);
	if (real === undefined || linkCount(real) > 1) return true;
	const roots = (call.workspace ?? []).map(realOrNearest).filter((root): root is string => root !== undefined);
	const agentDir = call.agentDir === undefined ? undefined : realOrNearest(call.agentDir);
	if (call.agentDir !== undefined && agentDir === undefined) return true;
	return !insideUnprotected(real, roots, agentDir);
}

/**
 * Inside at least one directory, and protected below none of them. Checked
 * against every directory that contains the path, so a directory added inside
 * another one cannot make a protected path look unprotected.
 */
function insideUnprotected(target: string, dirs: readonly string[], agentDir: string | undefined): boolean {
	if (agentDir !== undefined && PROTECTED.agentFiles.some((name) => fold(join(agentDir, name)) === fold(target))) return false;
	const containing = dirs.filter((dir) => isWithin(target, dir));
	return containing.length > 0 && !containing.some((dir) => isProtected(target, dir));
}

/** 0 for a path that does not exist yet. */
function linkCount(path: string): number {
	try {
		const stats = lstatSync(path);
		return stats.isFile() ? stats.nlink : 0;
	} catch {
		return 0;
	}
}

const PROTECTED_DIRS = PROTECTED.dirs.map((dir) => dir.split("/"));
const PROTECTED_FILES = new Set<string>(PROTECTED.files);

/**
 * A name as a case-insensitive file system compares it. `toLowerCase` alone is
 * not that: APFS also folds `ſ` to `s` and `ﬁ` to `fi`, so `.vſcode` names the
 * real `.vscode`. NFKC does those compatibility folds first.
 */
function fold(segment: string): string {
	return segment.normalize("NFKC").toLowerCase();
}

function isProtected(target: string, dir: string): boolean {
	const segments = relative(dir, target).split(/[\\/]/).map(fold);
	if (PROTECTED_FILES.has(segments[segments.length - 1] ?? "")) return true;
	return segments.some((_, at) => PROTECTED_DIRS.some((parts) => parts.every((part, offset) => segments[at + offset] === part)));
}
