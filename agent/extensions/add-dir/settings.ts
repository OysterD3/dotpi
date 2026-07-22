/**
 * Reading and writing `permissions.additionalDirectories`.
 *
 * The key sits inside the same `permissions` block the permissions extension
 * uses, and is spelled the way Claude Code spells it, so a settings file is
 * recognisable to anyone who has configured Claude Code:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * Reading follows the same trust rule as the permissions extension: an untrusted
 * project's list is ignored. A directory in this list is a directory the model is
 * told it may edit, so a cloned repo must not be able to nominate one.
 *
 * Writing is the interesting part. pi has no API for keys it does not know about,
 * so this writes settings.json itself — which means it has to not lose a
 * concurrent write from pi. pi guards its own writes with proper-lockfile, whose
 * lock is a *directory* at `<file>.lock` created with `mkdir`. Creating that same
 * directory is therefore real mutual exclusion against pi, not a private
 * convention, and it needs no dependency. Verified against the bundled
 * proper-lockfile 4.x rather than assumed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG, SETTINGS_KEY } from "./config.ts";

export type LoadedDirs = {
	/**
	 * One group per settings file that contributed, global before project. Grouped
	 * rather than flattened so a directory remembers which file to remove it from.
	 */
	sources: Array<{ path: string; dirs: string[] }>;
	warnings: string[];
};

export function userSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

function readList(path: string, warnings: string[]): string[] | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const permissions = parsed.permissions;
		if (!permissions || typeof permissions !== "object") return undefined;

		const value = (permissions as Record<string, unknown>)[SETTINGS_KEY];
		if (value === undefined) return undefined;
		if (!Array.isArray(value)) {
			warnings.push(`${path}: ${SETTINGS_KEY} must be an array of directory paths`);
			return undefined;
		}
		return value.filter((item): item is string => typeof item === "string" && item.length > 0);
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export function loadPersisted(agentDir: string, cwd: string, projectTrusted: boolean): LoadedDirs {
	const warnings: string[] = [];
	const sources: Array<{ path: string; dirs: string[] }> = [];

	const userPath = userSettingsPath(agentDir);
	const user = readList(userPath, warnings);
	if (user && user.length > 0) sources.push({ path: userPath, dirs: user });

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const project = readList(projectPath, warnings);
		if (project && project.length > 0) {
			if (projectTrusted) {
				sources.push({ path: projectPath, dirs: project });
			} else {
				warnings.push(
					`${projectPath}: ignoring ${project.length} additional working ${project.length === 1 ? "directory" : "directories"} — project is not trusted`,
				);
			}
		}
	}

	return { sources, warnings };
}

/**
 * Run `update` against the parsed file with pi's own lock held, and write back
 * whatever it returns. Returning undefined means "nothing to change".
 */
function editSettings(
	path: string,
	update: (settings: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
	const exists = existsSync(path);
	const release = exists ? acquireLock(path) : undefined;

	try {
		let current: Record<string, unknown> = {};
		if (exists) {
			const raw = readFileSync(path, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`${path} is not a JSON object`);
			}
			current = parsed as Record<string, unknown>;
		}

		const next = update(current);
		if (next === undefined) return;

		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		// Temp-and-rename so an interrupted write cannot leave a truncated
		// settings.json behind. Same directory, so the rename is atomic.
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} finally {
		release?.();
	}
}

function acquireLock(path: string): () => void {
	const lockPath = `${path}.lock`;
	for (let attempt = 1; attempt <= CONFIG.lockRetries; attempt++) {
		try {
			mkdirSync(lockPath);
			return () => {
				try {
					rmdirSync(lockPath);
				} catch {
					// Already gone: another process decided ours was stale. Nothing to undo.
				}
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" || attempt === CONFIG.lockRetries) throw error;
			sleep(CONFIG.lockDelayMs);
		}
	}
	throw new Error(`Could not lock ${path}`);
}

/** Busy-wait, matching how pi waits for the same lock from synchronous callers. */
function sleep(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// Intentionally empty.
	}
}

function permissionsBlock(settings: Record<string, unknown>): Record<string, unknown> {
	const existing = settings.permissions;
	return existing && typeof existing === "object" && !Array.isArray(existing)
		? { ...(existing as Record<string, unknown>) }
		: {};
}

function currentList(permissions: Record<string, unknown>): string[] {
	const value = permissions[SETTINGS_KEY];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Add `dir` to a settings file. No-op if it is already listed. */
export function persist(path: string, dir: string): void {
	editSettings(path, (settings) => {
		const permissions = permissionsBlock(settings);
		const list = currentList(permissions);
		if (list.includes(dir)) return undefined;

		permissions[SETTINGS_KEY] = [...list, dir];
		return { ...settings, permissions };
	});
}

/** Remove `dir` from a settings file. Returns false if it was not listed. */
export function unpersist(path: string, dir: string): boolean {
	let removed = false;
	editSettings(path, (settings) => {
		const permissions = permissionsBlock(settings);
		const list = currentList(permissions);
		const next = list.filter((item) => item !== dir);
		if (next.length === list.length) return undefined;

		removed = true;
		if (next.length === 0) delete permissions[SETTINGS_KEY];
		else permissions[SETTINGS_KEY] = next;

		// Don't leave an empty `permissions: {}` behind if this key was all it held.
		if (Object.keys(permissions).length === 0) {
			const { permissions: _dropped, ...rest } = settings;
			return rest;
		}
		return { ...settings, permissions };
	});
	return removed;
}
