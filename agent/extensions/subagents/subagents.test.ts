/**
 * Tests for the subagents extension: parsing/validation, the file-first store
 * (agent/subagents.json) and its precedence over the settings.json fallback,
 * effective model/reasoning (including the carried `:level` precedence), the
 * panel, model resolution, the dispatch tool's pre-spawn branches, the
 * interactive wizard (driven by a scripted fake ui), and the /subagents
 * add|edit|remove flows against a fake pi.
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
const { resolveModelReference, modelRef, resolveSuffixedReference, splitThinking } = await import("./models.ts");
const { buildTaskDescription, registerTaskTool, rolePrompt, toPiUsage } = await import("./tool.ts");
const { buildArgs } = await import("./spawn.ts");
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
	{ id: "claude-opus-4-8", name: "Opus 4.8", provider: "anthropic" },
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

console.log("\n--- registry: a carried :level sits between the pin and the default ---");
{
	// The third argument is the level a model reference resolved with. The pin
	// names this exact subagent, so it must win; the blanket default must not
	// silently eat the model-specific level, or the suffix no-ops for anyone
	// with defaults.reasoning set.
	const bare = { name: "x", purpose: "y" };
	check("a per-agent pin beats a carried level", effective({ ...bare, reasoning: "low" }, { reasoning: "medium" }, "high").reasoning, "low");
	check("a carried level beats the blanket default", effective(bare, { reasoning: "medium" }, "high").reasoning, "high");
	check("no carried level falls back to the default", effective(bare, { reasoning: "medium" }, undefined).reasoning, "medium");
	check("a carried level alone stands", effective(bare, {}, "xhigh").reasoning, "xhigh");
}

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

console.log("\n--- model resolution: a role value's :level suffix ---");
{
	// Ids with colons are real (OpenRouter ships :free) — including one that
	// ends in a level name, the case the full-first order exists for.
	const COLONED = [
		...MODELS,
		{ id: "deepseek-chat:free", name: "DeepSeek (free)", provider: "openrouter" },
		{ id: "prompt-machine:high", name: "Prompt Machine", provider: "weird" },
	];
	const rids = (ref: string) => {
		const r = resolveSuffixedReference(ref, COLONED);
		return r.ok ? modelRef(r.model) : "ERR";
	};
	check("a suffixed reference resolves to the bare model", rids("openai-codex/gpt-5.6-luna:high"), "openai-codex/gpt-5.6-luna");
	check("suffixed and bare agree", rids("openai-codex/gpt-5.6-luna:high"), rids("openai-codex/gpt-5.6-luna"));
	check("an unknown suffix is part of the id", rids("openrouter/deepseek-chat:free"), "openrouter/deepseek-chat:free");
	check("an id ending in a level name is matched whole, not split", rids("weird/prompt-machine:high"), "weird/prompt-machine:high");
	check("a level on a colon id splits only the level", rids("openrouter/deepseek-chat:free:max"), "openrouter/deepseek-chat:free");
	check("a level does not rescue an unknown model", rids("nope:high"), "ERR");

	// The carried level exists ONLY when resolution used the split path — a
	// full match means the colon was part of the model id, however
	// level-shaped its tail looks.
	const thinkingOf = (ref: string) => {
		const r = resolveSuffixedReference(ref, COLONED);
		return r.ok ? r.thinking : "ERR";
	};
	check("the split path carries its level", thinkingOf("openai-codex/gpt-5.6-luna:high"), "high");
	check("a whole-matched level-shaped tail carries none", thinkingOf("weird/prompt-machine:high"), undefined);
	check("a level split off a colon id is carried", thinkingOf("openrouter/deepseek-chat:free:max"), "max");
	check("a plain reference carries none", thinkingOf("sol"), undefined);
	check("a non-level suffix carries none", thinkingOf("openrouter/deepseek-chat:free"), undefined);

	// An ambiguous full reference FOUND models, so it must keep its ambiguity
	// error rather than split: here the bare retry would slip past the two
	// dated matches and quietly resolve to the alias the full reference never
	// named. Every extension resolving suffixed references pins this rule.
	const AMBIGUOUS = [
		{ id: "m:high-20250101", name: "M One", provider: "p" },
		{ id: "m:high-20250202", name: "M Two", provider: "p" },
		{ id: "m", name: "M", provider: "p" },
	];
	const amb = resolveSuffixedReference("m:high", AMBIGUOUS);
	check("an ambiguous suffixed reference stays an error", amb.ok, false);

	check("splitThinking splits a trailing level", splitThinking("a/b:high"), { reference: "a/b", thinking: "high" });
	check("splitThinking keeps a non-level suffix in the id", splitThinking("openrouter/deepseek-chat:free"), { reference: "openrouter/deepseek-chat:free" });
	check("splitThinking passes a plain reference through", splitThinking("a/b"), { reference: "a/b" });
}

// ------------------------------------------------------------- tool description

console.log("\n--- the task tool description + usage mapping ---");
const desc = buildTaskDescription(parsed.settings);
checkTrue("lists each subagent and purpose", desc.includes("code-explorer: Read-only codebase discovery") && desc.includes("subagent_type"));
check("SpawnUsage -> pi Usage", toPiUsage({ input: 5, output: 7, cacheRead: 1, cacheWrite: 2, cost: 0.25, totalTokens: 12, turns: 3 }), {
	input: 5, output: 7, cacheRead: 1, cacheWrite: 2, totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
});

// ------------------------------------------------------- the role preamble

console.log("\n--- the spawn preamble ---");
{
	// A subagent runs with --no-extensions, so tool-batching cannot reach it and
	// this string is the only channel. The text is duplicated from
	// tool-batching/guideline.ts on purpose (no cross-extension imports here),
	// which is exactly the kind of copy that drifts — hence an assertion.
	const generated = rolePrompt({ name: "explorer", purpose: "look around" });
	checkTrue("the generated role still describes the role", generated.includes('the "explorer" subagent'));
	checkTrue("and carries the batching rule", generated.includes("independent tool calls in the same message"));

	// A configured prompt says what the agent is FOR, not how the tool loop
	// works, so the rule is appended to it rather than replaced by it.
	const custom = rolePrompt({ name: "x", purpose: "y", prompt: "You are a specialist." });
	checkTrue("a custom prompt is preserved", custom.startsWith("You are a specialist."));
	checkTrue("and still gets the batching rule", custom.includes("independent tool calls in the same message"));
}

// --------------------------------------------- task tool pre-spawn branches

console.log("\n--- the task tool's pre-spawn branches (no subprocess) ---");
{
	let toolDef: any;
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, {
		settings: () => ({ defaults: {}, agents: [{ name: "explorer", purpose: "look", model: "luna", tools: ["read"] }, { name: "ghost", purpose: "x", model: "does-not-exist" }, { name: "suffixed", purpose: "x", model: "openai-codex/gpt-5.6-luna:high" }] }) as never,
	});
	const ctx = { cwd: ROOT, model: { id: "gpt-5.6-luna", provider: "openai-codex" }, modelRegistry: { getAll: () => MODELS }, isProjectTrusted: () => false };
	const throws = async (params: any) => {
		try { await toolDef.execute("id", params, undefined, undefined, ctx); return ""; } catch (e) { return (e as Error).message; }
	};
	checkTrue("unknown subagent lists valid options", (await throws({ subagent_type: "nobody", prompt: "hi" })).includes("Valid options"));
	checkTrue("empty prompt is rejected", (await throws({ subagent_type: "explorer", prompt: " " })).includes("needs a prompt"));
	checkTrue("unresolvable model is rejected", (await throws({ subagent_type: "ghost", prompt: "go" })).includes("could not be used"));

	// A pre-aborted signal stops runSubagent before any subprocess, but after
	// the model was resolved and reported — so this pins that a carried
	// `:level` never reaches the --model pi would be spawned with, while it
	// DOES arrive as the reasoning the spawn runs at (details.reasoning is the
	// same value tool.ts forwards as the spawn's thinking).
	const updates: any[] = [];
	let abortMessage = "";
	try {
		await toolDef.execute("id", { subagent_type: "suffixed", prompt: "go" }, AbortSignal.abort(), (u: any) => updates.push(u), ctx);
	} catch (e) {
		abortMessage = (e as Error).message;
	}
	checkTrue("the aborted spawn failed instead of running", abortMessage.includes("aborted"));
	check("the forwarded model is the bare reference", updates[0]?.details?.model, "openai-codex/gpt-5.6-luna");
	check("the carried level is the spawn's reasoning", updates[0]?.details?.reasoning, "high");
}

// ------------------------------------- the carried :level precedence, end to end

console.log("\n--- the task tool: carried :level precedence (no subprocess) ---");
{
	// The registry carries an id whose tail LOOKS like a level, to pin that a
	// whole match never manufactures one; the role in settings.json carries a
	// real level, so the suffix arrives the way a provider profile ships it.
	const REGISTRY = [...MODELS, { id: "prompt-machine:high", name: "Prompt Machine", provider: "weird" }];
	writeFileSync(
		join(AGENT, "settings.json"),
		JSON.stringify({ models: { active: "test", providers: { test: { boosted: "openai-codex/gpt-5.6-sol:max" } } } }),
	);

	let toolDef: any;
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, {
		settings: () => ({
			defaults: { reasoning: "medium" },
			agents: [
				{ name: "pinned", purpose: "x", model: "openai-codex/gpt-5.6-luna:high", reasoning: "low" },
				{ name: "role-carried", purpose: "x", model: "boosted" },
				{ name: "whole-match", purpose: "x", model: "weird/prompt-machine:high" },
				{ name: "plain", purpose: "x", model: "openai-codex/gpt-5.6-luna" },
			],
		}) as never,
	});
	const ctx = { cwd: ROOT, modelRegistry: { getAll: () => REGISTRY }, isProjectTrusted: () => false };
	const spawnDetails = async (agentName: string) => {
		const updates: any[] = [];
		try {
			await toolDef.execute("id", { subagent_type: agentName, prompt: "go" }, AbortSignal.abort(), (u: any) => updates.push(u), ctx);
		} catch {
			/* the pre-aborted signal is the point — no subprocess runs */
		}
		return updates[0]?.details ?? {};
	};

	check("a per-agent pin beats the carried level", (await spawnDetails("pinned")).reasoning, "low");
	const carried = await spawnDetails("role-carried");
	check("a role-carried level beats the blanket default", carried.reasoning, "max");
	check("and the role's model spawns bare", carried.model, "openai-codex/gpt-5.6-sol");
	const whole = await spawnDetails("whole-match");
	check("a whole-matched level-shaped tail yields no level", whole.reasoning, "medium");
	check("with the colon kept in the model id", whole.model, "weird/prompt-machine:high");
	check("no suffix anywhere falls back to the default", (await spawnDetails("plain")).reasoning, "medium");

	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
}

