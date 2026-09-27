/**
 * Modes and shared constants.
 */

/**
 * What happens to a tool call that no rule mentions.
 *
 * Ordered from most permissive to most restrictive; the order is load-bearing,
 * because an untrusted project may only move the mode *up* this list.
 *
 * `auto` sits directly above `allowAll`: the deterministic destructive table,
 * plus a model's second opinion on whatever the table said nothing about.
 *
 * The ladder is not a total order, and `auto` is where that shows. It is not a
 * subset of `acceptChanges`: `acceptChanges` prompts for every bash command and
 * custom tool, which `auto` waves through when they look ordinary, but it lets
 * every workspace edit through unjudged, which `auto` does judge. So moving a
 * session from `auto` to `acceptChanges` would trade one kind of prompt for
 * another rather than tightening, and `atLeastAsStrict` in settings.ts refuses
 * it for that reason.
 */
export const MODE_ORDER = ["allowAll", "auto", "acceptChanges", "askAll"] as const;

export type Mode = (typeof MODE_ORDER)[number];

/**
 * The only mode that is unambiguously stricter than `auto` — it prompts for
 * every call, so nothing `auto` would have caught slips through. See
 * MODE_ORDER above for why an index comparison is not enough here.
 */
export const STRICTER_THAN_AUTO: ReadonlySet<Mode> = new Set<Mode>(["askAll"]);

export const MODE_HELP: Record<Mode, string> = {
	allowAll: "Never prompt. Rules still apply.",
	auto: "A model decides: on commands the table flags as destructive, and on everything else it does not recognise. Costs one small call per such tool call. The default.",
	acceptChanges: "Reads, and edits inside the workspace, run. Prompt for bash, other tools, and edits outside the workspace or to protected paths (.pi/, .git/, shell rc files, …).",
	askAll: "Prompt for every tool call.",
};

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODE_ORDER as readonly string[]).includes(value);
}

/**
 * The modes Shift+Tab cycles between, and the key it is bound to.
 *
 * `allowAll` is deliberately NOT in the cycle. It is the loose end of the
 * ladder and should never be one mistyped keystroke away: tabbing into "never
 * prompt" by accident is precisely the accident this extension exists to
 * prevent. It remains available in settings.json and through
 * `/permissions mode allowAll`, where choosing it is deliberate.
 *
 * Shift+Tab is pi's `app.thinking.cycle` by default, and reserved bindings beat
 * extension shortcuts, so this only fires once that binding is moved — see the
 * README for the two-line agent/keybindings.json that does it.
 */
export const CYCLE: readonly Mode[] = ["auto", "acceptChanges", "askAll"];

export const CYCLE_KEY = "shift+tab";

/**
 * The mode one press of Shift+Tab moves to.
 *
 * A function rather than an inline `indexOf` at the call site so the shortcut
 * and its test exercise the same code — a test that recomputed the step was
 * asserting a copy, and the copy is exactly what drifts.
 *
 * From `allowAll`, outside the cycle, it enters at the front, which is a
 * tightening. Treating `indexOf`'s -1 as an index would jump to the second
 * entry and read as a skipped step, hence the explicit branch.
 */
export function nextMode(current: Mode): Mode {
	const at = CYCLE.indexOf(current);
	return CYCLE[at === -1 ? 0 : (at + 1) % CYCLE.length]!;
}

/**
 * Paths inside the workspace that `acceptChanges` still prompts for.
 *
 * An edit to one of these is not only an edit: it is a command that runs later
 * with no prompt. `.pi/` holds project settings and hooks — a `hooks.json` there
 * is a shell command pi runs at the next session start, and a `settings.json`
 * can loosen this very policy. `.git/` holds git hooks and config
 * (`core.fsmonitor`, `core.hooksPath`), which run on the next ordinary `git`
 * command; a shell rc file runs in the next shell. Letting such a write through
 * unprompted would turn "edit files" into "run commands", which is the thing
 * the mode prompts for.
 *
 * Claude Code's own protected-path list for acceptEdits, plus `.pi`. `dirs`
 * match a run of path segments anywhere below the workspace directory, so a
 * nested repo's `.git/` counts too; `files` match the last segment. Both
 * compare without case, because macOS and Windows file systems do.
 *
 * `agentFiles` are pi's own config in the agent dir (~/.pi/agent), matched by
 * full path wherever the workspace is. The segment rules cannot see them when
 * the workspace IS ~/.pi — the path below it is `agent/settings.json`, with no
 * `.pi` in it. Each one is policy or a command: the permission rules and
 * packages, hooks, provider endpoints, logins, project trust, MCP servers.
 * The rest of the agent dir — extension code included — is ordinary work there.
 */
export const PROTECTED = {
	dirs: [".pi", ".claude", ".git", ".config/git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn"],
	files: [
		".gitconfig", ".gitmodules",
		".bashrc", ".bash_profile", ".bash_login", ".bash_aliases", ".bash_logout",
		".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".profile", ".envrc",
		".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs", ".pnpmfile.cjs",
		"bunfig.toml", ".bunfig.toml", ".bazelrc", ".bazelversion", ".bazeliskrc",
		".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml",
		"gradle-wrapper.properties", "maven-wrapper.properties",
		".devcontainer.json", ".ripgreprc", "pyrightconfig.json", ".mcp.json", ".claude.json",
	],
	agentFiles: ["settings.json", "hooks.json", "models.json", "auth.json", "trust.json", "mcp.json"],
} as const;

