/**
 * What a hook said, and what all the hooks on one event said together. Pure.
 *
 * This is the protocol, and it is Claude Code's, read from its hooks reference
 * rather than guessed, because a script written for that agent has to mean the
 * same thing here:
 *
 *   - stdout is read as JSON on EVERY exit code, not only 0;
 *   - exit 2 blocks, whatever the JSON says — the one outcome JSON cannot
 *     override — with the JSON's blocking reason, else stderr, as the reason;
 *   - any other exit code blocks nothing: a valid JSON object still decides on
 *     its own, anything else is a "non-blocking error" shown to the user;
 *   - plain stdout on exit 0 is context for the model on SessionStart,
 *     UserPromptSubmit and PostModelSwitch, and is ignored everywhere else.
 *
 * `fromCommand` and friends reduce one run to a HookResult; `merge` folds every
 * result for an event into one Merged, which index.ts applies to pi. Nothing
 * here touches pi, so the whole table is testable without a session.
 */

import { type EventName, OUTPUT_CAP } from "./config.ts";
import { isObject } from "./settings.ts";

export type HookOutput = {
	continue?: boolean;
	terminalSequence?: string;
	stopReason?: string;
	systemMessage?: string;
	decision?: string;
	reason?: string;
	hookSpecificOutput?: Record<string, unknown>;
};

/** A prompt hook's answer. */
export type Verdict = { ok: boolean; reason?: string; impossible?: boolean };

/** One handler's run, reduced to what the protocol reads. */
export type HookResult = {
	/** Names the handler in messages: its command, URL, or "prompt". */
	label: string;
	/** Exit 2. */
	blocking?: boolean;
	stderr?: string;
	/** A valid JSON object from stdout or the response body. */
	output?: HookOutput;
	/** Plain stdout on exit 0. */
	text?: string;
	/** A non-blocking error: shown to the user, decides nothing. */
	error?: string;
	/** A prompt hook's verdict, with the handler's continueOnBlock. */
	verdict?: Verdict & { continueOnBlock: boolean };
};

export type Merged = {
	/**
	 * The event's own blocking outcome: deny the tool call, erase the prompt,
	 * keep the agent going past Stop, stop the loop after a tool batch, cancel
	 * compaction. Several blocking hooks' reasons are joined.
	 */
	block?: string;
	/** `continue: false` (or a prompt hook's default on some events): stop the agent entirely. */
	halt?: string;
	/** For the model, as additional context. */
	context: string[];
	/** PostToolUse(Failure) feedback: appended to the tool result the model sees. */
	toModel: string[];
	/** For the user: systemMessage, stderr on user-facing events, non-blocking errors. */
	toUser: string[];
	/** PreToolUse, after deny > ask > allow. */
	permission?: "allow" | "ask" | "deny";
	permissionReason?: string;
	/** PreToolUse: replaces the whole tool input. */
	updatedInput?: Record<string, unknown>;
	/** PostToolUse: replaces what the model sees of the result. */
	updatedOutput?: unknown;
	/** PermissionRequest. */
	request?: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string; interrupt?: boolean };
	/** SessionStart / UserPromptSubmit `sessionTitle`. */
	sessionTitle?: string;
	/** `terminalSequence` values that passed the allowlist, for the terminal. */
	terminal: string[];
};

/** Plain stdout on exit 0 becomes context only on these. */
const TEXT_CONTEXT: ReadonlySet<EventName> = new Set(["SessionStart", "UserPromptSubmit", "PostModelSwitch"]);

/** `additionalContext` is delivered on these. */
const CONTEXT: ReadonlySet<EventName> = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Stop",
	"PostModelSwitch",
]);

/** Claude Code discards `systemMessage` on these. DirectoryAdded sends it to the model instead. */
const NO_SYSTEM_MESSAGE: ReadonlySet<EventName> = new Set(["Notification", "PreCompact", "PostCompact", "SessionEnd", "StopFailure"]);

/** `continue: false` means something only where there is an agent to stop. */
const HALTS: ReadonlySet<EventName> = new Set([
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Stop",
]);

