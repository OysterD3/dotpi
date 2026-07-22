/**
 * Loading and layering permission settings.
 *
 * Rules live under a `permissions` key in pi's own settings files, the way
 * Claude Code puts them in its `settings.json`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `permissions` field, so this had to be checked
 * rather than assumed: pi rewrites settings.json by merging its modified fields
 * over the parsed current file (`{ ...currentFileSettings }`), so unknown keys
 * survive. Verified against the real SettingsManager — a `/theme` change leaves
 * the permissions block intact. If a future pi version starts pruning unknown
 * keys, that guarantee breaks; `/permissions` reports the file it loaded so the
 * loss would at least be visible.
 *
 * Layering is not a plain merge, because a project file is content you may not
 * have written. Denies and asks from a project always apply — a repo is welcome
 * to ask for *more* caution. Its `allow` rules and any loosening of the mode are
 * ignored unless the project is trusted, so cloning a hostile repo cannot
 * silently grant itself permission to run anything. pi already gates config
 * loading behind project trust for the same reason.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODE_ORDER, type Mode, isMode } from "./config.ts";

export type PermissionSettings = {
	defaultMode: Mode;
	allow: string[];
	ask: string[];
	deny: string[];
	/** Destructive pattern ids to stop asking about. */
	allowDestructive: string[];
	/** Whether a destructive command asks even when an allow rule matches it. */
	destructiveOverridesAllow: boolean;
	/** What an "ask" becomes when there is no UI to ask with. */
	askWithoutUi: "deny" | "allow";
};

export type LoadResult = {
	settings: PermissionSettings;
	/** Files that contributed, for `/permissions` to report. */
	sources: string[];
	/** Problems worth showing the user rather than swallowing. */
	warnings: string[];
};

export const BUILTIN: PermissionSettings = {
	defaultMode: "askDestructive",
	allow: [],
	ask: [],
	deny: [],
	allowDestructive: [],
	destructiveOverridesAllow: true,
	askWithoutUi: "deny",
};

/**
 * Read the `permissions` block out of a settings file.
 *
 * `standalone` files (the older permissions.json) may also hold the block at the
 * top level, since that is how they were written.
 */
function readFile(
	path: string,
	warnings: string[],
	standalone = false,
): Partial<PermissionSettings> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const nested = parsed.permissions;
		if (nested && typeof nested === "object") return nested as Partial<PermissionSettings>;
		if (standalone) return parsed as Partial<PermissionSettings>;
		return undefined; // settings.json with no permissions block
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Is `candidate` at least as restrictive as `current`? */
function atLeastAsStrict(candidate: Mode, current: Mode): boolean {
	return MODE_ORDER.indexOf(candidate) >= MODE_ORDER.indexOf(current);
}

export function userSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/** Pre-merge location, still honoured so an old policy cannot silently lapse. */
export function legacyUserPath(agentDir: string): string {
	return join(agentDir, "permissions.json");
}

export function legacyProjectPath(cwd: string): string {
	return join(cwd, ".pi", "permissions.json");
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const sources: string[] = [];
	const settings: PermissionSettings = { ...BUILTIN, allow: [], ask: [], deny: [], allowDestructive: [] };

	// Legacy standalone file first, so settings.json wins on conflict. Silently
	// ignoring it would turn a policy someone still relies on into no policy.
	const legacyUser = legacyUserPath(agentDir);
	const legacy = readFile(legacyUser, warnings, true);
	if (legacy) {
		sources.push(legacyUser);
		warnings.push(`${legacyUser} is deprecated — move its contents under a "permissions" key in ${userSettingsPath(agentDir)}`);
		applyFull(settings, legacy, warnings, legacyUser);
	}

	const userPath = userSettingsPath(agentDir);
	const user = readFile(userPath, warnings);
	if (user) {
		sources.push(userPath);
		applyFull(settings, user, warnings, userPath);
	}

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const legacyProject = readFile(legacyProjectPath(cwd), warnings, true);
		const project = readFile(projectPath, warnings) ?? legacyProject;
		if (project) {
			sources.push(projectTrusted ? projectPath : `${projectPath} (untrusted: deny/ask only)`);
			if (projectTrusted) {
				applyFull(settings, project, warnings, projectPath);
			} else {
				// Restrictions only.
				settings.deny.push(...stringArray(project.deny));
				settings.ask.push(...stringArray(project.ask));
				if (isMode(project.defaultMode) && atLeastAsStrict(project.defaultMode, settings.defaultMode)) {
					settings.defaultMode = project.defaultMode;
				} else if (project.defaultMode !== undefined) {
					warnings.push(
						`${projectPath}: ignoring defaultMode "${String(project.defaultMode)}" — an untrusted project cannot loosen permissions`,
					);
				}
				if (project.allow !== undefined || project.allowDestructive !== undefined) {
					warnings.push(`${projectPath}: ignoring allow rules — project is not trusted`);
				}
			}
		}
	}

	return { settings, sources, warnings };
}

function applyFull(
	target: PermissionSettings,
	source: Partial<PermissionSettings>,
	warnings: string[],
	path: string,
): void {
	if (source.defaultMode !== undefined) {
		if (isMode(source.defaultMode)) target.defaultMode = source.defaultMode;
		else warnings.push(`${path}: unknown defaultMode "${String(source.defaultMode)}"`);
	}

	target.allow.push(...stringArray(source.allow));
	target.ask.push(...stringArray(source.ask));
	target.deny.push(...stringArray(source.deny));
	target.allowDestructive.push(...stringArray(source.allowDestructive));

	if (typeof source.destructiveOverridesAllow === "boolean") {
		target.destructiveOverridesAllow = source.destructiveOverridesAllow;
	}
	if (source.askWithoutUi === "deny" || source.askWithoutUi === "allow") {
		target.askWithoutUi = source.askWithoutUi;
	}
}
