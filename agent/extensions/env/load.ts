/**
 * Reading .env files off disk and applying them to process.env.
 *
 * Precedence is most-specific-wins: a variable already present in the environment is
 * never overwritten, and files are applied in order so the first file to define a key
 * owns it.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { parseEnv } from "./parse.ts";

export type LoadReport = {
	/** Names of variables this load introduced. Never includes values. */
	loaded: string[];
	/** Human-readable problems worth surfacing, e.g. loose file permissions. */
	warnings: string[];
};

/**
 * Files to consult, most specific first.
 *   <cwd>/.pi/.env      project-local
 *   ~/.pi/agent/.env    global
 */
export function envFilePaths(cwd: string): string[] {
	return [join(cwd, ".pi", ".env"), join(homedir(), ".pi", "agent", ".env")];
}

/** True when the file's mode grants read to group or others. */
function isGroupOrWorldReadable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o077) !== 0;
	} catch {
		return false;
	}
}

/**
 * Apply every file in order, skipping keys that are already set.
 * A missing file is the normal case, not an error.
 */
export function loadEnvFiles(paths: string[], env: NodeJS.ProcessEnv = process.env): LoadReport {
	const report: LoadReport = { loaded: [], warnings: [] };

	for (const path of paths) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}

		if (CONFIG.warnOnLoosePermissions && isGroupOrWorldReadable(path)) {
			report.warnings.push(`${path} is readable by other users — run: chmod 600 ${path}`);
		}

		for (const [key, value] of Object.entries(parseEnv(text))) {
			// The real environment, and earlier files, always win.
			if (env[key] !== undefined) continue;
			env[key] = value;
			report.loaded.push(key);
		}
	}

	return report;
}
