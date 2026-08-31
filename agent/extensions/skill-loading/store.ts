/**
 * Where the per-skill modes live: the `skillOverrides` block in
 * `agent/settings.json`, beside every other extension's block.
 *
 * ## This used to be a machine-local file, and the reasoning is worth keeping
 *
 * The modes lived in `~/.config/pi/skill-loading.json`, outside this repo
 * entirely, on the argument that which skills *you* find worth advertising is a
 * per-machine preference nobody should inherit from a clone — and that putting
 * it in a tracked file would turn every toggle in the picker into a diff in a
 * file `git pull` already conflicts on.
 *
 * That argument is real and it lost anyway. It optimised for the wrong half:
 * everything else about this setup is in `settings.json` precisely so a new
 * machine reproduces it from a clone, and skill loading is configuration in
 * exactly the same sense the permissions policy and the context-diet budgets
 * are. A preference kept somewhere `git clean` cannot reach is also a
 * preference a re-clone silently forgets, and one you cannot read by opening
 * the one file that is supposed to describe this agent. One file that says
 * everything beats two files where the second is invisible.
 *
 * So the consequence is accepted rather than avoided: a toggle is a diff, and a
 * clone inherits these modes. The old path is no longer read — a
 * `~/.config/pi/skill-loading.json` left over from before this change does
 * nothing and can be deleted.
 *
 * ## Shape
 *
 *   "skillOverrides": {
 *     "legacy-context": "name-only",
 *     "chrome-devtools-mcp:*": "user-invocable-only",
 *     "deploy": "off"
 *   }
 *
 * Claude Code's `skillOverrides`, key for key: a FLAT map of skill name to
 * state, with a skill absent from it treated as `on`. That flatness is the whole
 * schema — there is nowhere to put a `default` or a budget, because any key that
 * is not a skill name would be ambiguous with one that is, so those went (see
 * select.ts on `"*"`, and config.ts on the budgets).
 *
 * Two things pi adds inside the same shape: glob keys, so a plugin family that
 * arrives with six skills and grows to eight is one line rather than eight, and
 * the `preload` state. Both are values in the map, so neither breaks the schema.
 *
 * An absent block is defaults, which is what makes installing this extension and
 * configuring nothing a no-op.
 *
 * ## Writing
 *
 * The file being written holds the entire configuration — so the three
 * invariants provider/settings.ts spells out are load-bearing here for the same
 * reasons, and are copied rather than improvised:
 *
 *   - **Everything unknown survives.** Parse the file, set one key, write the
 *     whole object back. A writer that serialised its own idea of the schema
 *     would delete the permissions block and every key a future extension adds.
 *   - **The write is atomic.** Temp file in the same directory, then rename. pi
 *     rewrites this file too (a theme or model change), so a torn write is not
 *     hypothetical, and settings.json is the file that loses everything if it
 *     is truncated.
 *   - **Read immediately before the write.** Never from a copy cached at
 *     startup, so a change pi or another window made in between is carried
 *     forward instead of reverted.
 *
 * And one that is specific to living here: an unreadable settings.json REFUSES
 * the write. The old store treated a missing or malformed file as "no
 * preferences" and wrote a fresh one over it, which was right for a file that
 * held nothing else and is destructive for this one.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings, isMode, SETTINGS_KEY, type Mode, type SkillLoadingSettings } from "./config.ts";

export function settingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

/**
 * Read the block. A missing, unreadable or malformed file reads as defaults —
 * these are preferences, and the only thing worse than losing them is refusing
 * to start because of them.
 */
export function read(agentDir: string): SkillLoadingSettings {
	const base = defaultSettings();

	let block: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(agentDir), "utf8")) as Record<string, unknown>;
		const raw = parsed?.[SETTINGS_KEY];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
		block = raw as Record<string, unknown>;
	} catch {
		return base;
	}

	const modes: Record<string, Mode> = {};
	for (const [pattern, mode] of Object.entries(block)) {
		// An unrecognised value is dropped rather than defaulted. Defaulting would
		// silently give `on` to a skill someone wrote "hidden" for and believed
		// they had turned off — and dropping is also what makes a state this
		// version has never heard of read as "leave it alone" rather than "show
		// it", which is the safer of the two when the map is shared with a newer
		// Claude Code.
		if (isMode(mode) && pattern.trim().length > 0) modes[pattern.trim()] = mode;
	}
	return { ...base, skills: modes };
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Merge the block back into settings.json.
 *
 * An empty map removes the key outright rather than writing `{}`. Absent and
 * empty mean the same thing to the reader, and the documented state for "no
 * overrides" is absent — leaving `"skillOverrides": {}` behind after a reset
 * would be a line in a tracked file that says nothing.
 */
export function write(settings: SkillLoadingSettings, agentDir: string): WriteResult {
	const path = settingsPath(agentDir);

	let current: Record<string, unknown>;
	try {
		current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		// Refuse rather than start fresh. An unreadable settings.json is a file
		// with a typo in it, and overwriting it with a one-key object would throw
		// away everything the user has configured.
		return { ok: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return { ok: false, error: `${path} is not a JSON object` };
	}

	if (Object.keys(settings.skills).length > 0) current[SETTINGS_KEY] = { ...settings.skills };
	else delete current[SETTINGS_KEY];

	const temporary = `${path}.skill-loading-${process.pid}.tmp`;
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
