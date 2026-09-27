/**
 * Tests for the hooks extension's pure modules: matcher strings (match.ts),
 * reading one hook's answer and merging many (output.ts), and loading the
 * config files (settings.ts). The expectations are Claude Code's documented
 * behaviour, because a hook script written for that agent must mean the same
 * thing here; a quoted rule in a comment is from its hooks reference.
 *
 * Nothing here needs pi or a session. loadHooks reads temp files, never the
 * real ~/.pi. Run from /Users/oysterlee/.pi:
 *     node_modules/.bin/jiti agent/extensions/hooks/hooks.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventName } from "./config.ts";
import { compileMatcher, matches } from "./match.ts";
import {
	fromCommand,
	fromHttp,
	type HookResult,
	type Merged,
	merge,
	parseStdout,
	readVerdict,
	renderPrompt,
	stopFailureType,
} from "./output.ts";
import { type Handler, type HookConfig, loadHooks, select } from "./settings.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ----------------------------------------------------------------- matchers

console.log("--- matchers: all, exact names, or an unanchored regex ---");
// [matcher, narrow (StopFailure), kind, values it matches, values it must not match]
const MATCHERS: [string | undefined, boolean, string, string[], string[]][] = [
	[undefined, false, "all", ["Bash", "mcp__x__y"], []],
	["", false, "all", ["Bash"], []],
	["*", false, "all", ["Bash"], []],
	// "Matchers are case-sensitive."
	["Bash", false, "exact", ["Bash"], ["bash", "BashOutput"]],
	// "`Edit|Write` and `Edit, Write` both match exactly `Edit` or `Write`."
	["Edit|Write", false, "exact", ["Edit", "Write"], ["NotebookEdit", "edit", "Edit|Write"]],
	["Edit, Write", false, "exact", ["Edit", "Write"], ["NotebookEdit", "Edit, Write"]],
	// "`Edit.*` matches `Edit` and also `NotebookEdit`": any other character makes an unanchored regex.
	["Edit.*", false, "regex", ["Edit", "NotebookEdit"], ["Write"]],
	["^Edit$", false, "regex", ["Edit"], ["NotebookEdit"]],
	// "`mcp__memory` contains only exact-match characters, so it is compared as an exact string."
	["mcp__memory", false, "exact", ["mcp__memory"], ["mcp__memory__create_entities"]],
	["mcp__memory__.*", false, "regex", ["mcp__memory__create_entities"], ["mcp__github__create_issue", "mcp__memory"]],
	// "Hyphens are in this set since v2.1.195."
	["my-tool", false, "exact", ["my-tool"], ["my-tool-2", "my"]],
	// StopFailure: "letters, digits, `_` and `|` only. A hyphen, space or comma sends the matcher down the regex path."
	["rate_limit|overloaded", true, "exact", ["rate_limit", "overloaded"], ["rate_limit_x", "server_error"]],
	["rate-limit", true, "regex", ["rate-limit", "x-rate-limit"], ["rate_limit"]],
];
for (const [text, narrow, kind, yes, no] of MATCHERS) {
	const compiled = compileMatcher(text, narrow);
	const got =
		"error" in compiled
			? compiled
			: { kind: compiled.kind, yes: yes.filter((value) => matches(compiled, value)), no: no.filter((value) => matches(compiled, value)) };
	check(`matcher ${text === undefined ? "absent" : JSON.stringify(text)}${narrow ? " (narrow)" : ""}`, got, { kind, yes, no: [] });
}
check('invalid regex "(" -> error, not a throw', "error" in compileMatcher("("), true);

// ------------------------------------------------------------------ stdout

console.log("\n--- stdout: JSON only when it starts with { and ends with } ---");
// Only the kind is compared for "invalid"; the wording is not the rule.
const STDOUT: [string, string, unknown][] = [
	["empty", "  \n", { kind: "empty" }],
	["plain text", "all good\n", { kind: "text", text: "all good" }],
	["a JSON object", ' {"continue": true}\n', { kind: "json", value: { continue: true } }],
	// "Text printed before the JSON (for example by a shell profile) makes the whole output plain text."
	["text before the JSON", 'nvm: using node 22\n{"decision":"block"}', { kind: "text", text: 'nvm: using node 22\n{"decision":"block"}' }],
	// "Anything else (including a JSON array or a JSON string): plain text."
	["a JSON array", '[{"decision":"block"}]', { kind: "text", text: '[{"decision":"block"}]' }],
	["{not json}", "{not json}", { kind: "invalid" }],
	// "two or more lines that each parse as JSON, and no line is an output object that sets a field: plain text."
	["JSON lines, no output keys", '{"level":"info"}\n{"level":"debug"}', { kind: "text", text: '{"level":"info"}\n{"level":"debug"}' }],
	// "If one of those lines sets a field, the whole output is a parse failure."
	["JSON lines, one sets decision", '{"level":"info"}\n{"decision":"block","reason":"no"}', { kind: "invalid" }],
];
for (const [name, stdout, want] of STDOUT) {
	const parsed = parseStdout(stdout);
	check(name, parsed.kind === "invalid" ? { kind: parsed.kind } : parsed, want);
}

// ------------------------------------------------------- one command's run

console.log("\n--- a command hook: exit code and stdout together ---");
const view = (result: HookResult) => ({
	blocking: result.blocking,
	stderr: result.stderr || undefined,
	text: result.text,
	output: result.output,
	error: result.error,
});
// [case, exit code, stdout, stderr, want] — all on PreToolUse
const COMMANDS: [string, number | null, string, string, unknown][] = [
	["exit 0, plain text -> text", 0, "branch: main\n", "", { text: "branch: main" }],
	["exit 0, JSON -> output", 0, '{"systemMessage":"hi"}', "", { output: { systemMessage: "hi" } }],
	["exit 2, stderr -> blocking", 2, "", "no rm\n", { blocking: true, stderr: "no rm" }],
	// "Exit 2 with schema-invalid JSON still blocks, with stderr as the reason."
	["exit 2, invalid JSON -> still blocking", 2, "{oops}", "no rm", { blocking: true, stderr: "no rm" }],
	// "A valid JSON object: the exit code is ignored, and the JSON alone decides. The hook is not reported as an error."
	["exit 1, valid JSON -> output, no error", 1, '{"decision":"block","reason":"r"}', "warn", { output: { decision: "block", reason: "r" } }],
	// "Plain or empty stdout: non-blocking error ... plus the first stderr line."
	[
		"exit 1, plain stdout -> non-blocking error",
		1,
		"partial",
		"jq: command not found\nline 2",
		{ error: "failed with non-blocking status code 1: jq: command not found" },
	],
	["killed by a signal -> non-blocking error", null, "", "", { error: "failed with non-blocking status code (killed by a signal)" }],
	// "`hookSpecificOutput`: requires `hookEventName` set to the event name."
	[
		"hookEventName names another event -> error",
		0,
		'{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}',
		"",
		{ error: 'invalid JSON output: hookSpecificOutput.hookEventName must be "PreToolUse", got "PostToolUse"' },
	],
	["continue of the wrong type -> error", 0, '{"continue":"no"}', "", { error: 'invalid JSON output: "continue" must be true or false' }],
];
for (const [name, code, stdout, stderr, want] of COMMANDS) {
	check(name, view(fromCommand("hook.sh", code, stdout, stderr, "PreToolUse")), want);
}

console.log("\n--- an http hook: \"HTTP status codes cannot block\" ---");
const HTTP: [string, number, string, unknown][] = [
	["500 -> error, even with a block body", 500, '{"decision":"block"}', { error: "HTTP 500" }],
	["200, empty body -> nothing", 200, "", {}],
	// "2xx with any other body (for example plain text): non-blocking error. The text is NOT added to context."
	["200, plain text -> error", 200, "ok", { error: "response body is not a JSON object" }],
	["200, JSON -> output", 200, '{"systemMessage":"hi"}', { output: { systemMessage: "hi" } }],
];
for (const [name, status, body, want] of HTTP) check(name, view(fromHttp("https://hook", status, body, "PreToolUse")), want);

// ------------------------------------------------------------------- merge

console.log("\n--- merge: every hook's answer for one event ---");
// Each hook goes through the same reduction index.ts uses: fromCommand for a
// command, readVerdict for a prompt hook's reply.
type Hook = (event: EventName) => HookResult;
const exits =
	(code: number | null, stdout = "", stderr = "", label = "hook.sh"): Hook =>
	(event) =>
		fromCommand(label, code, stdout, stderr, event);
const prints = (value: Record<string, unknown>, code = 0, stderr = ""): Hook => exits(code, JSON.stringify(value), stderr);
/** `hookSpecificOutput` for whichever event the row fires. */
const specific =
	(fields: Record<string, unknown>, code = 0, stderr = ""): Hook =>
	(event) =>
		fromCommand("hook.sh", code, JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } }), stderr, event);