/** Exit 2 or `decision: "block"` blocks the event itself. */
const BLOCKS: ReadonlySet<EventName> = new Set(["UserPromptSubmit", "PostToolBatch", "Stop", "PreCompact"]);

/** Exit-2 stderr is shown to the user on these, and ignored on the rest. */
const USER_STDERR: ReadonlySet<EventName> = new Set([
	"SessionStart",
	"SessionEnd",
	"PostCompact",
	"PostModelSwitch",
	"SubagentStart",
]);

/**
 * Claude Code's stdout rule. After trimming: text that starts with `{` and ends
 * with `}` is JSON and must parse; anything else — including a JSON array, or a
 * shell profile's echo in front of the object — is plain text.
 *
 * The multi-line case is its rule too: several lines that each parse are plain
 * text (a log of JSON lines, say), unless one of them looks like an output
 * object, in which case the author meant it as output and the whole thing is a
 * parse failure rather than a silently ignored decision.
 */
export function parseStdout(stdout: string):
	| { kind: "empty" }
	| { kind: "json"; value: Record<string, unknown> }
	| { kind: "text"; text: string }
	| { kind: "invalid"; error: string } {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { kind: "text", text: trimmed };
	try {
		const value: unknown = JSON.parse(trimmed);
		if (isObject(value)) return { kind: "json", value };
	} catch {
		// Fall through to the multi-line reading below.
	}
	const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length >= 2) {
		const parsed: unknown[] = [];
		for (const line of lines) {
			try {
				parsed.push(JSON.parse(line));
			} catch {
				return { kind: "invalid", error: "stdout starts with { and ends with } but is not valid JSON" };
			}
		}
		const looksLikeOutput = parsed.some((value) => isObject(value) && OUTPUT_KEYS.some((key) => key in value));
		if (looksLikeOutput) return { kind: "invalid", error: "stdout holds several JSON lines and one of them is a hook output object" };
		return { kind: "text", text: trimmed };
	}
	return { kind: "invalid", error: "stdout starts with { and ends with } but is not valid JSON" };
}

const OUTPUT_KEYS = ["continue", "stopReason", "suppressOutput", "systemMessage", "decision", "reason", "hookSpecificOutput", "terminalSequence"];

/**
 * What `terminalSequence` may hold: OSC 0, 1, 2 (titles), 9, 99, 777
 * (notifications), or a bare BEL, each ended by BEL or ST. Anything else makes
 * Claude Code drop the whole field, and so does this — a hook must not be able
 * to move the cursor or rewrite the screen under pi's TUI. The payload admits
 * no control character at all: CAN or SUB would end the OSC early and a C1
 * byte can start a new sequence, either of which smuggles one in.
 */
const TERMINAL = /^(?:\x07|\x1b\](?:0|1|2|9|99|777);[^\x00-\x1f\x7f-\x9f]*(?:\x07|\x1b\\))+$/;

/**
 * Check the universal fields. A wrong type anywhere makes the whole object
 * invalid — a non-blocking error — as it does in Claude Code; a key it does not
 * know is ignored. `hookSpecificOutput` must name the event it answers.
 */
export function validateOutput(value: Record<string, unknown>, event: EventName): HookOutput | { error: string } {
	const strings = ["stopReason", "systemMessage", "decision", "reason", "terminalSequence"] as const;
	for (const key of strings) {
		if (value[key] !== undefined && typeof value[key] !== "string") return { error: `"${key}" must be a string` };
	}
	if (value.continue !== undefined && typeof value.continue !== "boolean") return { error: `"continue" must be true or false` };
	if (value.suppressOutput !== undefined && typeof value.suppressOutput !== "boolean") return { error: `"suppressOutput" must be true or false` };
	const specific = value.hookSpecificOutput;
	if (specific !== undefined) {
		if (!isObject(specific)) return { error: `"hookSpecificOutput" must be an object` };
		if (specific.hookEventName !== event) {
			return { error: `hookSpecificOutput.hookEventName must be "${event}", got ${JSON.stringify(specific.hookEventName)}` };
		}
	}
	return value as HookOutput;
}

