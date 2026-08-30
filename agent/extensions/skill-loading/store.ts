/**
 * Where the per-skill modes live: the `skillOverride` block in
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
 *   "skillOverride": {
 *     "default": "name",
 *     "skills": { "pptx": "command", "chrome-devtools-mcp:*": "command" }
 *   }
 *
 * `enabled`, `maxCharsPerSkill` and `maxChars` are accepted too and default to
 * what config.ts says. An absent block is defaults, which is what makes
 * installing this extension and configuring nothing a no-op.
 *
 * ## Writing
 *
 * The picker saves after every toggle, and the file it is saving into holds the
 * entire configuration — so the three invariants provider/settings.ts spells
 * out are load-bearing here for the same reasons, and are copied rather than
 * improvised:
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
	const configured = block.skills;
	if (configured && typeof configured === "object" && !Array.isArray(configured)) {
		for (const [pattern, mode] of Object.entries(configured as Record<string, unknown>)) {
			// An unrecognised mode is dropped rather than defaulted. Defaulting would
			// silently give `name` to a skill someone wrote "hidden" for and believed
			// they had turned off.
			if (isMode(mode) && pattern.trim().length > 0) modes[pattern.trim()] = mode;
		}
	}

	const positive = (value: unknown, fallback: number) =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

	return {
		enabled: typeof block.enabled === "boolean" ? block.enabled : base.enabled,
		default: isMode(block.default) ? block.default : base.default,
		skills: modes,
		maxCharsPerSkill: positive(block.maxCharsPerSkill, base.maxCharsPerSkill),
		maxChars: positive(block.maxChars, base.maxChars),
	};
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Merge the block back into settings.json.
 *
 * Only non-default fields are written. A block that says
 * `{"skills":{"pptx":"command"}}` is one you can read and understand; one that
 * restates every built-in budget invites editing a number that was never the
 * problem.
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

	const base = defaultSettings();
	const block: Record<string, unknown> = {};
	if (settings.enabled !== base.enabled) block.enabled = settings.enabled;
	if (settings.default !== base.default) block.default = settings.default;
	block.skills = settings.skills;
	if (settings.maxCharsPerSkill !== base.maxCharsPerSkill) block.maxCharsPerSkill = settings.maxCharsPerSkill;
	if (settings.maxChars !== base.maxChars) block.maxChars = settings.maxChars;
	current[SETTINGS_KEY] = block;

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