const decides = (permissionDecision: string, permissionDecisionReason?: string) => specific({ permissionDecision, permissionDecisionReason });
const replies =
	(reply: string, continueOnBlock = false): Hook =>
	() => {
		const verdict = readVerdict(reply);
		return "error" in verdict ? { label: "prompt", error: verdict.error } : { label: "prompt", verdict: { ...verdict, continueOnBlock } };
	};

// [case, event, hooks, want] — only the fields named in `want` are compared; undefined means absent.
const MERGES: [string, EventName, Hook[], Partial<Merged>][] = [
	// "the most restrictive wins, deny > defer > ask > allow"
	["PreToolUse: deny beats ask beats allow", "PreToolUse", [decides("allow", "fine"), decides("deny", "rm -rf"), decides("ask", "check")], {
		permission: "deny",
		permissionReason: "rm -rf",
	}],
	["PreToolUse: ask beats allow", "PreToolUse", [decides("allow", "fine"), decides("ask", "check")], { permission: "ask", permissionReason: "check" }],
	// "Exit 2 acts like `deny`: stderr becomes Claude's deny reason."
	["PreToolUse: exit 2 -> deny, stderr as reason", "PreToolUse", [exits(2, "", "rm is blocked\n")], { permission: "deny", permissionReason: "rm is blocked" }],
	// "It blocks even if the JSON says "allow"; exit 2 is the one outcome JSON cannot override."
	["PreToolUse: exit 2 overrides a JSON allow", "PreToolUse", [specific({ permissionDecision: "allow", permissionDecisionReason: "fine" }, 2, "rm is blocked")], {
		permission: "deny",
		permissionReason: "rm is blocked",
	}],
	// "The block message is the JSON's blocking reason if the JSON makes a blocking decision. Otherwise it is stderr."
	[
		"PreToolUse: exit 2 with a JSON deny -> the JSON reason",
		"PreToolUse",
		[specific({ permissionDecision: "deny", permissionDecisionReason: "use trash instead" }, 2, "stderr text")],
		{ permission: "deny", permissionReason: "use trash instead" },
	],
	// "Deprecated: top-level `decision` "approve" / "block" maps to allow / deny."
	["PreToolUse: deprecated approve -> allow", "PreToolUse", [prints({ decision: "approve", reason: "ok" })], { permission: "allow", permissionReason: "ok" }],
	["PreToolUse: deprecated block -> deny", "PreToolUse", [prints({ decision: "block", reason: "no" })], { permission: "deny", permissionReason: "no" }],
	// "In interactive mode, `defer` logs a warning and is ignored."
	["PreToolUse: defer -> ignored, user warned", "PreToolUse", [decides("defer")], {
		toUser: ['PreToolUse hook (hook.sh): "defer" is not supported in pi — the call goes to the normal permission check'],
		permission: undefined,
	}],
	// "deny > defer > ask > allow": a defer still outranks an allow, so the call
	// goes to the normal permission flow; its context is "Ignored when
	// permissionDecision is defer".
	["PreToolUse: defer beats allow; the deferring hook's context is dropped", "PreToolUse", [specific({ permissionDecision: "defer", additionalContext: "from defer" }), decides("allow", "fine")], {
		permission: undefined,
		context: [],
	}],
	["PreToolUse: deny still beats defer", "PreToolUse", [decides("defer"), decides("deny", "no")], { permission: "deny", permissionReason: "no" }],
	// terminalSequence: OSC 0/1/2/9/99/777 or BEL, "Anything else makes Claude Code ignore the whole field",
	// and it "works even on events that discard other fields".
	["Notification: an allowed terminalSequence is kept", "Notification", [prints({ terminalSequence: "\u001b]777;notify;pi;done\u0007" })], {
		terminal: ["\u001b]777;notify;pi;done\u0007"],
	}],
	["Notification: a cursor-moving sequence is dropped, user warned", "Notification", [prints({ terminalSequence: "\u001b[2J" })], {
		terminal: [],
		toUser: ["Notification hook (hook.sh): terminalSequence ignored — only OSC 0/1/2/9/99/777 and BEL are allowed"],
	}],
	["PreToolUse: updatedInput kept with allow", "PreToolUse", [specific({ permissionDecision: "allow", updatedInput: { command: "ls -la" } })], {
		permission: "allow",
		updatedInput: { command: "ls -la" },
	}],
	["PreToolUse: updatedInput kept with no decision", "PreToolUse", [specific({ updatedInput: { command: "ls -la" } })], {
		permission: undefined,
		updatedInput: { command: "ls -la" },
	}],
	["PreToolUse: updatedInput dropped with deny", "PreToolUse", [specific({ permissionDecision: "deny", permissionDecisionReason: "no", updatedInput: { command: "ls" } })], {
		permission: "deny",
		updatedInput: undefined,
	}],
	// "`additionalContext` from every hook is kept and all values are passed to Claude."
	["PreToolUse: additionalContext from every hook", "PreToolUse", [specific({ additionalContext: "repo is dirty" }), specific({ additionalContext: "on main" })], {
		context: ["repo is dirty", "on main"],
	}],
	["PreToolUse: systemMessage -> user", "PreToolUse", [prints({ systemMessage: "heads up" })], { toUser: ["heads up"] }],
	// "`continue`: false: Claude stops processing entirely after the hook."
	["PreToolUse: continue false -> halt with stopReason", "PreToolUse", [prints({ continue: false, stopReason: "build broken" })], { halt: "build broken" }],
	// Exit 0: "For most events, stdout goes to the debug log only."
	["PreToolUse: plain stdout is not context", "PreToolUse", [exits(0, "just logging")], { context: [] }],
	// Prompt ok:false on PreToolUse: "By default the turn ENDS ... With `continueOnBlock: true` ... the turn continues."
	["PreToolUse: prompt says no -> deny and halt", "PreToolUse", [replies('{"ok": false, "reason": "touches prod"}')], {
		halt: "touches prod",
		permission: "deny",
		permissionReason: "touches prod",
	}],
	["PreToolUse: prompt says no, continueOnBlock -> deny, no halt", "PreToolUse", [replies('{"ok": false, "reason": "touches prod"}', true)], {
		halt: undefined,
		permission: "deny",
		permissionReason: "touches prod",
	}],
	["PreToolUse: a failed hook -> the user sees the error", "PreToolUse", [exits(1, "", "boom", "guard.sh")], {
		toUser: ["PreToolUse hook error (guard.sh): failed with non-blocking status code 1: boom"],
		permission: undefined,
	}],

	// "on UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch, plain-text stdout is added to Claude's context."
	["SessionStart: plain stdout -> context", "SessionStart", [exits(0, "branch: main\n")], { context: ["branch: main"] }],
	["UserPromptSubmit: plain stdout -> context", "UserPromptSubmit", [exits(0, "today is Monday")], { context: ["today is Monday"] }],
	["PostModelSwitch: plain stdout -> context", "PostModelSwitch", [exits(0, "model notes")], { context: ["model notes"] }],
	["SessionStart: systemMessage -> user", "SessionStart", [prints({ systemMessage: "welcome" })], { toUser: ["welcome"] }],
	["SessionStart: continue false does not halt", "SessionStart", [prints({ continue: false, stopReason: "no" })], { halt: undefined }],
	// Notification: "`systemMessage` and `continue` discarded."
	["Notification: systemMessage and continue dropped", "Notification", [prints({ systemMessage: "ping", continue: false })], {
		halt: undefined,
		context: [],
		toUser: [],
	}],
	// DirectoryAdded: "`systemMessage` goes to Claude as context on the next turn (not to the user)."
	["DirectoryAdded: systemMessage -> context, not user", "DirectoryAdded", [prints({ systemMessage: "added /lib" })], { context: ["added /lib"], toUser: [] }],

	// "Exit 2 or `decision:"block"` blocks and erases the prompt."
	["UserPromptSubmit: exit 2 -> block with stderr", "UserPromptSubmit", [exits(2, "", "no secrets in prompts\n")], { block: "no secrets in prompts" }],
	// Stop: "`decision:"block"` plus `reason` (required): Claude continues, with `reason` as the explanation."
	["Stop: decision block -> block with reason", "Stop", [prints({ decision: "block", reason: "tests not run" })], { block: "tests not run" }],
	["Stop: prompt says no -> block", "Stop", [replies('{"ok": false, "reason": "tests not run"}')], { block: "tests not run", halt: undefined }],
	// "If `impossible: true`, the stop is allowed."
	["Stop: prompt says no but impossible -> no block", "Stop", [replies('{"ok": false, "reason": "CI is down", "impossible": true}')], { block: undefined }],
	// PostToolUse: "Block: no (the tool already ran). Exit 2 shows stderr to Claude."
	["PostToolUse: exit 2 -> stderr to the model, never a block", "PostToolUse", [exits(2, "", "lint failed")], {
		block: undefined,
		halt: undefined,
		toModel: ["lint failed"],
	}],
	["PostToolUse: updatedToolOutput replaces the result", "PostToolUse", [specific({ updatedToolOutput: { stdout: "redacted" } })], {
		updatedOutput: { stdout: "redacted" },
	}],
	["PermissionRequest: allow", "PermissionRequest", [specific({ decision: { behavior: "allow" } })], { request: { behavior: "allow", interrupt: false } }],
	["PermissionRequest: deny wins over allow", "PermissionRequest", [specific({ decision: { behavior: "allow" } }), specific({ decision: { behavior: "deny", message: "not today" } })], {
		request: { behavior: "deny", message: "not today", interrupt: false },
	}],
	["PermissionRequest: deny wins in either order", "PermissionRequest", [specific({ decision: { behavior: "deny", message: "not today" } }), specific({ decision: { behavior: "allow" } })], {
		request: { behavior: "deny", message: "not today", interrupt: false },
	}],
	// "Exit 2 is not honored, and its stderr is discarded."
	["PermissionRequest: exit 2 ignored", "PermissionRequest", [exits(2, "", "no")], { request: undefined, toUser: [] }],
	// The subagent is a separate pi process that has already exited, so a block is reported, not obeyed.
	["SubagentStop: block -> user told pi cannot continue it", "SubagentStop", [prints({ decision: "block", reason: "write tests" })], {
		block: undefined,
		toUser: ["SubagentStop hook (hook.sh) asked the subagent to continue, which pi cannot do: write tests"],
	}],
	// "Stop, SubagentStop: ... If `impossible: true`, the stop is allowed." — so nothing asked to continue.
	["SubagentStop: prompt says no but impossible -> nothing to report", "SubagentStop", [replies('{"ok": false, "reason": "CI is down", "impossible": true}')], {
		toUser: [],
	}],
];
for (const [name, event, hooks, want] of MERGES) {
	const merged = merge(
		event,
		hooks.map((hook) => hook(event)),
	);
	check(name, Object.fromEntries(Object.keys(want).map((key) => [key, merged[key as keyof Merged]])), want);
}

