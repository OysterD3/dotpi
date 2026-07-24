/**
 * Tests for the subagents extension: parsing and validating the definitions,
 * effective model/reasoning resolution, the panel table, model resolution, the
 * dispatch tool's description and its pre-spawn branches (unknown name, empty
 * prompt, unresolvable model — none of which touch a subprocess), and the
 * wiring against a fake pi (tool + command registration, active-tool sync, and
 * the /subagents render).
 *
 * The happy path — an actual subagent spawn — needs the network and lives in
 * subagents.live.ts, excluded from this suite.
 *
 * Run with jiti from a directory where pi's packages resolve:
 *     jiti agent/extensions/subagents/subagents.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "subagents-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { parseSubagents, effective, loadSubagents } = await import("./registry.ts");
const { formatReasoning, tableLines } = await import("./panel.ts");
const { resolveModelReference, modelRef } = await import("./models.ts");
const { buildTaskDescription, registerTaskTool, toPiUsage } = await import("./tool.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

// --------------------------------------------------------------- parsing

console.log("--- registry: parsing and validation ---");
const RAW = {
	defaults: { model: "gpt-5.6-luna", reasoning: "high" },
	agents: [
		{ name: "code-explorer", reasoning: "high", tools: ["read", "grep", "find", "ls"], purpose: "Read-only codebase discovery and investigation" },
		{ name: "code-reviewer", model: "gpt-5.6-sol", reasoning: "low", purpose: "Review diffs for correctness, security, and quality" },
		{ name: "bad-reasoning", reasoning: "banana", purpose: "kept, reasoning dropped" },
		{ name: "", purpose: "no name" },
		{ name: "no-purpose" },
		{ name: "code-explorer", purpose: "duplicate" },
		{ name: "bad-tools", tools: "read", purpose: "kept, tools dropped" },
		"not-an-object",
	],
};
const parsed = parseSubagents(RAW);
check("keeps only the valid agents", parsed.settings.agents.map((a) => a.name), ["code-explorer", "code-reviewer", "bad-reasoning", "bad-tools"]);
check("defaults parsed", parsed.settings.defaults, { model: "gpt-5.6-luna", reasoning: "high" });
check("tool allowlist parsed", parsed.settings.agents[0].tools, ["read", "grep", "find", "ls"]);
check("invalid reasoning is dropped, agent survives", parsed.settings.agents[2].reasoning, undefined);
check("invalid tools are dropped, agent survives", parsed.settings.agents[3].tools, undefined);
checkTrue("issues were recorded for every bad entry", parsed.issues.length >= 5);
check("empty raw is safe", parseSubagents(undefined).settings.agents, []);
check("non-array agents is an issue, not a crash", parseSubagents({ agents: "nope" }).settings.agents, []);

console.log("\n--- registry: effective model/reasoning applies defaults ---");
const D = parsed.settings.defaults;
check("agent inherits default model, keeps own reasoning", effective(parsed.settings.agents[0], D), { model: "gpt-5.6-luna", reasoning: "high" });
check("agent overrides model and reasoning", effective(parsed.settings.agents[1], D), { model: "gpt-5.6-sol", reasoning: "low" });
check("dropped reasoning falls back to default", effective(parsed.settings.agents[2], D), { model: "gpt-5.6-luna", reasoning: "high" });

// ----------------------------------------------------------------- panel

console.log("\n--- panel: the table ---");
check("reasoning is title-cased", [formatReasoning("high"), formatReasoning("low"), formatReasoning(undefined)], ["High", "Low", "—"]);
const rows = [
	{ name: "code-explorer", model: "gpt-5.6-luna", reasoning: "High", purpose: "Read-only codebase discovery and investigation" },
	{ name: "code-reviewer", model: "gpt-5.6-sol", reasoning: "Low", purpose: "Review diffs for correctness, security, and quality" },
];
const table = tableLines(rows);
checkTrue("header has all four columns", table[0].includes("Subagent") && table[0].includes("Model") && table[0].includes("Reasoning") && table[0].includes("Purpose"));
checkTrue("a rule separates the header", /^─+$/.test(table[1]));
checkTrue("every row is present", table.length === 4);
checkTrue("columns are aligned to a common width", table[2].startsWith("code-explorer") && table[3].startsWith("code-reviewer"));
checkTrue("empty config says so", tableLines([])[0].includes("No subagents configured"));
const longPurpose = tableLines([{ name: "x", model: "m", reasoning: "High", purpose: "y".repeat(200) }], 40);
checkTrue("a long purpose is clipped", longPurpose[2].includes("…") && longPurpose[2].length < 200);

// ----------------------------------------------------------------- models

console.log("\n--- model resolution ---");
const MODELS = [
	{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai-codex" },
	{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai-codex" },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
];
const rid = (ref: string) => {
	const r = resolveModelReference(ref, MODELS);
	return r.ok ? modelRef(r.model) : `ERR`;
};
check("bare id -> canonical", rid("gpt-5.6-luna"), "openai-codex/gpt-5.6-luna");
check("partial name", rid("sol"), "openai-codex/gpt-5.6-sol");
check("provider/id", rid("anthropic/claude-opus-4-8"), "anthropic/claude-opus-4-8");
check("unknown is an error", rid("nope"), "ERR");

// ------------------------------------------------------------- tool description

console.log("\n--- the task tool description ---");
const desc = buildTaskDescription(parsed.settings);
checkTrue("lists each subagent and purpose", desc.includes("code-explorer: Read-only codebase discovery") && desc.includes("code-reviewer: Review diffs"));
checkTrue("names subagent_type", desc.includes("subagent_type"));

console.log("\n--- usage mapping ---");
check("SpawnUsage -> pi Usage", toPiUsage({ input: 5, output: 7, cacheRead: 1, cacheWrite: 2, cost: 0.25, totalTokens: 12, turns: 3 }), {
	input: 5,
	output: 7,
	cacheRead: 1,
	cacheWrite: 2,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
});

// --------------------------------------------- task tool pre-spawn branches

console.log("\n--- the task tool's pre-spawn branches (no subprocess) ---");
{
	let toolDef: any;
	const pi = { registerTool: (def: any) => (toolDef = def) };
	const testSettings = {
		defaults: {},
		agents: [
			{ name: "explorer", purpose: "look around", model: "luna", tools: ["read"] },
			{ name: "ghost-model", purpose: "broken", model: "does-not-exist" },
		],
	};
	registerTaskTool(pi as never, { settings: () => testSettings as never });
	check("registered as task", toolDef.name, "task");

	const ctx = {
		cwd: ROOT,
		model: { id: "gpt-5.6-luna", provider: "openai-codex" },
		modelRegistry: { getAll: () => MODELS },
		isProjectTrusted: () => false,
	};

	let threw = "";
	try {
		await toolDef.execute("id", { subagent_type: "nobody", prompt: "hi" }, undefined, undefined, ctx);
	} catch (e) {
		threw = (e as Error).message;
	}
	checkTrue("unknown subagent lists valid options", threw.includes("Valid options") && threw.includes("explorer"));

	threw = "";
	try {
		await toolDef.execute("id", { subagent_type: "explorer", prompt: "   " }, undefined, undefined, ctx);
	} catch (e) {
		threw = (e as Error).message;
	}
	checkTrue("empty prompt is rejected", threw.includes("needs a prompt"));

	threw = "";
	try {
		await toolDef.execute("id", { subagent_type: "ghost-model", prompt: "do it" }, undefined, undefined, ctx);
	} catch (e) {
		threw = (e as Error).message;
	}
	checkTrue("unresolvable model is rejected", threw.includes("could not be used"));
}

// ------------------------------------------------------ wiring against a fake pi

console.log("\n--- wiring against a fake pi ---");
function makePi() {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	let active: string[] = ["read", "bash"];
	const statuses: Array<[string, string | undefined]> = [];
	const notices: Array<[string, string]> = [];
	const events = new Map<string, Function>();
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		registerTool: (def: any) => {
			tools.push(def);
			if (!active.includes(def.name)) active = [...active, def.name];
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => (active = names),
	};
	const uiCtx = () => ({
		hasUI: true,
		cwd: ROOT,
		model: { id: "gpt-5.6-luna", provider: "openai-codex" },
		modelRegistry: { getAll: () => MODELS },
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			notify: (message: string, level: string) => notices.push([level, message]),
		},
	});
	return { pi, tools, commands, events, getActive: () => active, statuses, notices, uiCtx };
}

const extension = (await import("./index.ts")).default;
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ subagents: block }));

// Configured -> task tool active + count chip.
{
	writeSettings({
		defaults: { model: "gpt-5.6-luna", reasoning: "high" },
		agents: [
			{ name: "code-explorer", reasoning: "high", tools: ["read", "grep"], purpose: "Read-only codebase discovery and investigation" },
			{ name: "code-reviewer", model: "gpt-5.6-sol", reasoning: "low", purpose: "Review diffs for correctness, security, and quality" },
		],
	});
	const h = makePi();
	extension(h.pi as never);
	check("registers the task tool", h.tools[0]?.name, "task");
	checkTrue("registers /subagents", h.commands.has("subagents"));

	h.events.get("session_start")!({}, h.uiCtx());
	checkTrue("task tool active when configured", h.getActive().includes("task"));
	check("status chip shows the count", h.statuses.at(-1), ["subagents", "✦ subagents: 2"]);

	// /subagents renders the table.
	const ctx = h.uiCtx();
	await h.commands.get("subagents").handler("", ctx);
	const printed = h.notices.at(-1)![1];
	checkTrue("table names the subagents", printed.includes("code-explorer") && printed.includes("code-reviewer"));
	checkTrue("table shows resolved models", printed.includes("gpt-5.6-luna") && printed.includes("gpt-5.6-sol"));
	checkTrue("table shows reasoning", printed.includes("High") && printed.includes("Low"));
}

// No subagents -> tool deactivated, no chip.
{
	writeSettings({ agents: [] });
	const h = makePi();
	extension(h.pi as never);
	h.events.get("session_start")!({}, h.uiCtx());
	checkTrue("task tool removed when none configured", !h.getActive().includes("task"));
	check("chip cleared", h.statuses.at(-1), ["subagents", undefined]);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
