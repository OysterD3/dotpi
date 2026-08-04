/**
 * Tests for stalled-turn: what counts as a stall, settings, and the wiring —
 * in particular the cap, which is the only thing standing between a persistently
 * broken provider and an unbounded loop that spends money producing nothing.
 *
 * Run: jiti agent/extensions/stalled-turn/stalled-turn.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "stalled-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { hasNoContent, isAbortAfterHungTool, isStalled, isStaleCompletion, shouldAlertPendingCall } = await import("./detect.ts");
const { ABORT_RECOVERY_ENTRY_TYPE, DEFAULT_SETTINGS, HUNG_TOOL_MIN_MS, PENDING_STALE_MESSAGE_TYPE, RESUME_PROMPT, RESUME_TYPE, resolveSettings } =
	await import("./config.ts");
const {
	abortRecoveryLines,
	formatClockTime,
	formatDuration,
	pendingCallAlertText,
	pendingCallShutdownWarning,
	staleResultReminder,
	systemReminder,
} = await import("./render.ts");
const { loadSettings, default: register } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

const text = (s: string) => ({ type: "text", text: s });

// ----------------------------------------------------------------- detection

console.log("--- what counts as nothing ---");
check("an empty array", hasNoContent([]), true);
check("whitespace-only text", hasNoContent([text("   \n ")]), true);
// Reasoning with no reply is still no reply, and it is a shape qoder produces.
check("thinking with no reply", hasNoContent([{ type: "thinking", thinking: "hmm" }]), true);
check("real text is content", hasNoContent([text("here you go")]), false);
check("a tool call is content", hasNoContent([{ type: "toolCall", name: "bash" }]), false);
check("thinking followed by text is content", hasNoContent([{ type: "thinking" }, text("done")]), false);
check("an image is content", hasNoContent([{ type: "image", data: "x" }]), false);
check("a bare string", hasNoContent("hello"), false);
check("a blank string", hasNoContent("  "), true);

console.log("\n--- what counts as a stall ---");
// The exact shape every local qoder session ends with.
check("empty + stop is a stall", isStalled({ role: "assistant", content: [], stopReason: "stop" }), true);
check("a normal reply is not", isStalled({ role: "assistant", content: [text("hi")], stopReason: "stop" }), false);
check("a tool-call turn is not", isStalled({ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" }), false);
// Escape is the user's decision; resuming would fight them.
check("an abort is not a stall", isStalled({ role: "assistant", content: [], stopReason: "aborted" }), false);
// An error is already reported as a failure; resuming would loop on a real fault.
check("an error is not a stall", isStalled({ role: "assistant", content: [], stopReason: "error" }), false);
check("a user message is never a stall", isStalled({ role: "user", content: [], stopReason: "stop" }), false);

// The second shape, and the costlier one: the provider claims a tool call and
// sends none, so the loop has nothing to execute and the turn ends with the
// model having just announced what it was about to do. Taken verbatim from a
// real transcript — stopReason "toolUse", blocks ["thinking", "text"], after
// the model said "Let me consult the advisor before building."
check(
	"toolUse with no tool call is a stall",
	isStalled({
		role: "assistant",
		content: [{ type: "thinking", thinking: "..." }, text("Let me consult the advisor before building.")],
		stopReason: "toolUse",
	}),
	true,
);
check("even with no content at all", isStalled({ role: "assistant", content: [], stopReason: "toolUse" }), true);
// A real tool-use turn must be left completely alone — this is the common case
// and resuming it would inject a spurious prompt into healthy work.
check(
	"but a real tool call is not",
	isStalled({ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" }),
	false,
);
check(
	"nor is text alongside a real call",
	isStalled({ role: "assistant", content: [text("running it"), { type: "toolCall", name: "bash" }], stopReason: "toolUse" }),
	false,
);
// Other endings are the provider reporting something true; do not paper over them.
check("a length cap is not a stall", isStalled({ role: "assistant", content: [], stopReason: "length" }), false);
check("no message at all", isStalled(undefined), false);

console.log("\n--- the third shape: an error pi's own retry declines (C2) ---");
// No errorMessage at all: the pre-existing, deliberate baseline above stays
// "not a stall" — there is nothing to classify a dead-vs-retryable call on.
check(
	"an error with no errorMessage is unchanged: still not a stall",
	isStalled({ role: "assistant", content: [], stopReason: "error" }),
	false,
);
// Matches pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN: pi's own auto-retry is
// already handling this, so flagging it too would double up.
check(
	"a retryable-looking error (pi will retry it itself) is not a stall",
	isStalled({ role: "assistant", content: [], stopReason: "error", errorMessage: "502 Bad Gateway from upstream" }),
	false,
);
check(
	"case-insensitively too",
	isStalled({ role: "assistant", content: [], stopReason: "error", errorMessage: "RATE LIMIT exceeded, please retry" }),
	false,
);
// Matches NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN: pi declines on purpose
// (a billing/quota wall, not a transient fault), and the turn dies exactly as
// silently as the empty-completion shapes — this is the case the spec adds.
check(
	"a quota/billing error pi declines on purpose is a stall",
	isStalled({ role: "assistant", content: [], stopReason: "error", errorMessage: "insufficient_quota: account has no credit" }),
	true,
);
// Matches neither list: pi's own isRetryableAssistantError falls through to
// "not retryable" for anything that fails the RETRYABLE test, novel errors
// included, so this extension mirrors that and treats it as dead too.
check(
	"a novel error matching neither pattern list is a stall",
	isStalled({ role: "assistant", content: [], stopReason: "error", errorMessage: "the frobnicator rejected the widget" }),
	true,
);
// Precedence: pi checks the limit pattern FIRST and returns immediately, so an
// errorMessage that happens to contain BOTH a billing phrase and a
// retryable-looking substring is still declined, not retried.
check(
	"a billing wall wins over an incidental retryable-looking substring",
	isStalled({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "quota exceeded (upstream also logged a 500 earlier)",
	}),
	true,
);
// Content present means the provider DID say something before erroring —
// never treated as the empty-completion shape regardless of errorMessage.
check(
	"an error with real content is not a stall, whatever errorMessage says",
	isStalled({
		role: "assistant",
		content: [text("partial output before it broke")],
		stopReason: "error",
		errorMessage: "the frobnicator rejected the widget",
	}),
	false,
);

console.log("\n--- the abort-recovery fingerprint (B) ---");
// The exact shape from the benchmark: Escape used to unstick a hung tool that
// had actually been running long enough to plausibly be hung.
check(
	"aborted + empty + a failed tool result right before it that ran past the hung-tool floor",
	isAbortAfterHungTool({ role: "assistant", content: [], stopReason: "aborted" }, true, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS),
	true,
);
check(
	"exactly at the floor still counts",
	isAbortAfterHungTool({ role: "assistant", content: [], stopReason: "aborted" }, true, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS),
	true,
);
// The false-positive this fix removes: an ORDINARY fast failure (isError,
// under the floor) followed by Escape for an unrelated reason has the exact
// same shape otherwise, and must not be mislabelled "stuck tool, unstuck".
check(
	"aborted + empty + a failed tool result that failed FAST is a quick cancel, not a hung tool",
	isAbortAfterHungTool({ role: "assistant", content: [], stopReason: "aborted" }, true, 900, HUNG_TOOL_MIN_MS),
	false,
);
check(
	"one ms under the floor still does not count",
	isAbortAfterHungTool({ role: "assistant", content: [], stopReason: "aborted" }, true, HUNG_TOOL_MIN_MS - 1, HUNG_TOOL_MIN_MS),
	false,
);
check(
	"aborted + empty but the preceding tool result succeeded — a clean cancel, leave it alone regardless of duration",
	isAbortAfterHungTool({ role: "assistant", content: [], stopReason: "aborted" }, false, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS),
	false,
);
check(
	"an abort with real content is not this fingerprint",
	isAbortAfterHungTool({ role: "assistant", content: [text("partial")], stopReason: "aborted" }, true, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS),
	false,
);
check(
	"any other stopReason is not this fingerprint, even with a long-running failed tool result behind it",
	isAbortAfterHungTool({ role: "assistant", content: [], stopReason: "stop" }, true, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS),
	false,
);
check(
	"a user message is never this fingerprint",
	isAbortAfterHungTool({ role: "user", content: [], stopReason: "aborted" }, true, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS),
	false,
);
check("no message at all", isAbortAfterHungTool(undefined, true, HUNG_TOOL_MIN_MS, HUNG_TOOL_MIN_MS), false);

console.log("\n--- pending-call thresholds ---");
check("under the stale-result line", isStaleCompletion(30 * 60_000, 30 * 60_000), false);
check("exactly at the line does not count as MORE than it", isStaleCompletion(30 * 60_000, 30 * 60_000), false);
check("one ms over the line", isStaleCompletion(30 * 60_000 + 1, 30 * 60_000), true);
check("alert off (0) never fires, no matter how long it has run", shouldAlertPendingCall(10_000_000, 0), false);
check("under the alert threshold", shouldAlertPendingCall(59_000, 60_000), false);
check("exactly at the alert threshold fires", shouldAlertPendingCall(60_000, 60_000), true);
check("past the alert threshold fires", shouldAlertPendingCall(61_000, 60_000), true);

// ---------------------------------------------------------------- wording (A, B)

console.log("\n--- duration formatting ---");
check("under a minute floors to 0m, never negative", formatDuration(-500), "0m");
check("whole minutes, no hour yet", formatDuration(45 * 60_000), "45m");
// The exact number from the benchmark forensics: 14:47 to 20:59.
check("the benchmark's own gap: 6h12m", formatDuration(6 * 3_600_000 + 12 * 60_000), "6h12m");
check("minutes are zero-padded past the hour", formatDuration(3_600_000 + 5 * 60_000), "1h05m");
check("an exact hour has no dangling minutes digit lost", formatDuration(3_600_000), "1h00m");

console.log("\n--- clock-time formatting ---");
// Built from local Y/M/D/H/M so the assertion is timezone-independent: both
// the input and the expected "14:47" come from the same local interpretation.
check("HH:MM, zero-padded", formatClockTime(new Date(2024, 0, 1, 14, 47).getTime()), "14:47");
check("single-digit hour and minute both pad", formatClockTime(new Date(2024, 0, 1, 4, 5).getTime()), "04:05");

console.log("\n--- pending-call sentinel wording (A) ---");
check(
	"the plain shutdown warning matches the spec text verbatim, tool and duration substituted",
	pendingCallShutdownWarning("bash", 5 * 60_000),
	"WARNING: closing with a bash call still pending (issued 5m ago) — the turn stays blocked until this session is reopened and any prompt answered.",
);
check(
	"the notify text names the tool and how long it has run",
	pendingCallAlertText("write", 12 * 60_000),
	"write call still running after 12m — still waiting for its result.",
);
{
	const startedAt = new Date(2024, 0, 1, 14, 47).getTime();
	const completedAt = startedAt + 6 * 3_600_000 + 12 * 60_000;
	check(
		"the stale-result reminder matches the spec text verbatim, times and duration substituted",
		staleResultReminder("bash", startedAt, completedAt),
		"The bash call you issued at 14:47 only executed at 20:59 — 6h12m later. Assume the workspace and any processes may have changed; re-verify state before building on this result.",
	);
}
check("wrapped as pi's own hidden-message reminders are", systemReminder("hello"), "<system-reminder>\nhello\n</system-reminder>");

console.log("\n--- abort-recovery entry wording (B) ---");
check("names the tool that hung, and never instructs the model — this is display-only", abortRecoveryLines("bash"), [
	"● Task unfinished",
	"Escape stopped a stuck bash call, not the task — the work above is still unfinished.",
	"Send any message to pick it back up where it left off.",
]);

// ------------------------------------------------------------------ settings

console.log("\n--- settings ---");
check("absent -> defaults", resolveSettings(undefined), DEFAULT_SETTINGS);
check("maxResumes applied", resolveSettings({ maxResumes: 5 }).maxResumes, 5);
// 0 is a real choice: detect and report, never resume.
check("zero is honoured, not treated as unset", resolveSettings({ maxResumes: 0 }).maxResumes, 0);
check("negative falls back", resolveSettings({ maxResumes: -1 }).maxResumes, DEFAULT_SETTINGS.maxResumes);
check("non-numeric falls back", resolveSettings({ maxResumes: "lots" }).maxResumes, DEFAULT_SETTINGS.maxResumes);
check("pendingToolCallAlertMs applied", resolveSettings({ pendingToolCallAlertMs: 120_000 }).pendingToolCallAlertMs, 120_000);
// 0 is meaningful — alerts off, tracking/shutdown-warning/stale-reminder stay on.
check("zero is honoured, not treated as unset", resolveSettings({ pendingToolCallAlertMs: 0 }).pendingToolCallAlertMs, 0);
check("negative falls back", resolveSettings({ pendingToolCallAlertMs: -1 }).pendingToolCallAlertMs, DEFAULT_SETTINGS.pendingToolCallAlertMs);
check(
	"non-numeric falls back",
	resolveSettings({ pendingToolCallAlertMs: "lots" }).pendingToolCallAlertMs,
	DEFAULT_SETTINGS.pendingToolCallAlertMs,
);
writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ stalledTurn: { maxResumes: 3 } }));
check("read from disk", loadSettings(AGENT).maxResumes, 3);
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unparsable -> defaults", loadSettings(AGENT), DEFAULT_SETTINGS);

// -------------------------------------------------------------------- wiring

console.log("\n--- wiring ---");
type Handler = (event: unknown, ctx?: unknown) => unknown;
/**
 * `idle` is the state of the session when message_end fires. It defaults to
 * FALSE because that is the real case: message_end is emitted from inside the
 * agent loop, so _isAgentRunActive is still true and ctx.isIdle() is false.
 * The idle path exists too (a stall on the very last message of a settled run),
 * so both are exercised — but the default matches production.
 */
