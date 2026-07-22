/**
 * Loads `.env` files into `process.env` so secrets live in one file instead of your
 * shell profile.
 *
 * pi has no native dotenv support (no `dotenv` dependency; every `.env` string in its
 * shipped code is just a `process.env` read), so this fills that gap. Other extensions
 * that read `process.env` at call time — such as `web-search.ts` reading `EXA_API_KEY`
 * inside `execute()` — pick these up automatically.
 *
 * Files are read in order, and **earlier wins**:
 *   1. the real environment      (a var already exported in your shell is never overwritten)
 *   2. <cwd>/.pi/.env            (project-local, for per-project keys)
 *   3. ~/.pi/agent/.env          (global)
 *
 * That ordering means `EXA_API_KEY=x pi` beats a project file, which beats the global
 * one — the more specific the scope, the higher the precedence, with the live shell
 * always on top.
 *
 * Format: `KEY=value`, one per line. `export KEY=value` works too. Blank lines and
 * `#` comments are ignored. Values may be single- or double-quoted; double-quoted
 * values interpret `\n`, `\t`, `\r` and `\"`.
 *
 *   # ~/.pi/agent/.env
 *   EXA_API_KEY=abc123
 *   SOME_TOKEN="multi\nline"
 *
 * SECURITY: `.env` is gitignored in this repo and must stay that way — this config
 * directory is a public repo. The loader also warns if the file is readable by other
 * users on the machine; `chmod 600` it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG = {
	/** Warn when a .env file's permissions let group/others read it. */
	warnOnLoosePermissions: true,
	/** Print a one-line summary of what was loaded at startup. Names only, never values. */
	announce: true,
};

/** Parse dotenv-style text into key/value pairs. Malformed lines are skipped, not fatal. */
export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = withoutExport.indexOf("=");
		if (eq <= 0) continue;

		const key = withoutExport.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

		let value = withoutExport.slice(eq + 1).trim();

		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			value = value
				.slice(1, -1)
				.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, "\\");
		} else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
			// Single quotes are literal, matching shell semantics.
			value = value.slice(1, -1);
		} else {
			// Unquoted: an unescaped # starts a trailing comment.
			const hash = value.indexOf(" #");
			if (hash !== -1) value = value.slice(0, hash).trim();
		}

		out[key] = value;
	}

	return out;
}

/** True when the file's mode grants read to group or others. */
function isWorldReadable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o077) !== 0;
	} catch {
		return false;
	}
}

/**
 * Apply a file's vars without clobbering anything already set.
 * Returns the names it actually introduced.
 */
function applyFile(path: string, warnings: string[]): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// Missing file is the normal case, not an error.
		return [];
	}

	if (CONFIG.warnOnLoosePermissions && isWorldReadable(path)) {
		warnings.push(`${path} is readable by other users — run: chmod 600 ${path}`);
	}

	const applied: string[] = [];
	for (const [key, value] of Object.entries(parseEnv(text))) {
		// Earlier sources win, and the real environment always wins.
		if (process.env[key] !== undefined) continue;
		process.env[key] = value;
		applied.push(key);
	}
	return applied;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const warnings: string[] = [];
		const loaded: string[] = [];

		// Most specific first; applyFile skips anything already defined.
		for (const path of [
			join(ctx.cwd, ".pi", ".env"),
			join(homedir(), ".pi", "agent", ".env"),
		]) {
			loaded.push(...applyFile(path, warnings));
		}

		if (ctx.mode !== "tui") return;

		for (const warning of warnings) {
			ctx.ui.notify(`env: ${warning}`, "warning");
		}
		if (CONFIG.announce && loaded.length > 0) {
			// Names only. Never log a value.
			ctx.ui.notify(`env: loaded ${loaded.join(", ")}`, "info");
		}
	});
}
