/**
 * Reading the `scratchpad` block out of settings.json.
 *
 * Lives under its own top-level key, beside `permissions` and `goal`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `scratchpad` field, so — as with the other
 * extensions here — this relies on pi preserving unknown keys when it rewrites
 * the file.
 *
 * `dir` is the one setting with a trust dimension, and it is a real one: it
 * decides where the agent is told to write. A project that could point it at
 * `.git/hooks` or at a directory it also reads would have turned a convenience
 * into a foothold. So an untrusted project's block is ignored wholesale, the
 * way permissions treats its `allow` rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, SETTINGS_KEY } from "./config.ts";

export type ScratchpadSettings = {
	enabled: boolean;
	/** Root override. Unset means the per-user directory under the system temp dir. */
	dir?: string;
	retainDays: number;
};

export const DEFAULTS: ScratchpadSettings = {
	enabled: true,
	dir: undefined,
	retainDays: CONFIG.pruneAfterDays,
};

export type LoadResult = { settings: ScratchpadSettings; warnings: string[] };

function readBlock(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const block = parsed[SETTINGS_KEY];
		if (block === undefined) return undefined;
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			warnings.push(`${path}: ${SETTINGS_KEY} must be an object, e.g. { "${SETTINGS_KEY}": { "enabled": false } }`);
			return undefined;
		}
		return block as Record<string, unknown>;
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function apply(target: ScratchpadSettings, block: Record<string, unknown>, path: string, warnings: string[]): void {
	if (block.enabled !== undefined) {
		if (typeof block.enabled === "boolean") target.enabled = block.enabled;
		else warnings.push(`${path}: ${SETTINGS_KEY}.enabled must be true or false`);
	}
	if (block.dir !== undefined) {
		if (typeof block.dir === "string" && block.dir.trim().length > 0) target.dir = block.dir.trim();
		else warnings.push(`${path}: ${SETTINGS_KEY}.dir must be a non-empty string`);
	}
	if (block.retainDays !== undefined) {
		// Integer-only, and zero is allowed: "clean up as soon as a session ends"
		// is a real preference. Math.floor would turn 0.5 into that silently.
		if (typeof block.retainDays === "number" && Number.isInteger(block.retainDays) && block.retainDays >= 0) {
			target.retainDays = block.retainDays;
		} else {
			warnings.push(`${path}: ${SETTINGS_KEY}.retainDays must be a whole number >= 0`);
		}
	}
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const settings: ScratchpadSettings = { ...DEFAULTS };

	const userPath = join(agentDir, "settings.json");
	const user = readBlock(userPath, warnings);
	if (user) apply(settings, user, userPath, warnings);

	const projectPath = join(cwd, ".pi", "settings.json");
	if (projectPath !== userPath) {
		const project = readBlock(projectPath, warnings);
		if (project) {
			if (projectTrusted) {
				apply(settings, project, projectPath, warnings);
			} else {
				// Named rather than silently dropped, so a repo asking for something
				// is visible even when the answer is no.
				const keys = Object.keys(project).filter((key) => key === "enabled" || key === "dir" || key === "retainDays");
				if (keys.length > 0) {
					warnings.push(
						`${projectPath}: ignoring ${keys.map((k) => `${SETTINGS_KEY}.${k}`).join(", ")} — project is not trusted`,
					);
				}
			}
		}
	}

	return { settings, warnings };
}