function install(block: Record<string, unknown>, idle = false) {
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ stalledTurn: block }));
	const handlers = new Map<string, Handler>();
	const sent: Array<{ content: unknown; customType: unknown; options: unknown }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: unknown }> = [];
	// undefined by default: no preceding entry, the safe fallback for every
	// test that is not specifically exercising the abort-recovery fingerprint.
	let leafEntry: unknown;
	const ctx = {
		isIdle: () => idle,
		hasUI: true,
		ui: { notify: (message: string, level?: unknown) => notifications.push({ message, level }) },
		sessionManager: { getLeafEntry: () => leafEntry },
	};
	register({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: (message: { content: unknown; customType: unknown }, options: unknown) =>
			sent.push({ content: message.content, customType: message.customType, options }),
	} as never);
	/** message_end as pi delivers it: with a context. */
	const end = (event: unknown) => handlers.get("message_end")?.(event, ctx);
	const setLeafEntry = (entry: unknown) => {
		leafEntry = entry;
	};
	return { handlers, sent, entries, notifications, ctx, end, setLeafEntry };
}

check("disabled registers nothing", [...install({ enabled: false }).handlers.keys()], []);

const stall = { message: { role: "assistant", content: [], stopReason: "stop" } };
{
	const { sent, entries, end } = install({ maxResumes: 2 });
	end(stall);
	check("a stall is resumed", sent.length, 1);
	check("with the transport explained, not a reprimand", sent[0]?.content, RESUME_PROMPT);
	// THE regression. This used to assert {triggerTurn: true, deliverAs:
	// "nextTurn"}, which resumes nothing: pi's sendCustomMessage tests deliverAs
	// first, so the nextTurn branch parks the message on a queue that is only
	// drained by the next human prompt and triggerTurn is never read. Mid-run —
	// which is when message_end fires — the shape that re-enters the loop is
	// followUp, and it must carry NO triggerTurn, or the same precedence bug is
	// just being asserted in a nicer-looking form.
	check("delivered as a follow-up, which re-enters the loop", sent[0]?.options, { deliverAs: "followUp" });
	check("under its own type", RESUME_TYPE, "stalled-turn-resume");
	check("and the user is told", entries[0]?.data, { attempt: 1, max: 2, resumed: true });

	// A healthy turn must be left completely alone.
	end({ message: { role: "assistant", content: [text("all done")], stopReason: "stop" } });
	check("a real reply is untouched", sent.length, 1);
}
{
	// The other branch: the run has already settled, so there is no live loop to
	// follow up into and the message has to start one.
	const { sent, end } = install({ maxResumes: 2 }, true);
	end(stall);
	check("once settled, it triggers a turn instead", sent[0]?.options, { triggerTurn: true });
}

