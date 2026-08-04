/**
 * Reading the `backgroundShell` block out of settings.json.
 *
 * Lives under its own top-level `backgroundShell` key, beside `goal` and `usage`:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `backgroundShell` field, so — as with every
 * other extension that reads its own block — this relies on pi preserving
 * unknown keys when it rewrites the file.
 *
 * `foregroundIdleKillMs` is the one setting here, and it has a trust
 * dimension `shellPath`/`shellCommandPrefix` do not: those two mirror
 * settings pi's own bash tool already reads unconditionally from both files
 * (see index.ts's loadShellConfig), so a project cloning that behaviour
 * cannot do anything pi itself would not already let it do. This key is one
 * this extension invented, and it aims straight at the foreground watchdog's
 * off switch — a cloned repo shipping `{ "backgroundShell": { "foregroundIdleKillMs": 1 } }`
 * would silently kill every foreground command a second in. Honouring
 * project overrides only when the project is trusted means a clone can, at
 * worst, leave the watchdog at its built-in default; it cannot weaponize it
 * against a user who never opted in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BackgroundShellSettings = {
	/**
	 * Foreground-only inactivity-watchdog override, in ms — see
	 * CONFIG.foregroundIdleKillMs for what it does. undefined means "not
	 * configured"; tools.ts falls back to CONFIG's default in that case. 0 is
	 * the documented "off" value and must survive as itself, not as "unset".
	 */
	foregroundIdleKillMs?: number;
};

export type LoadResult = {
	settings: BackgroundShellSettings;
	warnings: string[];
};

export const DEFAULTS: BackgroundShellSettings = {
	foregroundIdleKillMs: undefined,
};

function userSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/** The `backgroundShell` object out of one settings file, or undefined if absent or malformed. */
function readBlock(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const block = parsed.backgroundShell;
		if (block === undefined) return undefined;
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			// Silence here would look identical to "no settings at all", and a
			// typo'd block would leave the watchdog silently at its default with
			// no sign the setting was ever read.
			warnings.push(`${path}: backgroundShell must be an object, e.g. { "backgroundShell": { "foregroundIdleKillMs": 300000 } }`);
			return undefined;
		}
		return block as Record<string, unknown>;
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function apply(target: BackgroundShellSettings, block: Record<string, unknown>, path: string, warnings: string[]): void {
	if (block.foregroundIdleKillMs !== undefined) {
		// >= 0 rather than > 0: 0 is the documented "off" value, not garbage.
		if (typeof block.foregroundIdleKillMs === "number" && Number.isFinite(block.foregroundIdleKillMs) && block.foregroundIdleKillMs >= 0) {
			target.foregroundIdleKillMs = block.foregroundIdleKillMs;
		} else {
			warnings.push(`${path}: backgroundShell.foregroundIdleKillMs must be a number >= 0 (0 disables the watchdog)`);
		}
	}
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const settings: BackgroundShellSettings = { ...DEFAULTS };

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
				// Name every key that was dropped, the same way `goal` and `usage`
				// do — reporting nothing here looks identical to a project that
				// configured no override at all.
				const ignored = Object.keys(project).filter((key) => key === "foregroundIdleKillMs");
				if (ignored.length > 0) {
					warnings.push(`${projectPath}: ignoring ${ignored.map((k) => `backgroundShell.${k}`).join(", ")} — project is not trusted`);
				}
			}
		}
	}

	return { settings, warnings };
}
