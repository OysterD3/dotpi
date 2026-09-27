/**
 * Constants for the hooks extension: the event vocabulary, the defaults the
 * protocol fixes, and the pi.events channels shared with other extensions.
 *
 * Every number here is Claude Code's own default unless its comment says
 * otherwise, because the point of the extension is that a hook script written
 * for that agent behaves the same way here.
 */

/**
 * The events this extension can fire, with the pi signal behind each.
 *
 * Grouped the way the lifecycle runs. Anything not on this list is either an
 * unknown name or one of UNSUPPORTED below, and both are reported at load time
 * rather than silently kept: a hook configured for an event that never fires
 * is a gate that is not there.
 */
export const EVENTS = [
	"SessionStart", //       session_start, and session_compact as source "compact"
	"UserPromptSubmit", //   input (typed or RPC prompts, not extension-sent ones)
	"PreToolUse", //         tool_call
	"PermissionRequest", //  permissions:request, from the permissions extension
	"PostToolUse", //        tool_result, success
	"PostToolUseFailure", // tool_result, isError
	"PostToolBatch", //      turn_end, when the turn ran tools
	"SubagentStart", //      the task tool starting a subagent (observed)
	"SubagentStop", //       the task tool finishing (observed)
	"Notification", //       permission prompt, ask_user question, idle timer
	"Stop", //               agent_before_settle, outcome "completed"
	"StopFailure", //        agent_before_settle, outcome "error"
	"PreCompact", //         session_before_compact
	"PostCompact", //        session_compact
	"PostModelSwitch", //    model_select
	"DirectoryAdded", //     workspace:dirs, from the add-dir extension
	"SessionEnd", //         session_shutdown
] as const;

export type EventName = (typeof EVENTS)[number];

/**
 * Claude Code events with no pi signal to hang them on. Named so a settings file
 * carried across gets told which of its hooks will never run, instead of a
 * quiet "unknown event".
 */
export const UNSUPPORTED: Record<string, string> = {
	Setup: "pi has no --init or --maintenance run",
	UserPromptExpansion: "pi expands skills and templates after the input event, with no hook point",
	PermissionDenied: "the permissions extension's auto mode never denies, it only asks",
	Elicitation: "pi-mcp-adapter has no elicitation support",
	ElicitationResult: "pi-mcp-adapter has no elicitation support",
	TaskCreated: "pi has no task-list tool",
	TaskCompleted: "pi has no task-list tool",
	TeammateIdle: "pi has no agent teams",
	ConfigChange: "not implemented: it needs a file watcher on every settings file",
	PreModelSwitch: "pi fires model_select only after the switch",
	WorktreeCreate: "the workflow worktrees are internal to dynamic-workflow",
	WorktreeRemove: "the workflow worktrees are internal to dynamic-workflow",
	CwdChanged: "pi's working directory is fixed for a session",
	FileChanged: "not implemented: it needs a file watcher",
	InstructionsLoaded: "pi has no event when it reads AGENTS.md",
	MessageDisplay: "pi's display transform is synchronous and cannot wait for a process",
};

/** Handler types this extension runs. `agent` and `mcp_tool` are reported as unsupported. */
export const TYPES = ["command", "http", "prompt"] as const;
export type HandlerType = (typeof TYPES)[number];

/**
 * Which handler types an event accepts — Claude Code's own table, narrowed to
 * the three types above. A handler of another type on that event is dropped at
 * load with a warning, the way that agent skips it.
 */
const ALL: readonly HandlerType[] = ["command", "http", "prompt"];
const NO_PROMPT: readonly HandlerType[] = ["command", "http"];
export const ALLOWED_TYPES: Record<EventName, readonly HandlerType[]> = {
	SessionStart: ["command"],
	UserPromptSubmit: ALL,
	PreToolUse: ALL,
	PermissionRequest: ALL,
	PostToolUse: ALL,
	PostToolUseFailure: ALL,
	PostToolBatch: ALL,
	SubagentStart: NO_PROMPT,
	SubagentStop: ALL,
	Notification: NO_PROMPT,
	Stop: ALL,
	StopFailure: NO_PROMPT,
	PreCompact: NO_PROMPT,
	PostCompact: NO_PROMPT,
	PostModelSwitch: NO_PROMPT,
	DirectoryAdded: NO_PROMPT,
	SessionEnd: NO_PROMPT,
};

/**
 * Events that take a matcher, and the payload field it is tested against.
 * UserPromptSubmit, PostToolBatch and Stop have none: a matcher there is
 * ignored, as it is in Claude Code.
 */
