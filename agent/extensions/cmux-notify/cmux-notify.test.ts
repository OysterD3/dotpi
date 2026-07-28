/**
 * Tests for the cmux permission notifier: the pure payload building, and the
 * wiring against a fake pi (no cmux, no subprocess).
 *
 * Run with jiti from a directory where pi's packages resolve (they are not
 * dependencies of this repo):
 *     jiti agent/extensions/cmux-notify/cmux-notify.test.ts
 */
import {
	asAskEvent,
	asQuestionEvent,
	buildMessage,
	buildPayload,
	buildQuestionMessage,
	buildQuestionPayload,
	oneLine,
	shouldSend,
	type AskEvent,
	type QuestionEvent,
} from "./notify.ts";
import { ASK_CHANNEL, CONFIG, QUESTION_CHANNEL } from "./config.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

const ASK: AskEvent = {
	tool: "bash",
	target: "git push --force origin main",
	reason: "force-pushes, overwriting published history",
	findings: ["git-force-push"],
	sessionId: "sess-1",
	cwd: "/repo",
};

const QUESTION: QuestionEvent = {
	active: true,
	question: "Which library should we use for date formatting?",
	header: "Library",
	count: 1,
	sessionId: "sess-1",
	cwd: "/repo",
};

// ------------------------------------------------------------------- gating

console.log("--- gating mirrors cmux's own bridge ---");
check("no surface -> silent", shouldSend({}), false);
check("surface -> send", shouldSend({ CMUX_SURFACE_ID: "abc" }), true);
check("disabled wins", shouldSend({ CMUX_SURFACE_ID: "abc", CMUX_PI_HOOKS_DISABLED: "1" }), false);
check("only exact '1' disables", shouldSend({ CMUX_SURFACE_ID: "abc", CMUX_PI_HOOKS_DISABLED: "true" }), true);

// -------------------------------------------------------------- bus payload

console.log("\n--- narrowing the bus payload ---");
check("well-formed event", asAskEvent(ASK)?.tool, "bash");
check("missing tool -> undefined", asAskEvent({ target: "x" }), undefined);
check("not an object -> undefined", asAskEvent("nope"), undefined);
check("null -> undefined", asAskEvent(null), undefined);
check("absent fields default", asAskEvent({ tool: "read" }), {
	tool: "read",
	target: "",
	reason: "",
	findings: [],
	sessionId: undefined,
	cwd: undefined,
});
check("non-string findings dropped", asAskEvent({ tool: "bash", findings: ["ok", 3, null] })?.findings, ["ok"]);

// ------------------------------------------------------------------ message

console.log("\n--- the banner text ---");
check("bash reads as 'run'", buildMessage(ASK), "Pi needs your permission to run: git push --force origin main");
check(
	"other tools name the tool",
	buildMessage({ ...ASK, tool: "write", target: "/etc/hosts" }),
	"Pi needs your permission to use write on: /etc/hosts",
);
check("no target still says something", buildMessage({ ...ASK, target: "" }), "Pi needs your permission to use bash");
check("newlines collapse to one line", oneLine("a\n\n  b\tc ", 100), "a b c");
check("long targets are capped", oneLine("x".repeat(200), 10), "xxxxxxxxx…");
check(
	"a multiline heredoc stays one line",
	buildMessage({ ...ASK, target: "cat <<EOF\nline1\nline2\nEOF" }),
	"Pi needs your permission to run: cat <<EOF line1 line2 EOF",
);

// ------------------------------------------------------------------ payload

console.log("\n--- the cmux payload ---");
{
	const payload = buildPayload(ASK, "sess-1", "/repo");
	check("carries the load-bearing field", payload.notification_type, "permission_prompt");
	check("wire event name", payload.hook_event_name, CONFIG.hookEventName);
	check("event mirrors hook_event_name", payload.event, CONFIG.hookEventName);
	check("session and cwd", [payload.session_id, payload.cwd], ["sess-1", "/repo"]);
	check("tool name for the feed title", payload.tool_name, "bash");
	check("reason rides along", payload.reason, "force-pushes, overwriting published history");
	check("findings ride along", payload.findings, ["git-force-push"]);
	check("message is the banner", payload.message, buildMessage(ASK));
}
{
	// Empty extras are omitted rather than sent as empty strings/arrays.
	const bare = buildPayload({ tool: "read", target: "", reason: "", findings: [] }, "s", "/c");
	check("empty reason omitted", "reason" in bare && bare.reason !== undefined, false);
	check("empty findings omitted", "findings" in bare && bare.findings !== undefined, false);
	check("still serialises", typeof JSON.stringify(bare), "string");
}