console.log("\n--- the cap ---");
{
	const { handlers, sent, entries, end } = install({ maxResumes: 2 });
	end(stall);
	end(stall);
	check("resumes up to the cap", sent.length, 2);
	end(stall);
	// The whole point of the cap: a provider stuck returning empty completions
	// would otherwise loop forever, spending money and looking like a hang.
	check("and then stops", sent.length, 2);
	// Giving up SILENTLY would reproduce the exact symptom this exists to remove.
	check("saying so", entries.at(-1)?.data, { attempt: 0, max: 2, resumed: false });

	// A REAL steer, which is the shape that broke this. pi has no "steer" input
	// source — the earlier version of this test invented one, so it asserted
	// nothing while every actual steer refilled the budget and uncapped the loop.
	handlers.get("input")?.({ source: "interactive", streamingBehavior: "steer" });
	end(stall);
	check("a steer does not refill the budget", sent.length, 2);

	// Neither does a programmatic message.
	handlers.get("input")?.({ source: "extension" });
	end(stall);
	check("nor does an extension message", sent.length, 2);

	// A human typing is a fresh task and a fresh budget. streamingBehavior is
	// undefined when the editor was idle, which is what makes it a new turn.
	handlers.get("input")?.({ source: "interactive", streamingBehavior: undefined });
	end(stall);
	check("but a human prompt does", sent.length, 3);
}

