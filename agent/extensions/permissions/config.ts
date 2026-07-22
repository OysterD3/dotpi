/**
 * Modes and shared constants.
 */

/**
 * What happens to a tool call that no rule mentions.
 *
 * Ordered from most permissive to most restrictive; the order is load-bearing,
 * because an untrusted project may only move the mode *up* this list.
 */
export const MODE_ORDER = ["allowAll", "askDestructive", "askMutating", "askAll", "denyAll"] as const;

export type Mode = (typeof MODE_ORDER)[number];

export const MODE_HELP: Record<Mode, string> = {
	allowAll: "Never prompt. Rules still apply.",
	askDestructive: "Prompt only for commands that destroy, publish, or escalate. The default.",
	askMutating: "Prompt for anything that writes: bash, write, edit.",
	askAll: "Prompt for every tool call.",
	denyAll: "Refuse everything not explicitly allowed.",
};

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODE_ORDER as readonly string[]).includes(value);
}

export const CONFIG = {
	/** Command text shown in the prompt before truncating. */
	promptCommandChars: 400,
	/** Reasons listed in the prompt before collapsing the rest into a count. */
	maxReasonsShown: 4,
};