// ----------------------------------------------------------------- questions

console.log("\n--- narrowing a question payload ---");
check("well-formed question", asQuestionEvent(QUESTION)?.question, "Which library should we use for date formatting?");
check("the closing announcement parses", asQuestionEvent({ active: false }), {
	active: false,
	question: "",
	header: undefined,
	count: 1,
	sessionId: undefined,
	cwd: undefined,
});
check("no active flag -> undefined", asQuestionEvent({ question: "x" }), undefined);
check("not an object -> undefined", asQuestionEvent("nope"), undefined);
check("a blank header is dropped", asQuestionEvent({ active: true, header: "  " })?.header, undefined);
check("a nonsense count falls back to one", asQuestionEvent({ active: true, count: 0 })?.count, 1);

console.log("\n--- the question banner ---");
check("carries the question itself", buildQuestionMessage(QUESTION), "Pi is asking: Which library should we use for date formatting?");
check(
	"several questions say how many",
	buildQuestionMessage({ ...QUESTION, count: 3 }),
	"Pi is asking 3 questions: Which library should we use for date formatting?",
);
check("no text still says something", buildQuestionMessage({ ...QUESTION, question: "" }), "Pi is asking for your input");
check(
	"a long question is capped to one line",
	buildQuestionMessage({ ...QUESTION, question: `${"why ".repeat(80)}?` }).length <= CONFIG.targetChars + 20,
	true,
);

console.log("\n--- the question payload ---");
{
	const payload = buildQuestionPayload(QUESTION, "sess-1", "/repo");
	// A question is not an approval, but it stops pi on a human just the same,
	// and this is the only field that flips cmux to needsInput.
	check("still the load-bearing field", payload.notification_type, "permission_prompt");
	check("titled as a question, not an approval", payload.title, "Pi has a question");
	check("named after the tool", payload.tool_name, CONFIG.questionTool);
	check("session and cwd", [payload.session_id, payload.cwd], ["sess-1", "/repo"]);
	check("the header rides along as the reason", payload.reason, "Library");
	check("message is the banner", payload.message, buildQuestionMessage(QUESTION));
	check("no header, no key", "reason" in buildQuestionPayload({ ...QUESTION, header: undefined }, "s", "/c") && buildQuestionPayload({ ...QUESTION, header: undefined }, "s", "/c").reason !== undefined, false);
}

// ------------------------------------------------------------------- wiring

console.log("\n--- wiring against a fake pi ---");
{
	const handlers = new Map<string, (data: unknown) => void>();
	const events = new Map<string, Function>();
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			},
			emit: () => {},
		},
	};

	const extension = (await import("./index.ts")).default;
	extension(pi as never);

	check("subscribes to the ask channel", handlers.has(ASK_CHANNEL), true);
	check("subscribes to the question channel", handlers.has(QUESTION_CHANNEL), true);
	check("hooks session_start", events.has("session_start"), true);

	// With no cmux surface in the environment, firing the channel must not
	// spawn anything — proven by the absence of a throw and of any child.
	const previous = process.env.CMUX_SURFACE_ID;
	delete process.env.CMUX_SURFACE_ID;
	let threw = false;
	try {
		handlers.get(ASK_CHANNEL)!(ASK);
		handlers.get(ASK_CHANNEL)!("garbage");
		handlers.get(ASK_CHANNEL)!(undefined);
		handlers.get(QUESTION_CHANNEL)!(QUESTION);
		handlers.get(QUESTION_CHANNEL)!({ active: false });
		handlers.get(QUESTION_CHANNEL)!("garbage");
	} catch {
		threw = true;
	}
	if (previous !== undefined) process.env.CMUX_SURFACE_ID = previous;
	check("outside cmux, nothing is sent and nothing throws", threw, false);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
