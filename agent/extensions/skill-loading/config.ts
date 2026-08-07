/**
 * The modes, and the shape of the preferences that pick between them.
 *
 * These are not read from `agent/settings.json`. That file is tracked, and which
 * skills you find worth advertising is a per-machine, per-month preference
 * nobody should inherit from a clone — see store.ts, which owns the file these
 * live in and explains where it went instead.
 */

/**
 * What a skill costs the conversation, and what it takes to reach it.
 *
 *   name     pi's own behaviour: name, description and file path in the
 *            `<available_skills>` block, so the model can decide to read it.
 *            A few dozen tokens per skill, every turn, forever.
 *   command  nothing in the prompt at all. `/skill:<name>` still works — pi
 *            builds those commands from the full skill list, not from what
 *            reached the prompt — so the skill is not disabled, just no longer
 *            advertised. Zero tokens until you ask for it by name.
 *   preload  the entry AND the whole SKILL.md body, inlined. Costs the most and
 *            saves a round trip: the model does not have to stop and read the
 *            file before it can act. For the one or two skills that apply to
 *            nearly every turn.
 */
export const MODES = ["name", "command", "preload"] as const;

export type Mode = (typeof MODES)[number];

export const MODE_HELP: Record<Mode, string> = {
	name: "Listed for the model to find and read. pi's default.",
	command: "Hidden from the prompt. Still reachable with /skill:<name>.",
	preload: "Listed, and its whole body is in the prompt already.",
};

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export type SkillLoadingSettings = {
	enabled: boolean;
	/** Mode for any skill no pattern matches. */
	default: Mode;
	/** name or glob -> mode. See select.ts for how a skill picks one. */
	skills: Record<string, Mode>;
	/** Ceiling on one preloaded body. */
	maxCharsPerSkill: number;
	/** Ceiling on all preloaded bodies together. */
	maxChars: number;
};

export function defaultSettings(): SkillLoadingSettings {
	return {
		enabled: true,
		// Doing nothing until asked is the only safe default for something that can
		// hide a capability the model would otherwise have used.
		default: "name",
		skills: {},
		maxCharsPerSkill: 12000,
		maxChars: 24000,
	};
}

/**
 * The markers pi's own `formatSkillsForPrompt` emits (core/skills.js).
 *
 * This extension rewrites that block rather than reimplementing skill
 * discovery, which is the whole reason it stays short and cannot drift out of
 * sync about which skills exist: the list it edits is the list pi actually
 * loaded, names, paths and all. The cost is a dependency on the block's shape,
 * so parse.ts fails open — an unrecognised prompt is left exactly as it was.
 */
export const OPEN = "<available_skills>";
export const CLOSE = "</available_skills>";

/**
 * The first words of the three-line preamble pi puts above the block. Matched so
 * the preamble can be removed too when every skill has been hidden — leaving
 * "The following skills provide specialized instructions" above nothing at all
 * reads as a bug and wastes the tokens the hiding was for.
 */
export const PREAMBLE = "The following skills provide specialized instructions";
