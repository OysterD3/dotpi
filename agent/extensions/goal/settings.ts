/**
 * Reading the `goal` block out of settings.json.
 *
 * Lives under its own top-level `goal` key, beside `permissions`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `goal` field, so — as with the permissions, recap
 * and add-dir extensions — this relies on pi preserving unknown keys when it
 * rewrites the file (its SettingsManager merges modified fields over the parsed
 * current file, so foreign keys survive).
 *
 * `goal.model` and `goal.autoCapture` are the settings with a trust dimension.
 * `model` names an already-registered pi model, so a project cannot register a
 * provider or supply a key through this block — at worst a hostile repo points
 * the evaluator at a model you already have. `autoCapture` turns on an
 * unattended judge call plus a stop-gate that can hold the agent to up to
 * `maxIterations` extra turns per session — behaviour and spend a project
 * should not be able to switch on for a user who never opted in. Even so,
 * project settings are honoured only when the project is trusted, matching the
 * other extensions, so a clone cannot silently redirect where your transcript
 * is sent or change how the session runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";

export type GoalSettings = {
	/**
	 * Model reference for the evaluator call, or undefined to use the active model.
	 *
	 * Judging is worth doing on a small, fast model rather than the session's: it is
	 * a single yes/no read of a transcript, and it runs on every stop attempt. pi has
	 * no small-model concept to inherit, so this names one explicitly; unset, the
	 * evaluator runs on whatever the session is using.
	 */
	model?: string;
	/** Not-met verdicts before the goal gives up, counted over its whole life. 0 disables the cap. */
	maxIterations: number;
	/**
	 * On the first work-opening interactive prompt of a session, with no goal
	 * already active, try to extract a measurable stop condition from the
	 * user's own message and register it the same way `/goal <condition>`
	 * would — see index.ts and capture.ts. Off by default: `/goal` sitting idle
	 * is a session where nobody asked for the stop-gate, and this is the one
	 * setting in this file that changes agent behaviour and spend without an
	 * explicit command, so it stays opt-in rather than assumed.
	 */
	autoCapture: boolean;
};

export type LoadResult = {
	settings: GoalSettings;
	warnings: string[];
};

export const DEFAULTS: GoalSettings = {
	model: undefined,
	maxIterations: CONFIG.maxIterations,
	autoCapture: false,
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
		const block = parsed.goal;
		if (block === undefined) return undefined;
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			// Silence here would look identical to "no settings at all", and the
			// user would go on paying frontier prices for every judge call.
			warnings.push(`${path}: goal must be an object, e.g. { "goal": { "model": "..." } }`);
			return undefined;
		}
		return block as Record<string, unknown>;
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function apply(target: GoalSettings, block: Record<string, unknown>, path: string, warnings: string[]): void {
	if (block.model !== undefined) {
		if (typeof block.model === "string" && block.model.trim().length > 0) target.model = block.model.trim();
		else warnings.push(`${path}: goal.model must be a non-empty string`);
	}
	if (block.maxIterations !== undefined) {
		// Integer-only on purpose. Math.floor would turn 0.5 — someone asking for
		// the tightest cap there is — into 0, which means "no cap at all", and
		// Infinity would pass a bare `>= 0` and disable it just as quietly.
		if (typeof block.maxIterations === "number" && Number.isInteger(block.maxIterations) && block.maxIterations >= 0) {
			target.maxIterations = block.maxIterations;
		} else {
			warnings.push(`${path}: goal.maxIterations must be a whole number >= 0 (0 disables the cap)`);
		}
	}
	if (block.autoCapture !== undefined) {
		if (typeof block.autoCapture === "boolean") target.autoCapture = block.autoCapture;
		else warnings.push(`${path}: goal.autoCapture must be a boolean`);
	}
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const settings: GoalSettings = { ...DEFAULTS };

	const userPath = userSettingsPath(agentDir);
	const user = readBlock(userPath, warnings);
	if (user) apply(settings, user, userPath, warnings);

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const project = readBlock(projectPath, warnings);
		if (project) {
			if (projectTrusted) {
				apply(settings, project, projectPath, warnings);
			} else {
				// Name every key that was dropped. Reporting only `model` left a
				// project's maxIterations silently ignored, so a cap the repo asked
				// for looked like a cap the user chose.
				const ignored = Object.keys(project).filter(
					(key) => key === "model" || key === "maxIterations" || key === "autoCapture",
				);
				if (ignored.length > 0) {
					warnings.push(
						`${projectPath}: ignoring ${ignored.map((k) => `goal.${k}`).join(", ")} — project is not trusted`,
					);
				}
			}
		}
	}

	return { settings, warnings };
}
