/**
 * Tests for the subagents extension: parsing/validation, the file-first store
 * (agent/subagents.json) and its precedence over the settings.json fallback,
 * effective model/reasoning, the panel, model resolution, the dispatch tool's
 * pre-spawn branches, the interactive wizard (driven by a scripted fake ui),
 * and the /subagents add|edit|remove flows against a fake pi.
 *
 * The happy path — an actual subagent spawn — needs the network and lives in
 * subagents.live.ts, excluded from this suite.
 *
 * Run: jiti agent/extensions/subagents/subagents.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { parseSubagents, effective, loadSubagents, saveSubagents, storePath } = await import("./registry.ts");
const { formatReasoning, tableLines } = await import("./panel.ts");
const { resolveModelReference, modelRef } = await import("./models.ts");
const { buildTaskDescription, registerTaskTool, toPiUsage } = await import("./tool.ts");
const { runWizard, pickName } = await import("./manage.ts");

const STORE = storePath(AGENT);
const rmStore = () => rmSync(STORE, { force: true });
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ subagents: block }));

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

const MODELS = [
	{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai-codex" },
	{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai-codex" },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
];

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

console.log("\n--- registry: effective model/reasoning applies defaults ---");
const D = parsed.settings.defaults;
check("agent inherits default model, keeps own reasoning", effective(parsed.settings.agents[0], D), { model: "gpt-5.6-luna", reasoning: "high" });
check("agent overrides model and reasoning", effective(parsed.settings.agents[1], D), { model: "gpt-5.6-sol", reasoning: "low" });
check("dropped reasoning falls back to default", effective(parsed.settings.agents[2], D), { model: "gpt-5.6-luna", reasoning: "high" });

// ------------------------------------------------------------ store & precedence

console.log("\n--- store: agent/subagents.json round-trip and precedence ---");
rmStore();
writeSettings({ agents: [{ name: "from-settings", purpose: "the fallback" }] });
check("with no store, the settings.json block is the source", loadSubagents(AGENT).source, "settings");
check("fallback content is read", loadSubagents(AGENT).settings.agents.map((a) => a.name), ["from-settings"]);

saveSubagents(AGENT, { defaults: { model: "gpt-5.6-luna" }, agents: [{ name: "from-store", purpose: "the real one", tools: ["read"] }] });
checkTrue("the store file was written", existsSync(STORE));
const afterSave = loadSubagents(AGENT);
check("the store now wins over settings.json", afterSave.source, "store");
check("store content is read", afterSave.settings.agents.map((a) => a.name), ["from-store"]);
check("store round-trips optional fields", afterSave.settings.agents[0].tools, ["read"]);
checkTrue("store file is pretty-printed", readFileSync(STORE, "utf8").includes("\n  "));

console.log("\n--- store: sources and a malformed file ---");
rmStore();
writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
check("no block anywhere -> source none", loadSubagents(AGENT).source, "none");
writeFileSync(STORE, "{ not json");
const broken = loadSubagents(AGENT);
check("a malformed store is reported, not bypassed", broken.source, "store");
checkTrue("malformed store yields an issue", broken.issues.some((i) => i.includes("not valid JSON")));
rmStore();

// ----------------------------------------------------------------- panel

console.log("\n--- panel: the table ---");
check("reasoning is title-cased", [formatReasoning("high"), formatReasoning("low"), formatReasoning(undefined)], ["High", "Low", "—"]);
const table = tableLines([
	{ name: "code-explorer", model: "gpt-5.6-luna", reasoning: "High", purpose: "Read-only codebase discovery and investigation" },
	{ name: "code-reviewer", model: "gpt-5.6-sol", reasoning: "Low", purpose: "Review diffs for correctness, security, and quality" },
]);
checkTrue("header has all four columns", ["Subagent", "Model", "Reasoning", "Purpose"].every((h) => table[0].includes(h)));
checkTrue("a rule separates the header", /^─+$/.test(table[1]));
checkTrue("columns are aligned", table[2].startsWith("code-explorer") && table[3].startsWith("code-reviewer"));
checkTrue("empty config says so", tableLines([])[0].includes("No subagents configured"));
checkTrue("a long purpose is clipped", tableLines([{ name: "x", model: "m", reasoning: "High", purpose: "y".repeat(200) }], 40)[2].includes("…"));

// ----------------------------------------------------------------- models

console.log("\n--- model resolution ---");
const rid = (ref: string) => {
	const r = resolveModelReference(ref, MODELS);
	return r.ok ? modelRef(r.model) : "ERR";
};
check("bare id -> canonical", rid("gpt-5.6-luna"), "openai-codex/gpt-5.6-luna");
check("partial name", rid("sol"), "openai-codex/gpt-5.6-sol");
check("unknown is an error", rid("nope"), "ERR");

// ------------------------------------------------------------- tool description

console.log("\n--- the task tool description + usage mapping ---");
const desc = buildTaskDescription(parsed.settings);
checkTrue("lists each subagent and purpose", desc.includes("code-explorer: Read-only codebase discovery") && desc.includes("subagent_type"));
check("SpawnUsage -> pi Usage", toPiUsage({ input: 5, output: 7, cacheRead: 1, cacheWrite: 2, cost: 0.25, totalTokens: 12, turns: 3 }), {
	input: 5, output: 7, cacheRead: 1, cacheWrite: 2, totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
});

// --------------------------------------------- task tool pre-spawn branches

console.log("\n--- the task tool's pre-spawn branches (no subprocess) ---");
{
	let toolDef: any;
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, {
		settings: () => ({ defaults: {}, agents: [{ name: "explorer", purpose: "look", model: "luna", tools: ["read"] }, { name: "ghost", purpose: "x", model: "does-not-exist" }] }) as never,
	});
	const ctx = { cwd: ROOT, model: { id: "gpt-5.6-luna", provider: "openai-codex" }, modelRegistry: { getAll: () => MODELS }, isProjectTrusted: () => false };
	const throws = async (params: any) => {
		try { await toolDef.execute("id", params, undefined, undefined, ctx); return ""; } catch (e) { return (e as Error).message; }
	};
	checkTrue("unknown subagent lists valid options", (await throws({ subagent_type: "nobody", prompt: "hi" })).includes("Valid options"));
	checkTrue("empty prompt is rejected", (await throws({ subagent_type: "explorer", prompt: " " })).includes("needs a prompt"));
	checkTrue("unresolvable model is rejected", (await throws({ subagent_type: "ghost", prompt: "go" })).includes("could not be used"));
}

// --------------------------------------------------- the interactive wizard

console.log("\n--- manage: the wizard (scripted ui) ---");
function scriptedCtx(script: { input?: (string | undefined)[]; select?: (string | undefined)[]; confirm?: boolean[]; editor?: (string | undefined)[] }) {
	const q = {
		input: [...(script.input ?? [])],
		select: [...(script.select ?? [])],
		confirm: [...(script.confirm ?? [])],
		editor: [...(script.editor ?? [])],
	};
	const notices: Array<[string, string]> = [];
	const ctx = {
		hasUI: true,
		modelRegistry: { getAll: () => MODELS },
		ui: {
			input: async (_l: string, _p?: string) => q.input.shift(),
			select: async (_l: string, _o: string[]) => q.select.shift(),
			confirm: async (_t: string, _m: string) => q.confirm.shift() ?? false,
			editor: async (_l: string, _p?: string) => q.editor.shift(),
			notify: (m: string, l: string) => notices.push([l, m]),
		},
	};
	return { ctx, notices };
}

{
	// A full add.
	const { ctx } = scriptedCtx({
		input: ["code-explorer", "Read-only discovery"],
		select: ["openai-codex/gpt-5.6-luna", "high", "Read-only (read, grep, find, ls)"],
		confirm: [false /* add prompt? */, true /* save? */],
	});
	const def = await runWizard(ctx as never, undefined, new Set());
	check("wizard builds the subagent", def, {
		name: "code-explorer",
		purpose: "Read-only discovery",
		model: "openai-codex/gpt-5.6-luna",
		reasoning: "high",
		tools: ["read", "grep", "find", "ls"],
		prompt: undefined,
	});
}
{
	// Cancel at the name.
	const { ctx } = scriptedCtx({ input: [undefined] });
	check("empty name cancels", await runWizard(ctx as never, undefined, new Set()), undefined);
}
{
	// Duplicate name is refused.
	const { ctx, notices } = scriptedCtx({ input: ["dupe"] });
	check("duplicate name refused", await runWizard(ctx as never, undefined, new Set(["dupe"])), undefined);
	checkTrue("and explained", notices.some(([lvl, m]) => lvl === "error" && m.includes("already exists")));
}
{
	// Cancel at the model select (after name + purpose).
	const { ctx } = scriptedCtx({ input: ["x", "p"], select: [undefined] });
	check("cancel at model aborts", await runWizard(ctx as never, undefined, new Set()), undefined);
}
{
	// Edit: empty purpose keeps the old one; "All tools" clears the allowlist; prompt kept.
	const existing = { name: "reviewer", purpose: "old purpose", model: "m", reasoning: "low", tools: ["read"], prompt: "keep me" };
	const { ctx } = scriptedCtx({
		input: [""], // purpose empty -> keep
		select: ["(session default)", "(inherit)", "All tools"],
		confirm: [false /* keep prompt */, true /* save */],
	});
	check("edit preserves name, keeps blank purpose, clears model/reasoning/tools, keeps prompt", await runWizard(ctx as never, existing, new Set()), {
		name: "reviewer",
		purpose: "old purpose",
		model: undefined,
		reasoning: undefined,
		tools: undefined,
		prompt: "keep me",
	});
}
{
	// Custom tools path.
	const { ctx } = scriptedCtx({
		input: ["custom-agent", "does things", "read, bash , edit"],
		select: ["(session default)", "medium", "Custom…"],
		confirm: [false, true],
	});
	const def = await runWizard(ctx as never, undefined, new Set());
	check("custom tools are parsed", def?.tools, ["read", "bash", "edit"]);
}