console.log("\n--- spawn args: the reasoning becomes --thinking ---");
{
	// buildArgs is the last hop before the subprocess; details.reasoning above
	// is exactly what tool.ts hands it as `thinking`.
	const args = buildArgs({ prompt: "go", cwd: ROOT, model: "openai-codex/gpt-5.6-sol", thinking: "max", approved: false });
	check("--thinking carries the level", args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "max"]);
	checkTrue("no level, no flag", !buildArgs({ prompt: "go", cwd: ROOT, approved: false }).includes("--thinking"));
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
		events: { emit: () => {} },
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

console.log("\n--- wiring: the panel shows what a spawn would use ---");
{
	// A suffixed model with no per-agent pin and a blanket default: the
	// Reasoning column must show the carried level, and the Model column the
	// bare id — a suffix leaking into either would misreport the spawn.
	rmStore();
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
	saveSubagents(AGENT, {
		defaults: { reasoning: "medium" },
		agents: [{ name: "veiled", purpose: "suffix carrier", model: "openai-codex/gpt-5.6-luna:high" }],
	});
	const h = makePi();
	extension(h.pi as never);
	const notices: Array<[string, string]> = [];
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		modelRegistry: { getAll: () => MODELS },
		ui: { notify: (m: string, l: string) => notices.push([l, m]), setStatus: () => {} },
	};
	await h.commands.get("subagents").handler("list", ctx);
	const table = notices.find(([, m]) => m.includes("Subagent"))?.[1] ?? "";
	checkTrue("the model cell is the bare id", table.includes("gpt-5.6-luna") && !table.includes(":high"));
	checkTrue("the reasoning cell is the carried level, not the default", table.includes("High") && !table.includes("Medium"));
	rmStore();
}

