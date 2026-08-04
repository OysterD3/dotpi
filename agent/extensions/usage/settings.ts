/**
 * Reading the `usage.budget` block out of settings.json.
 *
 * Lives under its own top-level `usage` key, beside `goal` and `recap`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `usage` field, so — as with every other
 * extension that reads its own block — this relies on pi preserving unknown
 * keys when it rewrites the file.
 *
 * Trust matters here for the same reason it does for `goal.model` and
 * `permissions.additionalDirectories`: this is a safety net the USER opts
 * into (`stepUsd` defaults to 0, off), and a project settings file is
 * something a cloned repo controls. Without gating, a hostile `.pi/settings.json`
 * could raise `stepUsd` to something the session will never reach, or flip
 * `notifyUser`/`remindModel` off — silently disarming the one thing standing
 * between an unattended agent and a repeat of the $93/10h run this exists to
 * prevent. Honouring project overrides only when the project is trusted means
 * a clone can, at worst, leave itself as unprotected as pi is by default; it
 * cannot weaken a budget the user's own global settings turned on.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BudgetSettings = {
	/** Dollar increment between checkpoints. 0 (the default) means off — opt in. */
	stepUsd: number;
	/** Whether to ctx.ui.notify the human when a checkpoint is crossed. */
	notifyUser: boolean;
	/** Whether to send the model a hidden accounting nudge when a checkpoint is crossed. */
	remindModel: boolean;
};

export type UsageSettings = {
	budget: BudgetSettings;
};

export type LoadResult = {
	settings: UsageSettings;
	warnings: string[];
};

export const DEFAULTS: UsageSettings = {
	budget: { stepUsd: 0, notifyUser: true, remindModel: true },
};

function userSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/** The `usage.budget` object out of one settings file, or undefined if absent or malformed. */
function readBlock(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const usage = parsed.usage;
		if (usage === undefined) return undefined;
		if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
			warnings.push(`${path}: usage must be an object, e.g. { "usage": { "budget": { "stepUsd": 5 } } }`);
			return undefined;
		}
		const budget = (usage as Record<string, unknown>).budget;
		if (budget === undefined) return undefined;
		// Silence here would look identical to "no budget settings at all", and the
		// user who thought they had turned checkpoints on would keep burning money
		// with nothing firing and no indication why.
		if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
			warnings.push(`${path}: usage.budget must be an object, e.g. { "stepUsd": 5, "notifyUser": true, "remindModel": true }`);
			return undefined;
		}
		return budget as Record<string, unknown>;
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function apply(target: BudgetSettings, block: Record<string, unknown>, path: string, warnings: string[]): void {
	if (block.stepUsd !== undefined) {
		// 0 is the explicit "off" value and has to be allowed through rather than
		// treated as falsy-and-ignored. Negative would mean "no total can ever
		// stay below this threshold" — reachedThreshold's own guard also rejects
		// it, but rejecting here turns a silently-inert setting into a warning.
		if (typeof block.stepUsd === "number" && Number.isFinite(block.stepUsd) && block.stepUsd >= 0) {
			target.stepUsd = block.stepUsd;
		} else {
			warnings.push(`${path}: usage.budget.stepUsd must be a number >= 0 (0 disables budget checkpoints)`);
		}
	}
	if (block.notifyUser !== undefined) {
		if (typeof block.notifyUser === "boolean") target.notifyUser = block.notifyUser;
		else warnings.push(`${path}: usage.budget.notifyUser must be true or false`);
	}
	if (block.remindModel !== undefined) {
		if (typeof block.remindModel === "boolean") target.remindModel = block.remindModel;
		else warnings.push(`${path}: usage.budget.remindModel must be true or false`);
	}
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const settings: UsageSettings = { budget: { ...DEFAULTS.budget } };

	const userPath = userSettingsPath(agentDir);
	const user = readBlock(userPath, warnings);
	if (user) apply(settings.budget, user, userPath, warnings);

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const project = readBlock(projectPath, warnings);
		if (project) {
			if (projectTrusted) {
				apply(settings.budget, project, projectPath, warnings);
			} else {
				// Name every key that was dropped, the same way `goal` does — reporting
				// nothing here looks identical to a project that set no budget at all.
				const ignored = Object.keys(project).filter((key) => key === "stepUsd" || key === "notifyUser" || key === "remindModel");
				if (ignored.length > 0) {
					warnings.push(`${projectPath}: ignoring ${ignored.map((k) => `usage.budget.${k}`).join(", ")} — project is not trusted`);
				}
			}
		}
	}

	return { settings, warnings };
}