/** One command run, reduced. `code` is null when the process died on a signal. */
export function fromCommand(label: string, code: number | null, stdout: string, stderr: string, event: EventName): HookResult {
	const parsed = parseStdout(stdout);
	let output: HookOutput | undefined;
	let invalid: string | undefined;
	if (parsed.kind === "invalid") invalid = parsed.error;
	if (parsed.kind === "json") {
		const checked = validateOutput(parsed.value, event);
		if ("error" in checked) invalid = checked.error;
		else output = checked;
	}

	// Exit 2 blocks even when the JSON is broken; stderr is then the reason.
	if (code === 2) return { label, blocking: true, stderr: stderr.trim(), output };
	if (invalid !== undefined) return { label, error: `invalid JSON output: ${invalid}` };
	if (code === 0) return { label, output, text: parsed.kind === "text" ? parsed.text : undefined, stderr: stderr.trim() };
	// Any other exit: a valid JSON object alone decides, and is not an error.
	if (output) return { label, output };
	const line = firstLine(stderr);
	return {
		label,
		error: `failed with non-blocking status code ${code === null ? "(killed by a signal)" : code}${line ? `: ${line}` : ""}`,
	};
}

/**
 * One HTTP run, reduced. A status code cannot block — only a 2xx body carrying
 * decision JSON can — and a 2xx with plain text is an error, not context.
 */
export function fromHttp(label: string, status: number, body: string, event: EventName): HookResult {
	if (status < 200 || status >= 300) return { label, error: `HTTP ${status}` };
	const parsed = parseStdout(body);
	if (parsed.kind === "empty") return { label };
	if (parsed.kind !== "json") return { label, error: "response body is not a JSON object" };
	const checked = validateOutput(parsed.value, event);
	if ("error" in checked) return { label, error: `invalid JSON output: ${checked.error}` };
	return { label, output: checked };
}

/**
 * A prompt hook's reply. Lenient about fences and prose around the object —
 * models add them whatever they are told — strict about the object itself:
 * `ok` must be a boolean, and `ok: false` must say why.
 */
export function readVerdict(text: string): Verdict | { error: string } {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return { error: "the model did not answer with a JSON object" };
	let value: unknown;
	try {
		value = JSON.parse(text.slice(start, end + 1));
	} catch {
		return { error: "the model's JSON did not parse" };
	}
	if (!isObject(value) || typeof value.ok !== "boolean") return { error: `the model's answer has no boolean "ok"` };
	if (!value.ok && (typeof value.reason !== "string" || value.reason.trim().length === 0)) {
		return { error: `the model answered ok: false without a reason` };
	}
	return {
		ok: value.ok,
		reason: typeof value.reason === "string" ? value.reason : undefined,
		impossible: value.impossible === true,
	};
}

/**
 * The text a prompt hook sends: `$ARGUMENTS` replaced by the event JSON, or the
 * JSON appended when the template never mentions it. `\$` is a literal `$`.
 *
 * One pass over the template only. Unescaping afterwards would reach into the
 * inserted JSON too, and a command holding `\\$HOME` would arrive as invalid
 * JSON with a different command in it.
 */
export function renderPrompt(template: string, json: string): string {
	let used = false;
	const text = template.replace(/\\\$|\$ARGUMENTS/g, (token) => {
		if (token === "\\$") return "$";
		used = true;
		return json;
	});
	return used ? text : `${text}\n\n${json}`;
}

const RANK = { allow: 1, ask: 2, deny: 3 } as const;