// ------------------------------------------------------------ prompt hooks

console.log("\n--- prompt hooks: the model's verdict, and the text it is sent ---");
const VERDICTS: [string, string, unknown][] = [
	["fenced JSON is read", '```json\n{"ok": true}\n```', { ok: true, impossible: false }],
	["prose around the object is read", 'Verdict: {"ok": false, "reason": "no tests"}.', { ok: false, reason: "no tests", impossible: false }],
	["impossible is read", '{"ok": false, "reason": "CI is down", "impossible": true}', { ok: false, reason: "CI is down", impossible: true }],
	// "`reason` is required when `ok` is false."
	["ok false without a reason -> error", '{"ok": false}', "error"],
	["no boolean ok -> error", '{"ok": "yes"}', "error"],
];
for (const [name, reply, want] of VERDICTS) {
	const verdict = readVerdict(reply);
	check(name, "error" in verdict ? "error" : verdict, want);
}

const EVENT = '{"tool_name":"Bash"}';
const HOME = JSON.stringify({ command: "echo \\$HOME" });
// "`$ARGUMENTS` is replaced by the hook input JSON. If `$ARGUMENTS` is absent, the JSON is appended.
//  `\$` escapes a literal `$` (`\$1.00` renders as `$1.00`)."
const PROMPTS: [string, string, string, string][] = [
	["$ARGUMENTS replaced", "Judge this: $ARGUMENTS", EVENT, `Judge this: ${EVENT}`],
	["no $ARGUMENTS -> JSON appended", "Is this safe?", EVENT, `Is this safe?\n\n${EVENT}`],
	["\\$ARGUMENTS stays a literal $ARGUMENTS", "Say \\$ARGUMENTS, then judge: $ARGUMENTS", EVENT, `Say $ARGUMENTS, then judge: ${EVENT}`],
	["\\$1.00 renders $1.00", "Budget \\$1.00. $ARGUMENTS", EVENT, `Budget $1.00. ${EVENT}`],
	// The escape belongs to the template; the event JSON goes in byte for byte.
	["event JSON holding \\$ is inserted unchanged", "Check $ARGUMENTS", HOME, `Check ${HOME}`],
];
for (const [name, template, json, want] of PROMPTS) check(name, renderPrompt(template, json), want);