console.log("\n--- maxResumes 0 ---");
{
	const { sent, entries, end } = install({ maxResumes: 0 });
	end(stall);
	check("never resumes", sent.length, 0);
	check("but still reports", entries.length, 1);
}

console.log("\n--- turn_end resets the cap on real progress (C1) ---");
{
	const { handlers, sent, entries, end } = install({ maxResumes: 1 });
	end(stall);
	end(stall);
	check("cap reached after one resume", sent.length, 1);
	check("and reported", entries.at(-1)?.data, { attempt: 0, max: 1, resumed: false });

	// Real progress — tools ran and produced results — means the stall above is
	// not part of an unbroken run of failures. maxResumes bounds CONSECUTIVE
	// stalls, not stalls accumulated over an entire multi-hour human turn.
	handlers.get("turn_end")?.({ toolResults: [{ role: "toolResult", toolCallId: "x", toolName: "bash", content: [], isError: false }] });
	end(stall);
	check("resumes again after real progress", sent.length, 2);

	// A turn that produced NO tool results (nothing ran) must not reset it —
	// the cap has to re-apply on the very next stall, not be forgiven forever.
	handlers.get("turn_end")?.({ toolResults: [] });
	end(stall);
	check("no tool results means no reset — the cap re-applies", sent.length, 2);
}

