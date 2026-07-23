/**
 * Reading the `recap` block out of settings.json.
 *
 * Lives under its own top-level `recap` key, beside `permissions`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `recap` field, so — as with the permissions and
 * add-dir extensions — this relies on pi preserving unknown keys when it rewrites
 * the file (verified against the real SettingsManager: it merges modified fields
 * over the parsed current file, so foreign keys survive).
 *
 * Only two things here could matter for trust. The model reference names an
 * already-registered pi model; a project cannot register a provider or supply a
 * key through this block, so a hostile repo can at worst point your recap at a
 * model you already have. Still, project settings are honoured only when the
 * project is trusted, matching the other extensions, so a clone cannot silently
 * redirect where your transcript is sent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";

export type RecapSettings = {
	/** Model reference for the recap call, or undefined to use the active model. */
	model?: string;
	/** Whether to auto-recap when you return after an idle gap. */
	autoOnReturn: boolean;
	/** Idle gap (ms) that counts as "away". */
	idleThresholdMs: number;
	/** Minimum user turns before an auto-recap is worthwhile. */
	minUserTurns: number;
};

export type LoadResult = {
	settings: RecapSettings;
	sources: string[];
	warnings: string[];
};

export const DEFAULTS: RecapSettings = {
	model: undefined,
	autoOnReturn: CONFIG.autoOnReturnDefault,
	idleThresholdMs: CONFIG.idleThresholdMs,
	minUserTurns: CONFIG.minUserTurns,
};

function userSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

function readBlock(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const block = parsed.recap;
		return block && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>) : undefined;
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function apply(target: RecapSettings, block: Record<string, unknown>, path: string, warnings: string[]): void {
	if (block.model !== undefined) {
		if (typeof block.model === "string" && block.model.trim().length > 0) target.model = block.model.trim();
		else warnings.push(`${path}: recap.model must be a non-empty string`);
	}
	if (block.autoOnReturn !== undefined) {
		if (typeof block.autoOnReturn === "boolean") target.autoOnReturn = block.autoOnReturn;
		else warnings.push(`${path}: recap.autoOnReturn must be true or false`);
	}
	if (block.idleThresholdMs !== undefined) {
		if (typeof block.idleThresholdMs === "number" && block.idleThresholdMs > 0) {
			// Floor it so a tiny value cannot turn every message into a recap.
			target.idleThresholdMs = Math.max(30_000, block.idleThresholdMs);
		} else {
			warnings.push(`${path}: recap.idleThresholdMs must be a positive number of milliseconds`);
		}
	}
	if (block.minUserTurns !== undefined) {
		if (typeof block.minUserTurns === "number" && block.minUserTurns >= 1) {
			target.minUserTurns = Math.floor(block.minUserTurns);
		} else {
			warnings.push(`${path}: recap.minUserTurns must be a number >= 1`);
		}
	}
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const sources: string[] = [];
	const settings: RecapSettings = { ...DEFAULTS };

	const userPath = userSettingsPath(agentDir);
	const user = readBlock(userPath, warnings);
	if (user) {
		sources.push(userPath);
		apply(settings, user, userPath, warnings);
	}

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const project = readBlock(projectPath, warnings);
		if (project) {
			if (projectTrusted) {
				sources.push(projectPath);
				apply(settings, project, projectPath, warnings);
			} else if (project.model !== undefined) {
				warnings.push(`${projectPath}: ignoring recap.model — project is not trusted`);
			}
		}
	}

	return { settings, sources, warnings };
}