console.log("\n--- manage: pickName ---");
{
	const { ctx } = scriptedCtx({ select: ["b"] });
	check("valid arg is used directly", await pickName(ctx as never, ["a", "b"], "edit", "a"), "a");
	check("no arg -> picker", await pickName(ctx as never, ["a", "b"], "edit"), "b");
	const empty = scriptedCtx({});
	check("no subagents -> undefined", await pickName(empty.ctx as never, [], "edit"), undefined);
	checkTrue("and a hint is shown", empty.notices.some(([, m]) => m.includes("No subagents")));
}

// ------------------------------------------- wiring: /subagents add & remove

console.log("\n--- wiring: interactive /subagents against a fake pi ---");
function makePi() {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	let active: string[] = ["read", "bash"];
	const pi = {
		on: (event: string, handler: Function) => commands.set(`on:${event}`, handler),
		registerTool: (def: any) => {
			const i = tools.findIndex((t) => t.name === def.name);
			if (i >= 0) tools[i] = def;
			else tools.push(def);
			if (!active.includes(def.name)) active = [...active, def.name];
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => (active = names),
	};
	return { pi, tools, commands, getActive: () => active };
}

const extension = (await import("./index.ts")).default;

{
	rmStore();
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
	const h = makePi();
	extension(h.pi as never);

	// Build a command ctx that also serves as the wizard ctx.
	const notices: Array<[string, string]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const q = {
		input: ["reviewer", "Review diffs"],
		select: ["openai-codex/gpt-5.6-sol", "low", "All tools"],
		confirm: [false /* prompt? */, true /* save? */],
	};
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		model: { id: "gpt-5.6-luna", provider: "openai-codex" },
		modelRegistry: { getAll: () => MODELS },
		ui: {
			input: async () => q.input.shift(),
			select: async () => q.select.shift(),
			confirm: async () => q.confirm.shift() ?? false,
			editor: async () => undefined,
			notify: (m: string, l: string) => notices.push([l, m]),
			setStatus: (k: string, t: string | undefined) => statuses.push([k, t]),
		},
	};

	h.commands.get("on:session_start")!({}, ctx);
	checkTrue("task tool inactive with no subagents", !h.getActive().includes("task"));

	await h.commands.get("subagents").handler("add", ctx);
	checkTrue("the store file was created", existsSync(STORE));
	check("the new subagent persisted", loadSubagents(AGENT).settings.agents.map((a) => a.name), ["reviewer"]);
	checkTrue("task tool now active", h.getActive().includes("task"));
	checkTrue("confirmation names the file and the agent", notices.some(([lvl, m]) => lvl === "info" && m.includes('Added "reviewer"') && m.includes("subagents.json")));

	// Remove it.
	const q2 = { confirm: [true] };
	const ctx2: any = { ...ctx, ui: { ...ctx.ui, confirm: async () => q2.confirm.shift() ?? false } };
	await h.commands.get("subagents").handler("remove reviewer", ctx2);
	check("subagent removed from the store", loadSubagents(AGENT).settings.agents.map((a) => a.name), []);
	checkTrue("task tool inactive again", !h.getActive().includes("task"));
	rmStore();
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
