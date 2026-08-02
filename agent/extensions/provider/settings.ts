/**
 * Reading and rewriting settings.json.
 *
 * `/provider` is the only thing in this repo that WRITES the file rather than
 * reading it, which makes two things load-bearing.
 *
 * **Everything unknown survives.** The file is parsed, three keys are set on the
 * parsed object, and the whole object is written back — the same merge-over-the-
 * current-file approach pi's own SettingsManager uses. A writer that serialised
 * its own idea of the schema would delete the permissions block, the ultracode
 * limits, and every key a future extension adds.
 *
 * **The write is atomic.** pi rewrites this file too, on a theme or model
 * change, so a torn write is not hypothetical: settings.json is the file that,
 * if truncated, loses your whole configuration. Writing to a temporary file in
 * the same directory and renaming over the target makes the swap atomic on
 * POSIX, so a reader sees either the old file or the new one.
 *
 * And the read happens immediately before the write, never from a value cached
 * at startup, so a change pi made in between is carried forward instead of
 * being reverted.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_KEY } from "./config.ts";

export function settingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

export function readSettings(agentDir: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(agentDir), "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Point the `models` block at `active`, and move pi's own session model with it.
 *
 * `defaultProvider`/`defaultModel` are pi's, not ours, and pi resolves them
 * before any extension runs — so they cannot be roles and have to be written out
 * concretely. Writing them is what makes the switch survive a restart; the live
 * session is moved separately with `pi.setModel`, because the file alone would
 * not change the model you are talking to right now.
 */
export function writeActive(agentDir: string, active: string, sessionReference?: string): WriteResult {
	const path = settingsPath(agentDir);

	let current: Record<string, unknown>;
	try {
		current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		// Refuse rather than start fresh. An unreadable settings.json is a file
		// with a typo in it, and overwriting it with a two-key object would throw
		// away everything the user has configured.
		return { ok: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return { ok: false, error: `${path} is not a JSON object` };
	}

	const block = (current[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
	if (typeof block !== "object" || Array.isArray(block)) {
		return { ok: false, error: `${SETTINGS_KEY} in ${path} is not an object` };
	}
	current[SETTINGS_KEY] = { ...block, active };

	if (sessionReference) {
		const slash = sessionReference.indexOf("/");
		if (slash > 0) {
			current.defaultProvider = sessionReference.slice(0, slash);
			current.defaultModel = sessionReference.slice(slash + 1);
		} else {
			// A bare id names a model without saying whose. Leaving defaultProvider
			// alone is the only safe reading: rewriting defaultModel under the old
			// provider would point the session at a model that does not exist there.
			current.defaultModel = sessionReference;
		}
	}

	const temporary = `${path}.provider-${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
		return { ok: true };
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