/** Fold every hook's result for one event into what pi should do. */
export function merge(event: EventName, results: readonly HookResult[]): Merged {
	const merged: Merged = { context: [], toModel: [], toUser: [], terminal: [] };
	const blocks: string[] = [];
	let deferred = false;

	for (const result of results) {
		if (result.error !== undefined) {
			merged.toUser.push(`${event} hook error (${result.label}): ${result.error}`);
			continue;
		}
		const output = result.output;
		const specific = output?.hookSpecificOutput;

		// Honoured on every event, even the ones that discard everything else —
		// it is how a Notification hook rings the desktop without a terminal.
		if (output?.terminalSequence !== undefined) {
			if (TERMINAL.test(output.terminalSequence)) merged.terminal.push(output.terminalSequence);
			else merged.toUser.push(`${event} hook (${result.label}): terminalSequence ignored — only OSC 0/1/2/9/99/777 and BEL are allowed`);
		}
		if (output?.systemMessage) {
			if (event === "DirectoryAdded") merged.context.push(cap(output.systemMessage));
			else if (!NO_SYSTEM_MESSAGE.has(event)) merged.toUser.push(output.systemMessage);
		}
		if (output?.continue === false && HALTS.has(event)) {
			merged.halt ??= output.stopReason || `a ${event} hook stopped the agent`;
		}
		// A deferred call's context is dropped with its decision (Claude Code: "Ignored when permissionDecision is defer").
		const isDefer = event === "PreToolUse" && specific?.permissionDecision === "defer";
		const additional = specific?.additionalContext;
		if (typeof additional === "string" && additional.trim().length > 0 && CONTEXT.has(event) && !isDefer) merged.context.push(cap(additional));
		if (result.text && TEXT_CONTEXT.has(event)) merged.context.push(cap(result.text));
		if ((event === "SessionStart" || event === "UserPromptSubmit") && typeof specific?.sessionTitle === "string") {
			merged.sessionTitle = specific.sessionTitle;
		}

		const stderr = result.stderr ?? "";
		const verdict = result.verdict && !result.verdict.ok ? result.verdict : undefined;

		switch (event) {
			case "PreToolUse": {
				let decision = typeof specific?.permissionDecision === "string" ? specific.permissionDecision : undefined;
				let reason = typeof specific?.permissionDecisionReason === "string" ? specific.permissionDecisionReason : undefined;
				// The deprecated top-level spelling, still read by Claude Code.
				if (decision === undefined && output?.decision === "approve") decision = "allow";
				if (decision === undefined && output?.decision === "block") decision = "deny";
				reason ??= output?.reason;
				if (result.blocking) {
					reason = decision === "deny" && reason ? reason : stderr || "blocked by a PreToolUse hook";
					decision = "deny";
				}
				if (verdict) {
					decision = "deny";
					reason = verdict.reason;
					// A prompt hook's "no" ends the turn unless it asked to hand the
					// reason back to the model instead — Claude Code's default.
					if (!verdict.continueOnBlock) merged.halt ??= verdict.reason;
				}
				if (decision === "defer") {
					// Claude Code honours defer only in -p with a single tool call and
					// ignores it interactively; pi has no deferred-call exit at all. It
					// still outranks allow and ask (deny > defer > ask > allow), so a
					// deferring hook sends the call to the normal permission flow.
					merged.toUser.push(`PreToolUse hook (${result.label}): "defer" is not supported in pi — the call goes to the normal permission check`);
					deferred = true;
					break;
				}
				if (decision === "allow" || decision === "ask" || decision === "deny") {
					if (merged.permission === undefined || RANK[decision] > RANK[merged.permission]) {
						merged.permission = decision;
						merged.permissionReason = reason;
					}
				} else if (decision !== undefined) {
					merged.toUser.push(`PreToolUse hook (${result.label}): unknown permissionDecision "${decision}" ignored`);
					break;
				}
				// Last one wins when several hooks rewrite the input, in file order —
				// deterministic where Claude Code's "last to finish" is not.
				if (decision !== "deny" && isObject(specific?.updatedInput)) merged.updatedInput = specific.updatedInput;
				break;
			}

			case "PermissionRequest": {
				// Exit 2 is not honoured here, and neither is a prompt hook's "no":
				// only an explicit decision object is.
				const decision = specific?.decision;
				if (isObject(decision) && (decision.behavior === "allow" || decision.behavior === "deny")) {
					if (merged.request === undefined || decision.behavior === "deny") {
						merged.request = {
							behavior: decision.behavior,
							updatedInput: isObject(decision.updatedInput) ? decision.updatedInput : undefined,
							message: typeof decision.message === "string" ? decision.message : undefined,
							interrupt: decision.interrupt === true,
						};
					}
				}
				break;
			}

			case "PostToolUse":
			case "PostToolUseFailure": {
				// The tool already ran, so nothing here blocks: "block" and exit 2
				// put their reason next to the result, where the model reads it.
				if (result.blocking && stderr) merged.toModel.push(cap(stderr));
				if (output?.decision === "block") merged.toModel.push(cap(output.reason || `a ${event} hook flagged this result`));
				if (event === "PostToolUse" && specific !== undefined) {
					if ("updatedToolOutput" in specific) merged.updatedOutput = specific.updatedToolOutput;
					else if ("updatedMCPToolOutput" in specific) merged.updatedOutput = specific.updatedMCPToolOutput;
				}
				if (verdict) {
					if (event === "PostToolUseFailure" || verdict.continueOnBlock) merged.toModel.push(cap(verdict.reason ?? ""));
					else merged.halt ??= verdict.reason;
				}
				break;
			}

			case "UserPromptSubmit":
			case "PostToolBatch":
			case "Stop":
			case "PreCompact": {
				const jsonBlock = output?.decision === "block" ? output.reason || `a ${event} hook blocked this` : undefined;
				if (result.blocking) blocks.push(cap(jsonBlock ?? (stderr || `a ${event} hook exited 2`)));
				else if (jsonBlock !== undefined) blocks.push(cap(jsonBlock));
				// On Stop, `impossible` is the model's way of saying the condition can
				// never be met, so stopping is allowed rather than looped on.
				if (verdict && !(event === "Stop" && verdict.impossible)) blocks.push(cap(verdict.reason ?? ""));
				break;
			}

			case "SubagentStop": {
				// The subagent is a separate pi process that has already exited; there
				// is nothing to keep running. Said out loud rather than dropped, so a
				// hook written to do it is seen not to work.
				const wanted = result.blocking
					? stderr
					: output?.decision === "block"
						? output.reason
						: verdict && !verdict.impossible
							? verdict.reason
							: undefined;
				if (wanted !== undefined) {
					merged.toUser.push(`SubagentStop hook (${result.label}) asked the subagent to continue, which pi cannot do: ${wanted}`);
				}
				break;
			}

			default:
				if (result.blocking && USER_STDERR.has(event) && stderr) merged.toUser.push(`${event} hook: ${stderr}`);
		}
	}

	if (blocks.length > 0 && BLOCKS.has(event)) merged.block = blocks.join("\n");
	if (deferred && merged.permission !== "deny") {
		merged.permission = undefined;
		merged.permissionReason = undefined;
		merged.updatedInput = undefined;
	}
	return merged;
}

