/**
 * Loading and layering permission settings.
 *
 *   ~/.pi/agent/permissions.json     yours, applies everywhere
 *   <cwd>/.pi/permissions.json       the project's
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

function readFile(path: string, warnings: string[]): Partial<PermissionSettings> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		// Accept a Claude Code shaped file too, where the block is nested.
		const block = (parsed.permissions ?? parsed) as Partial<PermissionSettings>;
		return block;
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
	return join(agentDir, "permissions.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "permissions.json");
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const sources: string[] = [];
	const settings: PermissionSettings = { ...BUILTIN, allow: [], ask: [], deny: [], allowDestructive: [] };

	const userPath = userSettingsPath(agentDir);
	const user = readFile(userPath, warnings);
	if (user) {
		sources.push(userPath);
		applyFull(settings, user, warnings, userPath);
	}

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const project = readFile(projectPath, warnings);
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
