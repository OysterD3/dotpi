/**
 * Wiring for context-diet: the real index.ts against a fake `pi`, no provider
 * and no session on disk beyond a scratch agent dir.
 *
 * Separate from context-diet.test.ts on purpose. That suite's header promises
 * it runs from a bare checkout because the modules it imports take pi only for
 * types; index.ts imports pi's runtime, so importing it there would quietly
 * retire that promise.
 *
 * What it covers is the half the unit suite cannot see: WHEN the escalation
 * reminder is sent. Everything about deciding to escalate is decided in
 * session.ts and tested there; everything about it landing in the transcript as
 * an unexplained "Understood." was decided here.
 *
 *     jiti agent/extensions/context-diet/context-diet.e2e.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "context-diet-e2e-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

// Absolute bounds and escalateAfterRounds: 1, so one round over the mark is the
// whole setup — the ratios would need a real context window to reason about.
writeFileSync(
	join(AGENT, "settings.json"),
	JSON.stringify({
		contextDiet: { highWaterTokens: 10_000, targetTokens: 5_000, keepRecentResults: 1, minResultBytes: 100, escalateAfterRounds: 1 },
	}),
);

const contextDiet = (await import("./index.ts")).default;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------- fake pi

const events = new Map<string, Function>();
const sent: Array<{ message: any; options: any }> = [];
const notices: Array<{ message: string; type: string }> = [];
const entries: Array<{ customType: string; data: any }> = [];

const pi = {
	on: (event: string, handler: Function) => events.set(event, handler),
	events: { on: () => () => {}, emit: () => {} },
	registerTool: () => {},
	registerEntryRenderer: () => {},
	sendMessage: (message: any, options: any) => sent.push({ message, options }),
	appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
};

contextDiet(pi as any);

const ctx = {
	model: { contextWindow: 20_000 },
	getContextUsage: () => ({ tokens: 19_000 }),
	isIdle: () => false,
	sessionManager: { getBranch: () => [] },
	ui: { notify: (message: string, type = "info") => notices.push({ message, type }) },
};

/** One assistant turn plus its result — big enough to be worth evicting. */
let seq = 0;
function exchange() {
	const id = `call_${seq++}`;
	return [
		{ role: "assistant", timestamp: seq, content: [{ type: "toolCall", id, name: "read", arguments: { path: `src/f-${id}.ts` } }] },
		{ role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: seq, content: [{ type: "text", text: "b".repeat(40_000) }] },
	];
}
const messages = (n: number) => Array.from({ length: n }, exchange).flat();

/** Everything a model call does here: the context hook, then whatever follows. */
const contextHook = () => events.get("context")!({ type: "context", messages: messages(12) }, ctx);

// ------------------------------------------------------------------- the gate

console.log("--- a round does not send anything by itself ---");
{
	events.get("agent_start")!({}, ctx);
	const result = contextHook();
	check("the round trimmed the request", Array.isArray(result?.messages), true);
	check("and recorded itself in the transcript", entries.at(-1)?.customType, "context-diet");
	// The bug: sending from in here enqueues a steer during a model call, and a
	// steer that arrives on a turn's LAST call is not consumed by it — the loop
	// drains the queue after the turn and re-enters, so a finishing turn ran one
	// extra assistant call carrying nothing but this reminder. The model
	// answered it ("Understood."), and the user saw a reply to nothing, because
	// the reminder is display: false.
	check("nothing is sent from inside the context hook", sent.length, 0);
	check("and the user is not told the model was told", notices.length, 0);
}

console.log("\n--- a tool call proves the turn is going, and delivers it ---");
{
	events.get("tool_call")!({ type: "tool_call", toolName: "read" }, ctx);
	check("exactly one message goes out", sent.length, 1);
	check("as a hidden escalation", [sent[0]?.message.customType, sent[0]?.message.display], ["context-diet-escalation", false]);
	// "steer", not "followUp": followUp drains only once the model stops calling
	// tools, which is the behaviour this reminder exists to interrupt.
	check("steered, so a turn still calling tools sees it", sent[0]?.options, { deliverAs: "steer" });
	check("it tells the model not to answer it", sent[0]?.message.content.includes("do not reply to it"), true);
	check("the user hears about it now, not before", notices.length, 1);
	check("and the notice claims only what happened", notices[0]?.message.includes("Told the model to change strategy"), true);

	events.get("tool_call")!({ type: "tool_call", toolName: "read" }, ctx);
	check("a second tool call sends nothing more", sent.length, 1);
}

console.log("\n--- a turn that ends first says nothing at all ---");
{
	sent.length = 0;
	notices.length = 0;
	// A fresh turn: agent_start resets the counters, so this one escalates on its
	// own round rather than inheriting the last turn's.
	events.get("agent_settled")!({}, ctx);
	events.get("agent_start")!({}, ctx);
	contextHook();
	check("the round fired", entries.length > 1, true);
	events.get("agent_settled")!({}, ctx);
	events.get("tool_call")!({ type: "tool_call", toolName: "read" }, ctx);
	check("nothing is delivered after the turn settled", sent.length, 0);
	check("and nothing is claimed to the user", notices.length, 0);
}

console.log("\n--- an armed escalation does not cross a turn boundary ---");
{
	events.get("agent_start")!({}, ctx);
	contextHook();
	// Armed. A new turn starts before any tool call — "trimmed N times this
	// turn" would be a statement about a turn that has already ended.
	events.get("agent_settled")!({}, ctx);
	events.get("agent_start")!({}, ctx);
	events.get("tool_call")!({ type: "tool_call", toolName: "read" }, ctx);
	check("the stale reminder is dropped, not delivered late", sent.length, 0);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
