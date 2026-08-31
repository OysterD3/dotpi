/**
 * The states a skill can be in, and the shape of the map that picks between
 * them.
 *
 * The vocabulary is Claude Code's `skillOverrides`, deliberately: same key,
 * same four value names, same "absent means on" rule, so the setting reads the
 * same in both places and nobody has to learn a second word for hiding a skill.
 * store.ts owns the reader and records how it got here.
 *
 * `preload` is the one addition. Claude Code has no equivalent, and it is not a
 * visibility state at all — the other four decide how much of a skill's ENTRY
 * you pay for, and this one puts the whole body in the prompt. It is kept
 * because it is the only mode that buys something rather than saving something.
 */

/** The settings.json block these live in. */
export const SETTINGS_KEY = "skillOverrides";

/**
 * What a skill costs the conversation, and what it takes to reach it.
 *
 *   on                   pi's own behaviour: name, description and file path in
 *                        the `<available_skills>` block, so the model can decide
 *                        to read it. A few dozen tokens per skill, every turn,
 *                        forever. What a skill does unless you say otherwise.
 *   name-only            the same entry with the description taken out — name
 *                        and path only. The description is the sentence or three
 *                        that explains when the skill applies, and it is most of
 *                        what an entry costs; the path is one line and is what
 *                        makes a name usable, so it stays. For a skill whose name
 *                        already says when you want it.
 *   user-invocable-only  nothing in the prompt at all. `/skill:<name>` still
 *                        works — pi builds those commands from the full skill
 *                        list, not from what reached the prompt — so the skill is
 *                        not disabled, just no longer advertised to the model.
 *                        Zero tokens until you ask for it by name.
 *   off                  the same, and dropped from the `/` menu too, so it is
 *                        not advertised to you either. See index.ts on how far
 *                        this reaches in pi, which is not quite as far as it
 *                        does in Claude Code.
 *   preload              the entry AND the whole SKILL.md body, inlined. Costs
 *                        the most and saves a round trip: the model does not have
 *                        to stop and read the file before it can act. For the one
 *                        or two skills that apply to nearly every turn.
 */
export const MODES = ["on", "name-only", "user-invocable-only", "off", "preload"] as const;

export type Mode = (typeof MODES)[number];

/** What a skill absent from the map does. Claude Code's rule, and pi's own default behaviour. */
export const DEFAULT_MODE: Mode = "on";

export const MODE_HELP: Record<Mode, string> = {
	on: "Name, description and path — pi's default, and what a skill costs unless you say otherwise.",
	"name-only": "Name and path only. The description, which is most of the cost, is dropped.",
	"user-invocable-only": "Hidden from the model. Still reachable with /skill:<name>.",
	off: "Hidden from the model and from the / menu.",
	preload: "Listed, and its whole body is in the prompt already.",
};

/** The short label the picker shows, following Claude Code's own menu. */
export const MODE_LABEL: Record<Mode, string> = {
	on: "on",
	"name-only": "name-only",
	"user-invocable-only": "user-only",
	off: "off",
	preload: "preload",
};

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Ceilings on preloading, in characters.
 *
 * Not settings. They were, back when the modes lived in a file of their own and
 * there was room for keys that are not skill names; `skillOverrides` is a flat
 * map of skill name to state, and a `maxChars` key sitting in it would be
 * indistinguishable from a skill called `maxChars`. Nothing was lost worth
 * keeping — these bound a mode most configurations never use, and a preload
 * budget is plumbing rather than a preference, the same call test-streak and
 * dynamic-workflow make about their own constants.
 */
export const CONFIG = {
	/** Ceiling on one preloaded body. */
	maxCharsPerSkill: 12000,
	/** Ceiling on all preloaded bodies together. */
	maxChars: 24000,
} as const;

export type SkillLoadingSettings = {
	/** name or glob -> mode. See select.ts for how a skill picks one. */
	skills: Record<string, Mode>;
};

export function defaultSettings(): SkillLoadingSettings {
	return { skills: {} };
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