// ------------------------------------------------- drafting from a sentence

console.log("\n--- parseDraft: the catalogue is the law ---");
{
	const { parseDraft, buildCatalog, profileRoles } = await import("./draft.ts");
	const catalog = buildCatalog(AGENT, MODELS, ["reviewer"]);
	const draft = (body: string) => parseDraft(body, catalog, MODELS, AGENT);
	const json = (over: Record<string, unknown> = {}) =>
		JSON.stringify({ name: "migrator", purpose: "Runs schema migrations", model: null, reasoning: null, tools: null, prompt: null, ...over });

	checkTrue("a bare object parses", draft(json()).ok);
	checkTrue("a fenced object parses", draft("```json\n" + json() + "\n```").ok);
	checkTrue("prose around the object is tolerated", draft("Sure!\n" + json() + "\nHope that helps.").ok);
	check("no JSON at all fails", draft("I could not do that").ok, false);
	check("broken JSON fails", draft("{ name: }").ok, false);

	check("a missing name fails", draft(json({ name: null })).ok, false);
	check("a name that is not kebab-case fails", draft(json({ name: "Migrator Two" })).ok, false);
	check("a taken name fails", draft(json({ name: "reviewer" })).ok, false);
	check("a missing purpose fails", draft(json({ purpose: null })).ok, false);

	{
		const out = draft(json({ model: "not-a-real-model" })) as any;
		checkTrue("an unknown model does not fail the draft", out.ok);
		check("but it is dropped", out.def.model, undefined);
		checkTrue("and said out loud", out.notes.some((n: string) => n.includes("not-a-real-model")));
	}
	{
		const out = draft(json({ model: "gpt-5.6-sol" })) as any;
		check("a model that resolves is kept", out.def.model, "gpt-5.6-sol");
	}
	{
		const out = draft(json({ reasoning: "extreme" })) as any;
		check("a bogus thinking level is dropped", out.def.reasoning, undefined);
		checkTrue("with a note", out.notes.some((n: string) => n.includes("extreme")));
		check("a real one is kept", (draft(json({ reasoning: "high" })) as any).def.reasoning, "high");
	}
	{
		const out = draft(json({ tools: ["read", "grep", "browser", "workflow"] })) as any;
		check("unknown tools are dropped", out.def.tools, ["read", "grep"]);
		checkTrue("and named", out.notes.some((n: string) => n.includes("browser") && n.includes("workflow")));
	}
	{
		// Leaving tools undefined would mean ALL tools to spawn.ts, so a draft
		// that asked for a restricted set and named only unknown ones must not
		// quietly become the unrestricted one.
		const out = draft(json({ tools: ["workflow", "browser"] })) as any;
		check("an all-unknown allowlist fails the draft", out.ok, false);
		checkTrue("and names both what it asked for and what exists", out.error.includes("workflow") && out.error.includes("read"));
		check("while naming no tools at all still means all of them", (draft(json({ tools: null })) as any).def.tools, undefined);
	}
	{
		const out = draft(json({ prompt: "  Review only. Never edit.  " })) as any;
		check("a role prompt is trimmed and kept", out.def.prompt, "Review only. Never edit.");
	}

	// Roles come from the active profile and beat literal ids, so they resolve
	// even though they are not model names.
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ models: { active: "p", providers: { p: { fast: "openai-codex/gpt-5.6-luna", frontier: "openai-codex/gpt-5.6-sol" } } } }));
	check("profile roles are listed", profileRoles(AGENT), ["fast", "frontier"]);
	{
		const withRoles = buildCatalog(AGENT, MODELS, []);
		checkTrue("the catalogue offers them", withRoles.roles.includes("frontier"));
		const out = parseDraft(json({ model: "frontier" }), withRoles, MODELS, AGENT) as any;
		check("and a role name survives validation", out.def.model, "frontier");
	}
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
}

