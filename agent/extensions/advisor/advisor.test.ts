/**
 * Tests for the advisor extension: the branch→transcript flattening, the
 * reviewer prompt assembly, model resolution and the Claude Code validation
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
checkTrue("the main-agent guidance is Claude Code's, verbatim", ADVISOR_TOOL_GUIDANCE.includes("backed by a stronger reviewer model") && ADVISOR_TOOL_GUIDANCE.includes("Orientation is not substantive work"));

// -------------------------------------------------------------------- models

console.log("\n--- model resolution ---");
const MODELS = [
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", contextWindow: 1_000_000 },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", contextWindow: 1_000_000 },
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

console.log("\n--- Claude Code's Czg rule: advisor cannot be the model it advises ---");
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
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ advisor: block }));

writeSettings({});
check("defaults: no model, enabled", loadSettings(AGENT), { model: undefined, enabled: true });
writeSettings({ model: "opus", enabled: false });
check("model and kill switch parsed", loadSettings(AGENT), { model: "opus", enabled: false });
writeSettings({ model: "   " });
check("blank model is treated as unset", loadSettings(AGENT).model, undefined);
writeSettings({ enabled: "yes" });
check("wrong-typed enabled falls back to true", loadSettings(AGENT).enabled, true);
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unreadable settings fall back", loadSettings(AGENT), { model: undefined, enabled: true });

// -------------------------------------------------- registerAdvisorTool branches

console.log("\n--- the tool's pre-spawn branches (no subprocess) ---");
{
	const { registerAdvisorTool } = await import("./tool.ts");
	let toolDef: any;
	const pi = { registerTool: (def: any) => (toolDef = def) };
	let reference: string | undefined;
	registerAdvisorTool(pi as never, { reference: () => reference });
	check("registered under the Claude Code name", toolDef.name, "advisor");
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

	// Same model as the session model -> graceful note, no spawn.
	reference = "opus"; // resolves to anthropic/claude-opus-4-8, which ctx.model is
	const result = await toolDef.execute("id", {}, undefined, undefined, ctx);
	check("same-model is a skip, not an error", result.details?.skipped, "same-model");
	checkTrue("same-model note explains why", result.content[0].text.includes("cannot advise itself"));
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
	};
	const uiCtx = (model: { id: string; provider: string }) => ({
		hasUI: true,
		cwd: ROOT,
		model,
		modelRegistry: { getAll: () => MODELS },
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			notify: (message: string, level: string) => notices.push([level, message]),
		},
	});
	return { pi, tools, flags, commands, events, getActive: () => active, statuses, notices, uiCtx };
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

	// Setting the current session model warns (Czg).
	await advisor.handler("sonnet", ctx); // ctx.model is claude-sonnet-5
	checkTrue("setting the current model warns", h.notices.some(([lvl, m]) => lvl === "warn" && m.includes("switch the main model")));
}

// Kill switch: enabled=false keeps the tool off even with a model set.
{
	writeSettings({ model: "opus", enabled: false });
	const h = makePi();
	extension(h.pi as never);
	h.events.get("session_start")!({}, h.uiCtx({ id: "claude-sonnet-5", provider: "anthropic" }));
	checkTrue("disabled keeps the tool off", !h.getActive().includes("advisor"));
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