export const CONFIG = {
	/** Command text shown in the prompt before truncating. */
	promptCommandChars: 400,
	/** Reasons listed in the prompt before collapsing the rest into a count. */
	maxReasonsShown: 4,
	/**
	 * Default for `permissions.promptTimeoutMs` — how long the human approval
	 * prompt (the `ctx.ui.select` await in index.ts) waits before giving up and
	 * blocking the call.
	 *
	 * A benchmark run of this harness recorded four silent stalls of 9.5-16.8
	 * minutes and one 6h12m overnight hang on that exact await, with nothing to
	 * end it — one Escape meant to unstick the visible prompt instead killed an
	 * unrelated 3-hour turn. Five minutes is short enough to end an unattended
	 * hang well within one sitting and long enough that stepping away to read a
	 * diff does not get you blocked; 0 restores the old unbounded wait for
	 * anyone who wants it back.
	 */
	promptTimeoutMs: 300_000,
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
	 * Scratchpad scripts shown to the classifier with the command that runs them
	 * (see scratchScripts in scratch.ts): at most this many files per command,
	 * each elided like the command past `scriptChars`. A file over `scriptBytes`
	 * is not read at all — it is left unshown, which the classifier treats as
	 * code it cannot read.
	 */
	scriptFiles: 3,
	scriptChars: 8000,
	scriptBytes: 1_000_000,

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

/**
 * Where the session's working directories are announced, and by whom.
 *
 * `/add-dir` is a session-scoped thing — it survives a `/rewind` correctly by
 * living in the session log rather than in a file — so no amount of re-reading
 * settings.json can tell auto mode's classifier about it. The add-dir extension
 * publishes the full absolute list here on session start and after every add or
 * remove; this extension keeps the last one it saw.
 *
 * The channel string is duplicated on both sides rather than imported, matching
 * `AUTO.spendChannel` and the rest of this repo: every extension installs on its
 * own, so the two sides share a string, not a module. With add-dir not installed
 * nothing publishes, and the persisted `additionalDirectories` list read from
 * settings.json still works on its own.
 *
 * Each message REPLACES the previous list rather than adding to it. That is what
 * makes a removal, and a `/rewind` past an `/add-dir`, take effect without a
 * separate event for it.
 */
export const WORKSPACE = {
	channel: "workspace:dirs",
};

/**
 * Where this session's scratchpad is announced, and by whom.
 *
 * The scratchpad extension creates one temp directory per session, tells the
 * model to put every throwaway file in it, and publishes the absolute path here
 * on session start. This extension keeps the last one it saw and stops asking
 * about path-tool calls that land inside it — see scratch.ts for the bounds on
 * that, which are exactly an `allow` rule's.
 *
 * Duplicated string rather than a shared module, matching WORKSPACE above and
 * the rest of this repo: with the scratchpad extension not installed nothing
 * publishes, `scratchDir` stays undefined, and every path is judged as it was
 * before. Nothing here creates or requires the directory.
 *
 * One path per message, replacing the last. A session start — including a resume
 * into a fresh process — re-announces, which is what makes the exemption survive
 * a restart without anything being persisted.
 */
export const SCRATCHPAD = {
	channel: "scratchpad:dir",
};

/**
 * The hooks extension's side of a tool call, and what this one tells it.
 *
 * A PreToolUse hook can say `allow` or `ask`, and only this extension can act
 * on either: a tool_call handler can block a call but never clear one, so an
 * allow means nothing unless the prompt it skips is this one. hooks loads
 * first (extensions load in directory order), runs its hooks, and publishes its
 * verdict on `decisionChannel` keyed by toolCallId; this handler, running next
 * for the same call, reads it and treats it exactly as a matching `allow` or
 * `ask` rule. Deny rules, hard findings and (with destructiveOverridesAllow)
 * the destructive table still come first — a hook can move a call along the
 * ladder, never past a refusal.
 *
 * `requestChannel` is Claude Code's PermissionRequest: `{ tool, input, reply }`,
 * announced just before a prompt would be shown. The listener fills `reply`
 * synchronously with a promise of `{ behavior: "allow" | "deny", updatedInput?,
 * message?, interrupt? }` or undefined. An allow that rewrites the input is
 * judged again: a deny rule blocks it, an ask rule or a table finding puts it
 * to the user, and the classifier is never asked.
 *
 * `modeChannel` announces the mode in force — on session start and on every
 * change — for the `permission_mode` field hooks send. Its arrival is also how
 * hooks knows this extension is installed.
 *
 * Duplicated strings, not a shared module, like every channel in this repo.
 * With hooks not installed nothing publishes a decision and nothing fills a
 * reply, and every call is decided exactly as before.
 */
export const HOOKS = {
	decisionChannel: "hooks:decision",
	requestChannel: "permissions:request",
	modeChannel: "permissions:mode",
};