// -------------------------------------------------------------- StopFailure

console.log("\n--- StopFailure: the error type read off pi's error text ---");
const FAILURE_TYPES: [string, string][] = [
	['429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}', "rate_limit"],
	['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
	['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "authentication_failed"],
	['500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', "server_error"],
	["socket hang up", "unknown"],
];
for (const [detail, want] of FAILURE_TYPES) check(detail.slice(0, 50), stopFailureType(detail), want);

// ------------------------------------------------------------------ loading

console.log("\n--- loading: four files, merged, project files only when trusted ---");
const tmp = mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
try {
	const agentDir = join(tmp, "agent");
	const cwd = join(tmp, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
	const command = (text: string, extra: Record<string, unknown> = {}) => ({ type: "command", command: text, ...extra });
	const projectHooks = join(cwd, ".pi", "hooks.json");
	const projectSettings = join(cwd, ".pi", "settings.json");

	// User settings.json: hooks under a "hooks" key, as in Claude Code.
	write(join(agentDir, "settings.json"), {
		disableAllHooks: true,
		hooks: {
			PreToolUse: [{ matcher: "Bash", hooks: [command("guard.sh")] }],
			Stop: [{ hooks: [command("notify.sh", { if: "Bash(git *)" })] }],
			SessionStart: [{ hooks: [{ type: "prompt", prompt: "Summarise $ARGUMENTS" }] }],
			TeammateIdle: [{ hooks: [command("idle.sh")] }],
			NoSuchEvent: [{ hooks: [command("x.sh")] }],
		},
	});
	// User hooks.json in a Claude Code plugin's shape. guard.sh repeats the settings.json one.
	write(join(agentDir, "hooks.json"), {
		description: "guards",
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash|Write",
					hooks: [command("guard.sh"), { type: "agent", prompt: "check $ARGUMENTS" }, command("audit.sh", { if: "Bash(git *)" })],
				},
			],
		},
	});
	// Project hooks.json as a bare event map, and a settings.json that turns hooks back on.
	write(projectHooks, { description: "format", PostToolUse: [{ matcher: "Edit|Write", hooks: [command("fmt.sh")] }] });
	write(projectSettings, { disableAllHooks: false });

	const commands = (handlers: Handler[]) => handlers.map((handler) => (handler.type === "command" ? handler.command : handler.type));
	const warned = (config: HookConfig, ...parts: string[]) => config.warnings.some((warning) => parts.every((part) => warning.includes(part)));

	const untrusted = loadHooks(agentDir, cwd, false);
	// "Hook entries merge across settings levels rather than replacing each other."
	check("user files merge: a PreToolUse group from each", untrusted.events.PreToolUse?.length, 2);
	// "If you define the same handler in more than one settings file, it runs once."
	check("Bash: guard.sh from both files once; agent skipped; if-handler kept", commands(select(untrusted.events.PreToolUse, "Bash")), ["guard.sh", "audit.sh"]);
	check("SessionStart: its only handler (prompt) skipped, so no group", untrusted.events.SessionStart, undefined);
	check("untrusted: project hooks.json not loaded", untrusted.events.PostToolUse, undefined);
	check("untrusted: project settings cannot switch hooks back on", untrusted.disabled, true);
	const WARNINGS: [string, string[]][] = [
		["a Claude event pi cannot fire", ["TeammateIdle never fires in pi"]],
		["an unknown event", ['unknown hook event "NoSuchEvent"']],
		["an agent hook is skipped", ['"agent" hooks are not supported', "skipped"]],
		["an if field is named", ['"if" is not supported']],
		["a prompt hook on SessionStart is skipped", ['SessionStart does not run "prompt" hooks', "skipped"]],
		["untrusted project hooks.json", [projectHooks, "not trusted"]],
		["untrusted project settings.json", [projectSettings, "not trusted"]],
	];
	for (const [name, parts] of WARNINGS) check(`warning: ${name}`, warned(untrusted, ...parts), true);

	const trusted = loadHooks(agentDir, cwd, true);
	check("trusted: bare project hooks.json loaded", commands(select(trusted.events.PostToolUse, "Edit")), ["fmt.sh"]);
	check("trusted: its description is not read as an event", warned(trusted, "description"), false);
	// "a project-level `false` overrides a user-level `true`."
	check("trusted: project disableAllHooks false overrides the user's true", trusted.disabled, false);
	check("trusted: no trust warning", warned(trusted, "not trusted"), false);
	// "`if` ... Only evaluated on tool events ... On other events, a hook with `if` set never runs."
	check("if on Stop (not a tool event) -> the handler never runs", commands(select(trusted.events.Stop, "")), []);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
