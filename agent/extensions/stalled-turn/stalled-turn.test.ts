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

const { hasNoContent, isStalled } = await import("./detect.ts");
const { DEFAULT_SETTINGS, RESUME_PROMPT, RESUME_TYPE, resolveSettings } = await import("./config.ts");
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
check("no message at all", isStalled(undefined), false);

// ------------------------------------------------------------------ settings

console.log("\n--- settings ---");
check("absent -> defaults", resolveSettings(undefined), DEFAULT_SETTINGS);
check("maxResumes applied", resolveSettings({ maxResumes: 5 }).maxResumes, 5);
// 0 is a real choice: detect and report, never resume.
check("zero is honoured, not treated as unset", resolveSettings({ maxResumes: 0 }).maxResumes, 0);
check("negative falls back", resolveSettings({ maxResumes: -1 }).maxResumes, DEFAULT_SETTINGS.maxResumes);
check("non-numeric falls back", resolveSettings({ maxResumes: "lots" }).maxResumes, DEFAULT_SETTINGS.maxResumes);
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
	const sent: Array<{ content: unknown; options: unknown }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const ctx = { isIdle: () => idle };
	register({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerEntryRenderer: () => {},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: (message: { content: unknown }, options: unknown) => sent.push({ content: message.content, options }),
	} as never);
	/** message_end as pi delivers it: with a context. */
	const end = (event: unknown) => handlers.get("message_end")?.(event, ctx);
	return { handlers, sent, entries, end };
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
