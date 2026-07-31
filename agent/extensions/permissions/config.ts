/**
 * Modes and shared constants.
 */

/**
 * What happens to a tool call that no rule mentions.
 *
 * Ordered from most permissive to most restrictive; the order is load-bearing,
 * because an untrusted project may only move the mode *up* this list.
 *
 * `auto` sits directly above `askDestructive` because that is exactly what it
 * is: the same deterministic table, plus a model's second opinion on whatever
 * the table said nothing about. It can only ever *add* prompts.
 *
 * The ladder is not a total order, and `auto` is where that shows. It is not a
 * subset of `askMutating`: `askMutating` prompts for every write and edit, which
 * `auto` waves through when they look ordinary, but `askMutating` says nothing
 * at all about custom tools, which `auto` does judge. So moving a session from
 * `auto` to `askMutating` would trade one kind of prompt for another rather than
 * tightening, and `atLeastAsStrict` in settings.ts refuses it for that reason.
 */
export const MODE_ORDER = ["allowAll", "askDestructive", "auto", "askMutating", "askAll", "denyAll"] as const;

export type Mode = (typeof MODE_ORDER)[number];

/**
 * The only modes that are unambiguously stricter than `auto` — they prompt for,
 * or refuse, every call, so nothing `auto` would have caught slips through.
 * See MODE_ORDER above for why an index comparison is not enough here.
 */
export const STRICTER_THAN_AUTO: ReadonlySet<Mode> = new Set<Mode>(["askAll", "denyAll"]);

export const MODE_HELP: Record<Mode, string> = {
	allowAll: "Never prompt. Rules still apply.",
	askDestructive: "Prompt only for commands that destroy, publish, or escalate. The default.",
	auto: "askDestructive, plus a model's verdict on everything the table cleared. Costs one small call per unrecognised tool call.",
	askMutating: "Prompt for anything that writes: bash, write, edit.",
	askAll: "Prompt for every tool call.",
	denyAll: "Refuse everything not explicitly allowed.",
};

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODE_ORDER as readonly string[]).includes(value);
}

/**
 * The modes Shift+Tab cycles between, and the key it is bound to.
 *
 * `allowAll` and `denyAll` are deliberately NOT in the cycle. They are the two
 * ends of the ladder, and neither should ever be one mistyped keystroke away:
 * tabbing into "never prompt" by accident is precisely the accident this
 * extension exists to prevent, and tabbing into "refuse everything" would look
 * like the agent had broken. Both remain available in settings.json, where
 * choosing them is deliberate.
 *
 * Shift+Tab is pi's `app.thinking.cycle` by default, and reserved bindings beat
 * extension shortcuts, so this only fires once that binding is moved — see the
 * README for the two-line agent/keybindings.json that does it.
 */
export const CYCLE: readonly Mode[] = ["askDestructive", "auto", "askMutating", "askAll"];

export const CYCLE_KEY = "shift+tab";

/**
 * The mode one press of Shift+Tab moves to, or undefined when it refuses.
 *
 * A function rather than an inline `indexOf` at the call site so the shortcut
 * and its test exercise the same code — a test that recomputed the step was
 * asserting a copy, and the copy is exactly what drifts.
 *
 * `denyAll` is a dead end on purpose. Every other mode outside the cycle enters
 * at the front, which is a tightening; from `denyAll` that same step is the
 * largest loosening in the whole ladder, and it was reachable by one mistyped
 * keystroke. The usual justification for letting a keystroke loosen — that a
 * human at the keyboard can approve any individual prompt anyway — is false
 * here: `denyAll` refuses without ever showing a prompt, so there is nothing to
 * approve and nothing to notice. Leaving it stays possible with an explicit
 * `/permissions mode <mode>`.
 *
 * Treating `indexOf`'s -1 as an index would jump to the second entry and read
 * as a skipped step, hence the explicit branch.
 */
export function nextMode(current: Mode): Mode | undefined {
	if (current === "denyAll") return undefined;
	const at = CYCLE.indexOf(current);
	return CYCLE[at === -1 ? 0 : (at + 1) % CYCLE.length]!;
}

export const CONFIG = {
	/** Command text shown in the prompt before truncating. */
	promptCommandChars: 400,
	/** Reasons listed in the prompt before collapsing the rest into a count. */
	maxReasonsShown: 4,
};

/**
 * Tunables for `auto` mode. Each is the point where the behaviour stops being
 * useful, and the comment says which.
 */
export const AUTO = {
	/**
	 * One classifier call's budget. This runs *in front of a tool call the user is
	 * waiting on*, so the ceiling is set by patience, not by the provider: past ten
	 * seconds the wait costs more than the verdict is worth, and `onError` decides
	 * what happens instead.
	 */
	timeoutMs: 10_000,

	/**
	 * Call text shown to the classifier before the middle is elided. Generous,
	 * because the dangerous part of a long command is as often at the end (a pipe
	 * into a shell, a redirect over a config file) as at the start — and elision
	 * is reported to the classifier, which is told to answer unsafe when what was
	 * removed could have changed its mind.
	 */
	subjectChars: 4000,

	/**
	 * Verdicts remembered for the session. An agent retries the same command
	 * constantly, and paying for each identical judgement is pure waste. Oldest
	 * are evicted first; nothing is written to disk.
	 */
	cacheEntries: 500,

	/**
	 * Thinking level for the classifier call. This is a single bounded judgement
	 * on a few hundred characters, and it sits in the latency path of every tool
	 * call, so it buys nothing from deliberation.
	 */
	reasoning: "minimal" as const,

	/**
	 * Where classifier spend is announced, and under what name.
	 *
	 * The channel string is duplicated rather than imported from usage/config.ts:
	 * every extension in this repo installs on its own, so the two sides share a
	 * string, not a module. With `usage` not installed nothing listens and nothing
	 * breaks. Auto mode bills real money on a schedule the user did not choose —
	 * one call per unrecognised tool call — so it must not be invisible to /usage.
	 */
	spendChannel: "usage:spend",
	spendSource: "permissions",
};