export function cap(text: string): string {
	if (text.length <= OUTPUT_CAP) return text;
	return `${text.slice(0, OUTPUT_CAP)}\n…[${text.length - OUTPUT_CAP} more characters cut]`;
}

export function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * StopFailure's `error` — Claude Code's error types — read off pi's error text.
 * pi keeps only the provider's message, so this is a best reading of it, first
 * match wins, and anything unrecognised is "unknown" rather than a guess.
 */
const FAILURES: readonly [RegExp, string][] = [
	[/rate.?limit|too many requests|\b429\b/i, "rate_limit"],
	[/overloaded|\b529\b/i, "overloaded"],
	[/billing|credit balance|insufficient.?quota|payment required|\b402\b/i, "billing_error"],
	[/unauthori[sz]ed|authentication|api.?key|\b401\b|\b403\b/i, "authentication_failed"],
	[/model.{0,40}(not found|does not exist|not supported)|unknown model/i, "model_not_found"],
	[/max(imum)?[ _-]?(output[ _-]?)?tokens/i, "max_output_tokens"],
	[/\b5\d\d\b|server error|internal error|bad gateway|service unavailable/i, "server_error"],
	[/\b400\b|invalid request|bad request/i, "invalid_request"],
];

export function stopFailureType(detail: string): string {
	return FAILURES.find(([pattern]) => pattern.test(detail))?.[1] ?? "unknown";
}