console.log("\n--- abort-recovery entry (B) ---");
{
	// The exact fingerprint: Escape right after a FAILED tool result that had
	// actually been running long enough (>= HUNG_TOOL_MIN_MS) to plausibly be
	// hung. tool_execution_start/end drive the same {toolCallId, startedAt}
	// tracking index.ts really uses, rather than asserting isAbortAfterHungTool
	// directly — this is the wiring that has to hand it the right duration.
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const { entries, sent, handlers, setLeafEntry, end } = install({});
		handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		clock += HUNG_TOOL_MIN_MS; // ran exactly to the floor — long enough to plausibly be hung
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true });
		setLeafEntry({ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [] } });
		end({ message: { role: "assistant", content: [], stopReason: "aborted" } });
		check("appends the abort-recovery entry, under its own type", entries[0]?.type, ABORT_RECOVERY_ENTRY_TYPE);
		check("naming the tool that hung", entries[0]?.data, { toolName: "bash" });
		check("never auto-resumes — that would fight the user's own Escape", sent.length, 0);
	} finally {
		Date.now = realNow;
	}
}
{
	// FIX 3's own regression case: an ORDINARY fast failure — isError, well
	// under the hung-tool floor — followed by Escape for some unrelated reason
	// has the exact same shape (aborted + empty + a preceding isError result)
	// and must NOT be mislabelled "stuck tool, unstuck".
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const { entries, handlers, setLeafEntry, end } = install({});
		handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		clock += 900; // under a second — an ordinary quick failure, not a hang
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true });
		setLeafEntry({ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [] } });
		end({ message: { role: "assistant", content: [], stopReason: "aborted" } });
		check("a quick failure followed by Escape is a plain cancel, not this fingerprint", entries.length, 0);
	} finally {
		Date.now = realNow;
	}
}
{
	// A clean cancel — the preceding tool result SUCCEEDED — must be left alone,
	// however long it ran.
	const { entries, end, setLeafEntry } = install({});
	setLeafEntry({ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [] } });
	end({ message: { role: "assistant", content: [], stopReason: "aborted" } });
	check("a clean cancel after a successful tool result is not this fingerprint", entries.length, 0);
}
{
	// No preceding tool result at all (e.g. Escape right after a user message).
	const { entries, end, setLeafEntry } = install({});
	setLeafEntry({ type: "message", message: { role: "user", content: "stop" } });
	end({ message: { role: "assistant", content: [], stopReason: "aborted" } });
	check("an abort with nothing pending behind it is left alone", entries.length, 0);
}
{
	// Existing empty-completion resume behaviour must survive B's addition —
	// it runs first in the same handler, so a regression here would be silent.
	const { entries, sent, end } = install({ maxResumes: 2 });
	end(stall);
	check("a plain stall (not an abort) still resumes as before", sent.length, 1);
	check("and appends no abort-recovery entry", entries.some((e) => e.type === ABORT_RECOVERY_ENTRY_TYPE), false);
}

