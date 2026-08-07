/**
 * Where the per-skill modes live: a machine-local file, outside this repo.
 *
 * ## Why not settings.json
 *
 * `agent/settings.json` is tracked, deliberately — that is what makes a new
 * machine reproduce this setup from a clone. Which skills *you* find worth
 * advertising is the opposite kind of fact: it depends on what you work on this
 * month, it changes when you toggle it in the picker, and it is nobody else's
 * default. Putting it there would commit one person's preferences to a repo
 * others clone, and make every toggle a diff in a tracked file that pi is
 * already known to rewrite and conflict on during `git pull`.
 *
 * A `.local.json` inside the repo would be gitignored and would technically
 * work. This goes further out on purpose: `~/.config/pi/` is not in the repo at
 * all, so `git clean`, a re-clone, or moving this config to a new machine cannot
 * quietly discard your choices, and no `git add -A` can publish them.
 *
 * `$XDG_CONFIG_HOME` is honoured when set. The fallback is `~/.config/pi`
 * everywhere, including macOS: `~/Library/Application Support` is the platform
 * convention for applications, but this is a dotfile for a terminal tool, and
 * every other terminal tool the user already has puts it in `~/.config`.
 *
 * ## Shape
 *
 *   { "version": 1,
 *     "default": "name",
 *     "modes": { "pptx": "command", "chrome-devtools-mcp:*": "command" },
 *     "maxCharsPerSkill": 12000, "maxChars": 24000 }
 *
 * `version` is there so a future format change has something to branch on rather
 * than having to guess from the shape.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSettings, isMode, type Mode, type SkillLoadingSettings } from "./config.ts";

export const VERSION = 1;

/** `<XDG_CONFIG_HOME or ~/.config>/pi/skill-loading.json`. */
export function storePath(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
	return join(base, "pi", "skill-loading.json");
}

/**
 * Read the store. A missing, unreadable or malformed file reads as defaults —
 * this is a preferences file, and the only thing worse than losing it is
 * refusing to start because of it.
 */
export function read(path: string = storePath()): SkillLoadingSettings {
	const base = defaultSettings();

	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return base;
	}

	const modes: Record<string, Mode> = {};
	const configured = raw?.modes;
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
		enabled: typeof raw?.enabled === "boolean" ? raw.enabled : base.enabled,
		default: isMode(raw?.default) ? raw.default : base.default,
		skills: modes,
		maxCharsPerSkill: positive(raw?.maxCharsPerSkill, base.maxCharsPerSkill),
		maxChars: positive(raw?.maxChars, base.maxChars),
	};
}

/**
 * Write the store, atomically.
 *
 * Through a temp file in the same directory and a rename, because the picker
 * saves after every single toggle: a crash or a full disk partway through a
 * plain write would leave truncated JSON, which `read` would then treat as "no
 * preferences" and silently un-hide everything.
 *
 * Only non-default fields are written. A store that says `{"version":1,
 * "modes":{}}` is one you can read and understand; one that restates every
 * built-in budget invites editing a number that was never the problem.
 */
export function write(settings: SkillLoadingSettings, path: string = storePath()): void {
	const base = defaultSettings();
	const body: Record<string, unknown> = { version: VERSION };

	if (settings.enabled !== base.enabled) body.enabled = settings.enabled;
	if (settings.default !== base.default) body.default = settings.default;
	body.modes = settings.skills;
	if (settings.maxCharsPerSkill !== base.maxCharsPerSkill) body.maxCharsPerSkill = settings.maxCharsPerSkill;
	if (settings.maxChars !== base.maxChars) body.maxChars = settings.maxChars;

	const text = `${JSON.stringify(body, null, 2)}\n`;
	mkdirSync(dirname(path), { recursive: true });

	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}