console.log("\n--- wiring: /subagents add <description> ---");
{
	rmStore();
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
	const h = makePi();
	extension(h.pi as never);

	const notices: Array<[string, string]> = [];
	let wizardRan = false;
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		// No model anywhere, so the draft fails at the first seam rather than
		// reaching a real provider from a test.
		model: undefined,
		modelRegistry: { getAll: () => [] },
		ui: {
			input: async () => {
				wizardRan = true;
				return undefined;
			},
			select: async () => undefined,
			confirm: async () => false,
			editor: async () => undefined,
			notify: (m: string, l: string) => notices.push([l, m]),
			setStatus: () => {},
		},
	};
	h.commands.get("on:session_start")!({}, ctx);

	await h.commands.get("subagents")!.handler("add a read-only reviewer on the frontier model", ctx);
	checkTrue("the draft is announced before the wait", notices.some(([, m]) => m.includes("Drafting")));
	checkTrue("a failed draft says why", notices.some(([l, m]) => l === "warning" && m.includes("Could not draft")));
	checkTrue("and does not silently fall into the wizard", !wizardRan);
	check("nothing was stored", existsSync(storePath(AGENT)), false);

	// No description is still the wizard.
	await h.commands.get("subagents")!.handler("add", ctx);
	checkTrue("a bare add runs the wizard", wizardRan);
	rmStore();
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