console.log("\n--- pending-call sentinel (A): stale-result reminder ---");
{
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const { handlers, sent } = install({});

		handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		clock += 10 * 60_000; // ten minutes — comfortably under the 30-minute line
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
		check("a completion well under 30 minutes gets no stale-result reminder", sent.length, 0);

		const startedAt = clock;
		handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
		clock += 31 * 60_000; // one minute past the 30-minute line
		const completedAt = clock;
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: {}, isError: false });
		check("a completion past 30 minutes gets exactly one reminder", sent.length, 1);
		check(
			"hidden, wrapped as a system-reminder, with the real start/completion times",
			sent[0]?.content,
			systemReminder(staleResultReminder("bash", startedAt, completedAt)),
		);
		check("mid-run, it rides in as a follow-up rather than starting a fresh turn", sent[0]?.options, { deliverAs: "followUp" });
		check("under its own type, distinct from the resume nudge", sent[0]?.customType, PENDING_STALE_MESSAGE_TYPE);

		// FIX 2's own regression case: a wedged tool settling AFTER the user has
		// already Escaped away (session idle) must still just queue. There is no
		// "the turn stalled, someone must re-enter the loop" case here the way
		// there is for the resume nudge above — triggerTurn would start a
		// brand-new unattended turn seeded on nothing but a hidden reminder,
		// fighting the user's own Escape. The handler no longer even reads
		// ctx.isIdle() for this path, so this holds unconditionally.
		handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: {} });
		clock += 31 * 60_000;
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "t3", toolName: "bash", result: {}, isError: false });
		check("still queued as a follow-up, never a triggered turn, however stale", sent[1]?.options, { deliverAs: "followUp" });

		// A completion pi's own event stream never bracketed with a start (should
		// not happen in practice, but tool_execution_end alone must not throw or
		// invent a reminder out of nothing).
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "never-started", toolName: "bash", result: {}, isError: false });
		check("an end with no matching start is a no-op", sent.length, 2);
	} finally {
		Date.now = realNow;
	}
}

console.log("\n--- pending-call sentinel (A): session_shutdown warning ---");
{
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	const realWrite = process.stdout.write.bind(process.stdout);
	/**
	 * Captures process.stdout.write calls made DURING fn only, restoring
	 * immediately after — never around a check() call. check()'s own PASS/FAIL
	 * line is itself printed via console.log -> process.stdout.write, and a
	 * mock left installed across the check() call would swallow that line too,
	 * silently: the assertion still runs correctly (JSON.stringify(got) is read
	 * before check()'s own log line is written), but the PASS/FAIL text a
	 * reader relies on for THIS test would vanish from the console.
	 */
	const captureWrites = (fn: () => void): string[] => {
		const written: string[] = [];
		process.stdout.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as never;
		try {
			fn();
		} finally {
			process.stdout.write = realWrite;
		}
		return written;
	};
	try {
		const { handlers } = install({});
		handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		clock += 5 * 60_000; // five minutes pending when the session closes
		const firstShutdown = captureWrites(() => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }));
		check("prints the plain stdout warning, verbatim modulo tool/duration", firstShutdown, [
			`${pendingCallShutdownWarning("bash", 5 * 60_000)}\n`,
		]);

		const secondShutdown = captureWrites(() => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }));
		check("the pending map is cleared after shutdown — nothing left to warn about twice", secondShutdown, []);
	} finally {
		Date.now = realNow;
	}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
