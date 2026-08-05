/**
 * Reading the `askUser` block out of settings.json.
 *
 * Lives under its own top-level `askUser` key, beside `goal` and
 * `permissions`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * There is exactly one key in this block: `contractModels`, the pattern list
 * style.ts matches the active model against (see its header for why the list
 * exists). It REPLACES CONFIG.contractModels' default when present, rather
 * than merging into it — a project narrowing the net to one model would
 * otherwise always get the built-in "openai"/"openai-codex" pair back, which
 * defeats "narrowing" entirely.
 *
 * `contractModels` is trust-gated exactly like goal's `model` and
 * `autoCapture` (settings.ts there is the template this file follows): a
 * project value is honoured only when the project is trusted, so a clone
 * cannot silently opt your session into (or out of) the contract wording for
 * a model you did not choose. Unlike goal's settings, though, this key does
 * not change whether anything fires or what it costs — an unmatched model
 * still gets a nudge, just OPENING_NUDGE instead of CONTRACT_NUDGE — so
 * there is no risk dimension here beyond "the wrong wording for a turn or
 * two," which is why this is the one settings block ask-user has at all (see
 * config.ts's header).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";

export type AskUserSettings = {
	contractModels: string[];
};

export type LoadResult = {
	settings: AskUserSettings;
	warnings: string[];
};

export const DEFAULTS: AskUserSettings = {
	contractModels: [...CONFIG.contractModels],
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
		const block = parsed.askUser;
		if (block === undefined) return undefined;
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			// Silence here would look identical to "no settings at all", and a
			// typo'd block would go on being ignored without anyone learning why.
			warnings.push(`${path}: askUser must be an object, e.g. { "askUser": { "contractModels": ["openai"] } }`);
			return undefined;
		}
		return block as Record<string, unknown>;
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function apply(target: AskUserSettings, block: Record<string, unknown>, path: string, warnings: string[]): void {
	if (block.contractModels === undefined) return;
	const value = block.contractModels;
	const valid = Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
	if (!valid) {
		warnings.push(`${path}: askUser.contractModels must be a non-empty array of non-empty strings`);
		return;
	}
	// Replace, not merge — see the file header for why.
	target.contractModels = (value as string[]).map((entry) => entry.trim());
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const settings: AskUserSettings = { contractModels: [...DEFAULTS.contractModels] };

	const userPath = userSettingsPath(agentDir);
	const user = readBlock(userPath, warnings);
	if (user) apply(settings, user, userPath, warnings);

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const project = readBlock(projectPath, warnings);
		if (project) {
			if (projectTrusted) {
				apply(settings, project, projectPath, warnings);
			} else if (project.contractModels !== undefined) {
				// Named, not silent — same reasoning goal/settings.ts gives for
				// naming every dropped key rather than staying quiet about it.
				warnings.push(`${projectPath}: ignoring askUser.contractModels — project is not trusted`);
			}
		}
	}

	return { settings, warnings };
}
