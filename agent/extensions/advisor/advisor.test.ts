/**
 * Tests for the advisor extension: the branch→transcript flattening, the
 * reviewer prompt assembly, model resolution and the validation
 * rules that port, the usage mapping, settings parsing, and the wiring against
 * a fake pi (tool/flag/command registration, active-tool sync, and the /advisor
 * paths and pre-spawn tool branches that do not touch a subprocess).
 *
 * The happy path — an actual reviewer call — needs the network and credentials
 * and lives in advisor.live.ts, excluded from this suite like ultracode.live.ts.
 *
 * Run with jiti from a directory where pi's packages resolve:
 *     jiti agent/extensions/advisor/advisor.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "advisor-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { buildSections, buildTranscript } = await import("./transcript.ts");
const { buildReviewerPrompt, REVIEWER_PROMPT, ADVISOR_TOOL_GUIDANCE } = await import("./guidance.ts");
const { resolveModelReference, modelRef, sameModel } = await import("./models.ts");
const { CONFIG } = await import("./config.ts");
const { buildArgs, scrubArg } = await import("./spawn.ts");
const { advisorStatus, compactCount, emptyProgress, formatElapsed, phaseFor, scanBlocks } = await import("./progress.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

// ------------------------------------------------------------------ transcript

console.log("--- transcript: flattening the branch ---");
const BRANCH = [
	{ type: "message", message: { role: "user", content: "Do the thing" } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I'll look first." },
				{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			],
		},
	},
	{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file contents" }] } },
	{ type: "custom", customType: "something", data: { x: 1 } },
];
check("sections cover user, assistant+call, and result", buildSections(BRANCH as never), [
	"User:\nDo the thing",
	'Assistant:\nI\'ll look first.\n  → called read({"path":"a.ts"})',
	"Result of read:\nfile contents",
]);
check("non-message entries are ignored", buildSections([{ type: "custom" }, { type: "label" }] as never), []);
check("assistant with only a tool call still appears", buildSections([
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }] } },
] as never), ['  → called bash({"cmd":"ls"})']);

console.log("\n--- transcript: a long tool result is truncated ---");
const bigResult = "x".repeat(CONFIG.maxToolResultChars + 500);
const [truncatedSection] = buildSections([
	{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: bigResult }] } },
] as never);
checkTrue("result is shortened", truncatedSection.length < bigResult.length);
checkTrue("truncation is announced", truncatedSection.includes("characters truncated"));

console.log("\n--- transcript: budget drops the oldest first ---");
const many = Array.from({ length: 6 }, (_, i) => ({
	type: "message",
	message: { role: "user", content: `message number ${i} with some length to it` },
}));
const tight = buildTranscript(many as never, 10); // ~17 char budget forces heavy dropping
checkTrue("some messages were dropped", tight.dropped > 0);
checkTrue("the newest message is kept", tight.text.includes("message number 5"));
checkTrue("a drop notice is shown", tight.text.includes("omitted to fit"));
const roomy = buildTranscript(many as never, 1_000_000);
check("with room, nothing is dropped", roomy.dropped, 0);
checkTrue("no notice when nothing dropped", !roomy.text.includes("omitted to fit"));

// --------------------------------------------------------------- reviewer prompt

console.log("\n--- the reviewer prompt ---");
const prompt = buildReviewerPrompt("User:\nhello");
checkTrue("carries the reviewer instructions", prompt.startsWith(REVIEWER_PROMPT));
checkTrue("wraps the transcript in markers", prompt.includes("--- BEGIN SESSION TRANSCRIPT ---") && prompt.includes("--- END SESSION TRANSCRIPT ---"));
checkTrue("includes the transcript body", prompt.includes("User:\nhello"));
checkTrue("ends with the cue", prompt.trimEnd().endsWith("Give your advice now."));
checkTrue("empty transcript gets a placeholder", buildReviewerPrompt("   ").includes("no prior messages yet"));
checkTrue("the main-agent guidance carries its load-bearing lines", ADVISOR_TOOL_GUIDANCE.includes("backed by a stronger reviewer model") && ADVISOR_TOOL_GUIDANCE.includes("Orientation is not substantive work"));

// The reviewer runs --no-tools and sees only the transcript, but it is asked to
// be specific and to produce prioritised next steps — so it invents concrete
// detail. Observed: "Read ~/.pi/agent/skills/ultracode/SKILL.md", a file that
// does not exist, as step 1 of a numbered plan the agent is told to weight.
checkTrue("the reviewer is confined to what it has seen", REVIEWER_PROMPT.includes("STAY INSIDE WHAT YOU HAVE SEEN"));
checkTrue(
	"and told not to name unseen files",
	REVIEWER_PROMPT.includes("must be one that actually appears in the transcript"),
);
// Without this it complies by going vague, which loses the value of the tool.
checkTrue("it is given the alternative to inventing a path", REVIEWER_PROMPT.includes("say what to look FOR"));
checkTrue("and told to flag what it is inferring", REVIEWER_PROMPT.includes('"if X exists"'));
// The other half: the agent was told to weight the advice, which is what turns
// an invented path into an instruction it follows.
checkTrue("the caller verifies details rather than trusting them", ADVISOR_TOOL_GUIDANCE.includes("Weight the JUDGMENT, verify the DETAILS"));
checkTrue(
	"and keeps the point when the detail is wrong",
	ADVISOR_TOOL_GUIDANCE.includes("a wrong filename does not make the underlying point wrong"),
);

// -------------------------------------------------------------------- models

console.log("\n--- model resolution ---");
const MODELS = [
	{ id: "claude-opus-4-8", name: "Opus 4.8", provider: "anthropic", contextWindow: 1_000_000 },
	{ id: "claude-sonnet-5", name: "Sonnet 5", provider: "anthropic", contextWindow: 1_000_000 },
	{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai-codex", contextWindow: 400_000 },
];
const resolvedId = (ref: string) => {
	const r = resolveModelReference(ref, MODELS);
	return r.ok ? modelRef(r.model) : `ERR:${r.error}`;
};
check("partial name -> opus", resolvedId("opus"), "anthropic/claude-opus-4-8");
check("partial name -> sonnet", resolvedId("sonnet"), "anthropic/claude-sonnet-5");
check("canonical provider/id", resolvedId("anthropic/claude-opus-4-8"), "anthropic/claude-opus-4-8");
check("bare exact id", resolvedId("gpt-5.6-sol"), "openai-codex/gpt-5.6-sol");
checkTrue("ambiguous partial is rejected", resolvedId("claude").startsWith("ERR:"));
checkTrue("unknown reference is rejected", resolvedId("does-not-exist").startsWith("ERR:"));
checkTrue("empty reference is rejected", resolvedId("").startsWith("ERR:"));

console.log("\n--- sameModel: labels a self-advising setup (allowed on purpose) ---");
const opus = MODELS[0];
const sonnet = MODELS[1];
check("same model detected", sameModel(opus, { ...opus }), true);
check("different models are fine", sameModel(opus, sonnet), false);
check("undefined is never 'same'", sameModel(opus, undefined), false);

// ---------------------------------------------------------------- usage mapping

console.log("\n--- usage mapping (SpawnUsage -> pi Usage) ---");
const { toPiUsage } = await import("./tool.ts");
check("maps counts and sums cost into total", toPiUsage({ input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: 0.5, totalTokens: 30, turns: 1 }), {
	input: 10,
	output: 20,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
});

// ------------------------------------------------------------------- settings

console.log("\n--- settings ---");
const { loadSettings } = await import("./index.ts");
const { DEFAULT_RESURFACE_SETTINGS } = await import("./config.ts");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ advisor: block }));

writeSettings({});
check("defaults: no model, enabled, default resurface", loadSettings(AGENT), {
	model: undefined,
	enabled: true,
	resurface: DEFAULT_RESURFACE_SETTINGS,
});
writeSettings({ model: "opus", enabled: false });
check("model and kill switch parsed", loadSettings(AGENT), { model: "opus", enabled: false, resurface: DEFAULT_RESURFACE_SETTINGS });
writeSettings({ model: "   " });
check("blank model is treated as unset", loadSettings(AGENT).model, undefined);
writeSettings({ enabled: "yes" });
check("wrong-typed enabled falls back to true", loadSettings(AGENT).enabled, true);
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unreadable settings fall back", loadSettings(AGENT), {
	model: undefined,
	enabled: true,
	resurface: DEFAULT_RESURFACE_SETTINGS,
});

console.log("\n--- resurface settings parsing ---");
writeSettings({ resurface: { enabled: false, afterCalls: 5 } });
check("resurface block overrides both fields", loadSettings(AGENT).resurface, { enabled: false, afterCalls: 5 });
writeSettings({ resurface: { enabled: "nope" } });
check("wrong-typed resurface.enabled falls back to true", loadSettings(AGENT).resurface.enabled, true);
writeSettings({ resurface: { afterCalls: 0 } });
check("afterCalls: 0 falls back to the default (0 would fire on the very next call)", loadSettings(AGENT).resurface.afterCalls, 15);
writeSettings({ resurface: { afterCalls: -3 } });
check("negative afterCalls falls back to the default", loadSettings(AGENT).resurface.afterCalls, 15);
writeSettings({ resurface: { afterCalls: 2.5 } });
check("non-integer afterCalls falls back to the default", loadSettings(AGENT).resurface.afterCalls, 15);
writeSettings({ resurface: { afterCalls: "12" } });
check("wrong-typed afterCalls falls back to the default", loadSettings(AGENT).resurface.afterCalls, 15);
writeSettings({ resurface: "nope" });
check("non-object resurface block falls back entirely", loadSettings(AGENT).resurface, DEFAULT_RESURFACE_SETTINGS);

// ------------------------------------------------------------------ resurface

console.log("\n--- resurface: advice-head truncation ---");
{
	const { truncateAdviceHead } = await import("./resurface.ts");
	check("short advice is untouched", truncateAdviceHead("keep it simple"), "keep it simple");
	check("surrounding whitespace is trimmed", truncateAdviceHead("  keep it simple  "), "keep it simple");
	const long = "x".repeat(900);
	const head = truncateAdviceHead(long);
	check("head is capped at 800 chars plus an ellipsis marker", head, `${"x".repeat(800)}…`);
	checkTrue("truncation is marked", head.endsWith("…"));
	check("exactly at the cap is not marked", truncateAdviceHead("x".repeat(800)), "x".repeat(800));
	check("a custom cap is honored", truncateAdviceHead("abcdefghij", 4), "abcd…");
}

console.log("\n--- resurface: the counter / re-arm state machine ---");
{
	const { isMutatingTool, markResurfaced, onConsult, recordMutatingCall, shouldResurface } = await import("./resurface.ts");

	checkTrue("write is mutating", isMutatingTool("write"));
	checkTrue("edit is mutating", isMutatingTool("edit"));
	checkTrue("bash is mutating", isMutatingTool("bash"));
	checkTrue("read is not", !isMutatingTool("read"));
	checkTrue("grep is not", !isMutatingTool("grep"));
	checkTrue("the advisor's own call is not", !isMutatingTool("advisor"));

	const settings = { enabled: true, afterCalls: 3 };

	let state = onConsult(7, "Fix the null check before anything else.");
	check("a fresh consult starts at zero, unarmed", [state.mutatingCallsSince, state.resurfaced], [0, false]);
	check("atCall records the call it was given at", state.atCall, 7);
	check("adviceHead holds the (short) advice verbatim", state.adviceHead, "Fix the null check before anything else.");

	checkTrue("below threshold, it does not resurface", !shouldResurface(state, settings));
	state = recordMutatingCall(state);
	checkTrue("one mutating call in, still below threshold (3)", !shouldResurface(state, settings));
	state = recordMutatingCall(state);
	state = recordMutatingCall(state);
	check("three mutating calls reaches the threshold", state.mutatingCallsSince, 3);
	checkTrue("at the threshold, it resurfaces", shouldResurface(state, settings));

	state = markResurfaced(state);
	checkTrue("marked, it will not resurface again", !shouldResurface(state, settings));
	state = recordMutatingCall(state);
	checkTrue("even well past the threshold", !shouldResurface(state, settings));

	const rearmed = onConsult(20, "Different advice now.");
	check("a new consult resets mutatingCallsSince to 0", rearmed.mutatingCallsSince, 0);
	let reprimed = rearmed;
	reprimed = recordMutatingCall(recordMutatingCall(recordMutatingCall(reprimed)));
	checkTrue("...and re-arms the resurface after its own threshold", shouldResurface(reprimed, settings));

	const disabled = { enabled: false, afterCalls: 3 };
	const overThreshold = recordMutatingCall(recordMutatingCall(recordMutatingCall(onConsult(0, "x"))));
	checkTrue("disabled settings never resurface, even over threshold", !shouldResurface(overThreshold, disabled));
}

console.log("\n--- resurface: wording ---");
{
	const { CLOSING_LINE, appendClosingLine, resurfaceReminder, systemReminder } = await import("./resurface.ts");

	const reminder = resurfaceReminder("Fix the null check before anything else.");
	checkTrue("names the advice head as a literal quote", reminder.includes('"Fix the null check before anything else."'));
	checkTrue(
		"asks for a one-line consistency check",
		reminder.includes("in one line: are your actions since then consistent with it?"),
	);
	checkTrue(
		"gives two ways out: comply or escalate",
		reminder.includes("either comply or call the advisor again and surface the conflict explicitly"),
	);

	const wrapped = systemReminder("x");
	checkTrue("systemReminder wraps in the tag pi's own reminders use", wrapped.startsWith("<system-reminder>\n") && wrapped.endsWith("\n</system-reminder>"));

	check("the closing line is appended after a blank line", appendClosingLine("Do X first."), `Do X first.\n\n${CLOSING_LINE}`);
	checkTrue(
		"the closing line demands engagement without owning the opening",
		CLOSING_LINE.includes("weigh this advice explicitly") && CLOSING_LINE.includes("state in one line why not"),
	);
	checkTrue("and does not dictate how the next message must start", !CLOSING_LINE.includes("Start your next message"));
}

// ------------------------------------------------------------------- progress

console.log("\n--- reading the child's stream ---");
check("no content, nothing counted", scanBlocks(undefined), { thinkingChars: 0, adviceChars: 0 });
check("not an array, nothing counted", scanBlocks("nope"), { thinkingChars: 0, adviceChars: 0 });
check(
	"reasoning and advice are counted apart",
	scanBlocks([
		{ type: "thinking", thinking: "hmm" },
		{ type: "text", text: "do the thing" },
		{ type: "thinking", thinking: "!" },
	]),
	{ thinkingChars: 4, adviceChars: 12 },
);
check("blocks of other kinds are ignored", scanBlocks([{ type: "toolCall", id: "x" }]), { thinkingChars: 0, adviceChars: 0 });
// A partial message arrives with the field missing before the first token.
check("a half-built block does not throw", scanBlocks([{ type: "text" }, { type: "thinking" }]), { thinkingChars: 0, adviceChars: 0 });

console.log("\n--- which phase the counts describe ---");
check("nothing yet", phaseFor(0, 0), "starting");
check("reasoning only", phaseFor(500, 0), "thinking");
check("advice outranks reasoning", phaseFor(5000, 10), "writing");

console.log("\n--- the status line ---");
{
	const model = "anthropic/claude-opus-5";
	const timeoutMs = CONFIG.reviewerTimeoutMs;
	const at = (progress: any, elapsedMs: number) => advisorStatus({ model, progress, elapsedMs, timeoutMs });

	check("before the first token, the clock is the news", at(emptyProgress(), 8000), `Consulting ${model}… 8s`);
	check(
		"reasoning says so, with its volume",
		at({ phase: "thinking", thinkingChars: 3120, adviceChars: 0, turns: 0 }, 72_000),
		`${model} is thinking… 1m 12s · 3.1k chars of reasoning`,
	);
	check(
		"writing says so too",
		at({ phase: "writing", thinkingChars: 3120, adviceChars: 840, turns: 0 }, 100_000),
		`${model} is writing advice… 1m 40s · 840 chars`,
	);
	// The deadline is named only once the wait is long enough to worry about.
	checkTrue("no deadline early on", !at(emptyProgress(), 60_000).includes("gives up"));
	checkTrue("the deadline appears late on", at(emptyProgress(), 4 * 60_000).includes("gives up at 5m 0s"));

	check("elapsed under a minute", formatElapsed(45_900), "45s");
	check("elapsed over a minute", formatElapsed(72_000), "1m 12s");
	check("no zero padding, whatever the README once said", formatElapsed(242_000), "4m 2s");
	check("a negative clock cannot go backwards", formatElapsed(-5), "0s");
	check("counts under a thousand are exact", compactCount(999), "999");
	check("and compact above it", compactCount(3120), "3.1k");

	// A retry restarts the volume, so the line says why rather than looking like
	// it lost the work it had already shown.
	checkTrue(
		"a retry is named",
		at({ phase: "thinking", thinkingChars: 200, adviceChars: 0, turns: 1, attempt: 2 }, 30_000).includes("attempt 2"),
	);
	checkTrue("a first attempt is not", !at(emptyProgress(), 30_000).includes("attempt"));
}

console.log("\n--- the phase follows whichever count is moving ---");
{
	// A model that opens with a one-line preamble and then reasons for minutes
	// must not latch on "writing advice" beside a frozen character count.
	const afterPreamble = phaseFor(0, 24, { thinkingChars: 0, adviceChars: 0, phase: "starting" });
	check("the preamble reads as writing", afterPreamble, "writing");
	check(
		"then reasoning takes the label back",
		phaseFor(900, 24, { thinkingChars: 0, adviceChars: 24, phase: afterPreamble }),
		"thinking",
	);
	check(
		"and advice takes it again when it resumes",
		phaseFor(900, 400, { thinkingChars: 900, adviceChars: 24, phase: "thinking" }),
		"writing",
	);
	// A tick with nothing new must not flap the label back to "starting".
	check(
		"a quiet moment holds the label",
		phaseFor(900, 24, { thinkingChars: 900, adviceChars: 24, phase: "thinking" }),
		"thinking",
	);
}

// ------------------------------------------- progress against a fake pi child

console.log("\n--- the child's stream drives the status (fake child, no model) ---");
{
	// piInvocation() spawns `node <process.argv[1]> <pi args>`, so pointing that
	// at a script of our own exercises the real parser against a real subprocess
	// and a real stream — everything but the model.
	const fake = join(ROOT, "fake-pi.js");
	writeFileSync(
		fake,
		`const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const msg = (content) => ({ role: "assistant", content });
say({ type: "message_start", message: msg([]) });
say({ type: "message_update", message: msg([{ type: "thinking", thinking: "weighing it up" }]) });
say({ type: "message_update", message: msg([{ type: "thinking", thinking: "weighing it up" }, { type: "text", text: "Two things" }]) });
say({ type: "message_end", message: { ...msg([{ type: "thinking", thinking: "weighing it up" }, { type: "text", text: "Two things stand out." }]),
  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.01 } }, stopReason: "stop" } });
// A non-assistant message must not be mistaken for reviewer output.
say({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } });
`,
	);

	// A retried attempt: the first ends in an error after producing a lot, then a
	// fresh attempt streams. The volume must describe the attempt on screen, not
	// the sum of a discarded one and its replacement.
	const retrying = join(ROOT, "fake-pi-retry.js");
	writeFileSync(
		retrying,
		`const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const msg = (content) => ({ role: "assistant", content });
const long = "x".repeat(3000);
say({ type: "message_update", message: msg([{ type: "thinking", thinking: long }]) });
say({ type: "message_end", message: { ...msg([{ type: "thinking", thinking: long }]), stopReason: "error", errorMessage: "overloaded" } });
say({ type: "message_start", message: msg([]) });
say({ type: "message_update", message: msg([{ type: "thinking", thinking: "second go" }]) });
say({ type: "message_end", message: { ...msg([{ type: "thinking", thinking: "second go" }, { type: "text", text: "Advice." }]),
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.002 } }, stopReason: "stop" } });
`,
	);

	const { runReviewer } = await import("./spawn.ts");
	const originalArgv1 = process.argv[1];
	process.argv[1] = fake;
	const phases: string[] = [];
	const volumes: number[] = [];
	try {
		const result = await runReviewer({
			prompt: "review this",
			cwd: ROOT,
			model: "anthropic/claude-opus-5",
			onProgress: (progress) => {
				phases.push(progress.phase);
				volumes.push(progress.thinkingChars + progress.adviceChars);
			},
		});
		check("the advice still comes back", result.text, "Two things stand out.");
		check("and its usage", [result.usage.turns, result.usage.cost], [1, 0.01]);
	} catch (error) {
		check("fake child ran", String(error), "no error");
	}
	process.argv[1] = originalArgv1;

	checkTrue("progress was reported at all", phases.length > 0);
	// message_start carries empty content and is deliberately not reported: on a
	// retry it would blank a line that is about to fill again, so the first word
	// comes from the first real token.
	check("the first report is real content", phases[0], "thinking");
	check("and it ends on writing", phases.at(-1), "writing");
	// Within one attempt the count must never fall back, or the row would appear
	// to lose work it had already shown.
	checkTrue(
		"the volume only grows within an attempt",
		volumes.every((value, index) => index === 0 || value >= volumes[index - 1]!),
	);

	// The retry: a discarded attempt's characters must not be added to its
	// replacement's, and the reader must be told why the number restarted.
	process.argv[1] = retrying;
	const retryVolumes: number[] = [];
	const attempts: number[] = [];
	try {
		const result = await runReviewer({
			prompt: "review this",
			cwd: ROOT,
			model: "anthropic/claude-opus-5",
			onProgress: (progress) => {
				retryVolumes.push(progress.thinkingChars + progress.adviceChars);
				attempts.push(progress.attempt);
			},
		});
		check("the retry's advice comes back", result.text, "Advice.");
	} catch (error) {
		check("retrying fake child ran", String(error), "no error");
	}
	process.argv[1] = originalArgv1;

	checkTrue("the first attempt's volume was large", Math.max(...retryVolumes) >= 3000);
	// 3000 discarded + ~9 regenerated: summing would leave the final report above
	// 3000, which is the double-count this guards.
	checkTrue("the retry's volume describes only the retry", retryVolumes.at(-1)! < 100);
	check("and the attempt number moves on", attempts.at(-1), 2);
}

// -------------------------------------------------- registerAdvisorTool branches

console.log("\n--- the tool's pre-spawn branches (no subprocess) ---");
{
	const { registerAdvisorTool } = await import("./tool.ts");
	let toolDef: any;
	const pi = { registerTool: (def: any) => (toolDef = def) };
	let reference: string | undefined;
	registerAdvisorTool(pi as never, { reference: () => reference });
	check("registered under the expected name", toolDef.name, "advisor");
	check("takes no parameters", Object.keys(toolDef.parameters.properties ?? {}), []);
	checkTrue("description is the verbatim guidance", toolDef.description.includes("backed by a stronger reviewer model"));

	const ctx = {
		cwd: ROOT,
		model: { id: "claude-opus-4-8", provider: "anthropic" },
		modelRegistry: { getAll: () => MODELS },
		sessionManager: { getBranch: () => BRANCH },
	};

	// Unconfigured -> throws asking for configuration.
	reference = undefined;
	let threw = "";
	try {
		await toolDef.execute("id", {}, undefined, undefined, ctx);
	} catch (e) {
		threw = (e as Error).message;
	}
	checkTrue("unconfigured throws a configure message", threw.includes("No advisor model is configured"));

	// Configured but unresolvable -> throws.
	reference = "not-a-real-model";
	threw = "";
	try {
		await toolDef.execute("id", {}, undefined, undefined, ctx);
	} catch (e) {
		threw = (e as Error).message;
	}
	checkTrue("unresolvable model throws", threw.includes("could not be used"));

	// A same-model advisor is allowed here — a stricter rule would refuse it — so
	// it no longer short-circuits before the spawn, and there is no pre-spawn
	// branch left to assert. advisor.live.ts covers the real call.
}

// ------------------------------------------------------ wiring against a fake pi

console.log("\n--- wiring against a fake pi ---");
function makePi() {
	const tools: any[] = [];
	const flags = new Map<string, unknown>();
	const commands = new Map<string, any>();
	let active: string[] = ["read", "bash"];
	const statuses: Array<[string, string | undefined]> = [];
	const notices: Array<[string, string]> = [];
	const events = new Map<string, Function>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		registerTool: (def: any) => {
			tools.push(def);
			if (!active.includes(def.name)) active = [...active, def.name]; // pi makes it active on registration
		},
		registerFlag: (name: string, _opts: unknown) => flags.set(name, undefined),
		getFlag: (name: string) => flags.get(name),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => (active = names),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	};
	// isIdle defaults to false: a tool_call always lands mid-turn (see index.ts's
	// resurface handler), so that is the realistic case to exercise by default.
	const uiCtx = (model: { id: string; provider: string }, opts: { isIdle?: boolean } = {}) => ({
		hasUI: true,
		cwd: ROOT,
		model,
		modelRegistry: { getAll: () => MODELS },
		isIdle: () => opts.isIdle ?? false,
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			notify: (message: string, level: string) => notices.push([level, message]),
		},
	});
	return { pi, tools, flags, commands, events, getActive: () => active, statuses, notices, uiCtx, sent };
}

const extension = (await import("./index.ts")).default;

// Configured via settings -> tool active + status chip on session_start.
{
	writeSettings({ model: "opus" });
	const h = makePi();
	extension(h.pi as never);
	check("registers the advisor tool", h.tools[0]?.name, "advisor");
	checkTrue("registers the --advisor flag", h.flags.has("advisor"));
	checkTrue("registers the /advisor command", h.commands.has("advisor"));

	h.events.get("session_start")!({}, h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" }));
	checkTrue("tool is active when configured and resolvable", h.getActive().includes("advisor"));
	check("status chip shows the reviewer", h.statuses.at(-1), ["advisor", "✦ advisor: claude-opus-4-8"]);
}

// No model configured -> tool deactivated, no chip.
{
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	h.events.get("session_start")!({}, h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" }));
	checkTrue("tool is removed when unconfigured", !h.getActive().includes("advisor"));
	check("chip cleared", h.statuses.at(-1), ["advisor", undefined]);
}

// Configured but unavailable model -> off, with a warning.
{
	writeSettings({ model: "ghost-model" });
	const h = makePi();
	extension(h.pi as never);
	h.events.get("session_start")!({}, h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" }));
	checkTrue("tool stays off for an unavailable model", !h.getActive().includes("advisor"));
	checkTrue("warns that the model is unavailable", h.notices.some(([lvl, m]) => lvl === "warn" && m.includes("not available")));
}

console.log("\n--- /advisor command ---");
{
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	const ctx = h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" });
	h.events.get("session_start")!({}, ctx);
	const advisor = h.commands.get("advisor");

	// Set a model for the session.
	await advisor.handler("opus", ctx);
	checkTrue("/advisor <model> activates the tool", h.getActive().includes("advisor"));
	checkTrue("confirms the model", h.notices.some(([lvl, m]) => lvl === "info" && m.includes("Advisor set to claude-opus-4-8")));

	// Turn it off for the session.
	await advisor.handler("off", ctx);
	checkTrue("/advisor off deactivates", !h.getActive().includes("advisor"));

	// Turn it back on (session model persists).
	await advisor.handler("on", ctx);
	checkTrue("/advisor on reactivates", h.getActive().includes("advisor"));

	// Status just reports.
	const before = h.getActive().length;
	await advisor.handler("status", ctx);
	check("/advisor status does not change tools", h.getActive().length, before);
	checkTrue("status mentions the model", h.notices.at(-1)![1].includes("claude-opus-4-8"));

	// An unknown model is rejected.
	await advisor.handler("nonsense-xyz", ctx);
	checkTrue("unknown model is rejected", h.notices.some(([lvl, m]) => lvl === "error" && m.includes("Cannot use")));

	// Setting the current session model is allowed, and the confirmation says so.
	await advisor.handler("sonnet", ctx); // ctx.model is claude-sonnet-5
	checkTrue("setting the current model is accepted", h.notices.some(([lvl, m]) => lvl === "info" && m.includes("reviews its own transcript")));
	checkTrue("same-model activates the tool", h.getActive().includes("advisor"));
}

// Kill switch: enabled=false keeps the tool off even with a model set.
{
	writeSettings({ model: "opus", enabled: false });
	const h = makePi();
	extension(h.pi as never);
	h.events.get("session_start")!({}, h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" }));
	checkTrue("disabled keeps the tool off", !h.getActive().includes("advisor"));
}

console.log("\n--- resurfacing wired into tool_call / tool_result ---");
{
	const { CLOSING_LINE } = await import("./resurface.ts");

	writeSettings({ model: "opus", resurface: { afterCalls: 2 } });
	const h = makePi();
	extension(h.pi as never);
	const ctx = h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" });
	h.events.get("session_start")!({}, ctx);

	const toolCall = (toolName: string) =>
		h.events.get("tool_call")!({ type: "tool_call", toolCallId: "t", toolName, input: {} }, ctx);
	const toolResult = (toolName: string, content: unknown[], details: unknown, isError = false) =>
		h.events.get("tool_result")!({ type: "tool_result", toolCallId: "t", toolName, input: {}, content, isError, details });

	// A read before any consult: the standing-advice machinery has nothing to
	// watch yet, so it must stay silent rather than resurface an absence.
	toolCall("read");
	check("no consult yet -> no resurface machinery fires", h.sent.length, 0);

	// A tool_result for some other tool must not be mistaken for a consult.
	const ignored = toolResult("bash", [{ type: "text", text: "ls output" }], undefined);
	check("tool_result for a different tool is left alone", ignored, undefined);

	// A successful consult: the result gets the closing line appended, and
	// mutating calls start counting from zero for THIS advice.
	const advice = "Fix the null check before touching the parser.";
	const withClosing = toolResult(
		"advisor",
		[{ type: "text", text: advice }],
		{ advisorModel: "anthropic/claude-opus-4-8", droppedMessages: 0, turns: 1 },
	) as { content: Array<{ text: string }> };
	checkTrue("a successful consult appends the closing line", withClosing.content[0]!.text.endsWith(CLOSING_LINE));
	checkTrue("...on top of the original advice", withClosing.content[0]!.text.startsWith(advice));

	// Reads don't count toward the threshold (afterCalls: 2).
	toolCall("read");
	check("a read does not move the counter -> no resurface yet", h.sent.length, 0);

	// Two mutating calls reach the threshold and fire exactly once.
	toolCall("write");
	check("one mutating call, still below threshold 2", h.sent.length, 0);
	toolCall("edit");
	check("the second mutating call fires the resurface", h.sent.length, 1);

	const first = h.sent[0]!;
	check("delivered as a hidden custom message", first.message.display, false);
	checkTrue(
		"wrapped as a system-reminder",
		first.message.content.startsWith("<system-reminder>\n") && first.message.content.endsWith("\n</system-reminder>"),
	);
	checkTrue("names the advice head", first.message.content.includes(advice));
	// tool_call always lands mid-turn (isIdle() is false by default in this
	// harness), so this is the followUp branch of the same idiom goal and
	// stalled-turn use for injecting a message into a running turn.
	check("mid-turn delivery uses the followUp idiom", first.options, { deliverAs: "followUp" });

	toolCall("bash");
	check("at most one resurface per consult -- a third mutating call does not fire again", h.sent.length, 1);

	// A new consult re-arms it, with the NEW advice head.
	h.sent.length = 0;
	const advice2 = "Now check the second edge case before shipping.";
	toolResult("advisor", [{ type: "text", text: advice2 }], { advisorModel: "anthropic/claude-opus-4-8", droppedMessages: 0, turns: 1 });
	toolCall("write");
	check("one mutating call after the new consult, still below threshold", h.sent.length, 0);
	toolCall("write");
	check("a fresh consult re-arms the resurface after its own threshold", h.sent.length, 1);
	checkTrue("...with the new advice head, not the old one", h.sent[0]!.message.content.includes(advice2));

	// A failed / unavailable consult holds no advice, so nothing is captured
	// and the result is left untouched: appending "restate the advice" to a
	// message that says there IS no advice would contradict itself.
	h.sent.length = 0;
	const failure = toolResult(
		"advisor",
		[{ type: "text", text: "Advisor unavailable: reviewer timed out. Proceeding without advice." }],
		{ advisorModel: "anthropic/claude-opus-4-8", error: "reviewer timed out" },
	);
	check("an unavailable consult's content is left untouched", failure, undefined);
	toolCall("write");
	toolCall("write");
	check("...and does not re-arm the resurface, so nothing fires for the old advice either", h.sent.length, 0);
}

console.log("\n--- spawn: a null byte must not disable the advisor ---");
{
	// Observed: "The argument 'args[12]' must be a string without null bytes."
	// args[12] is the prompt (index 11 here, shifted by one because piInvocation
	// prepends the script path). The advisor prompt embeds the session
	// transcript, so a single binary byte that ever reached a tool result — a
	// grep over a compiled file, a fetch of an image — travels into the
	// transcript and makes every later /advisor call throw before the child
	// process exists. Nothing upstream promises a transcript is clean, so the
	// guard sits at the last point before the OS.
	const args = buildArgs({ prompt: "review\0 this", model: "anthropic/claude-opus-5\0" } as never);
	check("the prompt survives without its nulls", args.at(-1), "review this");
	check("no argument carries a null", args.some((a: string) => a.includes("\0")), false);
	check("clean text is untouched", scrubArg("nothing to strip"), "nothing to strip");
	// The prompt is the last argv slot, which is what makes it args[12].
	check("the prompt is still last", args.at(-1), "review this");

	// --thinking is passed unconditionally. Omitting it does not mean "the
	// model's default": the child reads settings.json and inherits
	// defaultThinkingLevel, so raising that for the session being reviewed
	// silently raised every consult with it.
	check("the reasoning level is stated, not inherited", args[args.indexOf("--thinking") + 1], CONFIG.reviewerThinking);
	check("and an explicit level overrides it", buildArgs({ prompt: "p", model: "m", thinking: "high" } as never).includes("high"), true);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