export const MATCH_FIELD: Partial<Record<EventName, string>> = {
	SessionStart: "source",
	PreToolUse: "tool_name",
	PermissionRequest: "tool_name",
	PostToolUse: "tool_name",
	PostToolUseFailure: "tool_name",
	SubagentStart: "agent_type",
	SubagentStop: "agent_type",
	Notification: "notification_type",
	StopFailure: "error",
	PreCompact: "trigger",
	PostCompact: "trigger",
	PostModelSwitch: "to_model",
	DirectoryAdded: "source",
	SessionEnd: "reason",
};

/**
 * Events whose payload carries `permission_mode`, per the Claude Code examples.
 * The value is the permissions extension's own mode name (auto, acceptChanges,
 * …): its modes do not map one-to-one onto that agent's, and a made-up
 * translation would be worse than an honest name.
 */
export const MODE_EVENTS: ReadonlySet<EventName> = new Set([
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Stop",
]);

/**
 * pi's built-in tool names -> the names a hook sees in `tool_name` and matches
 * against. This is the one translation: `tool_input` stays pi's own arguments
 * (`path`, not `file_path`; `edits[]`, not `old_string`), because pi's edit can
 * carry several replacements that have no single-string form. Tools not listed
 * here — every extension and MCP tool — keep their pi name.
 */
export const TOOL_NAMES: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
	powershell: "PowerShell",
};

export function hookToolName(piName: string): string {
	return TOOL_NAMES[piName] ?? piName;
}

/** The subagents extension's tool; its start and end are SubagentStart/SubagentStop. */
export const SUBAGENT_TOOL = "task";

/** Default per-handler timeouts, in seconds. */
export const TIMEOUT = {
	command: 600,
	http: 600,
	prompt: 30,
	/** UserPromptSubmit and PostModelSwitch drop the command/http default to this. */
	short: 30,
} as const;

export const SHORT_TIMEOUT_EVENTS: ReadonlySet<EventName> = new Set(["UserPromptSubmit", "PostModelSwitch"]);

/**
 * SessionEnd runs while pi is quitting, and pi awaits it with no limit of its
 * own, so a hung hook would hang `/quit`. All SessionEnd hooks share this
 * budget; the highest per-hook `timeout` raises it, up to `maxMs`.
 */
export const SESSION_END = { budgetMs: 1_500, maxMs: 60_000 } as const;

/**
 * Stop hooks that keep the agent going this many times in a row are overruled
 * and the turn ends. pi has no guard of its own — agent_before_settle fires
 * again after every continuation — so without this a hook that always blocks
 * is an infinite, billed loop.
 */
export const STOP_CAP = 8;

/** Notification "idle_prompt" fires this long after the agent settles with no input. */
export const IDLE_MS = 60_000;

/**
 * "permission_prompt" and "agent_needs_input" fire only when the prompt or
 * question is still open after this long. A notification is for someone who
 * has walked away, and one per prompt answered in a second is noise.
 */
export const WAITING_MS = 6_000;

/**
 * Text a hook hands the model (additionalContext, plain stdout, a block reason)
 * is capped per hook at this many characters. Claude Code writes the overflow
 * to a file; here the tail is cut and the cut is stated.
 */
export const OUTPUT_CAP = 10_000;

/** A hook's stdout/stderr is buffered up to this many bytes each; the rest is dropped. */
export const CAPTURE_BYTES = 1_000_000;

/** After SIGTERM on timeout, a hook's process group gets this long before SIGKILL. */
export const KILL_GRACE_MS = 1_000;

/** Reasoning for `prompt` hooks: one bounded yes/no judgement, like the permissions classifier. */
export const PROMPT_REASONING = "minimal" as const;

/**
 * pi.events channels. Declared here, not imported: every extension in this
 * repo installs on its own, so the two ends of a channel share a string, not
 * a module.
 */
export const CHANNELS = {
	/** Published by this extension for a PreToolUse allow/ask: `{ toolCallId, decision, reason }`. */
	decision: "hooks:decision",
	/** Published by permissions: `{ mode }`. Its arrival is also how this knows permissions is installed. */
	mode: "permissions:mode",
	/** Published by permissions before a prompt; this extension fills `reply` synchronously. */
	request: "permissions:request",
	ask: "permissions:ask",
	answered: "permissions:answered",
	question: "ask-user:asking",
	workspace: "workspace:dirs",
	spend: "usage:spend",
} as const;

/** The /usage row prompt hooks are billed under. */
export const SPEND_SOURCE = "hooks";

/** customType of the messages this extension adds to the session. */
export const MESSAGE = {
	context: "hooks-context",
	stop: "hooks-stop",
	notice: "hooks-notice",
} as const;
