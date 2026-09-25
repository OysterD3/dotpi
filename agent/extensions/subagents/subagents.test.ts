/**
 * Tests for the subagents extension: parsing/validation of the agent files,
 * discovery (user agents, project agents behind trust, project over user),
 * the write/read round-trip, effective model/reasoning (including the carried
 * `:level` precedence), the panel, model resolution, the dispatch tool's
 * pre-spawn branches for defined and one-time agents, the interactive wizard
 * (driven by a scripted fake ui), and the /subagents add|edit|remove flows
 * against a fake pi.
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

const { getAgentDir, ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { parseSubagentFile, serializeSubagent, effective, loadSubagents, userAgentsDir, userAgentPath, writeSubagent } = await import("./registry.ts");
const { formatReasoning, tableLines } = await import("./panel.ts");
const { resolveModelReference, modelRef, resolveSuffixedReference, splitThinking } = await import("./models.ts");
const { buildTaskDescription, registerTaskTool, rolePrompt, toPiUsage } = await import("./tool.ts");
const { buildArgs } = await import("./spawn.ts");
const { runWizard, pickName } = await import("./manage.ts");

const USER_DIR = userAgentsDir(AGENT);
const rmAgents = () => rmSync(USER_DIR, { recursive: true, force: true });
const writeAgent = (dir: string, file: string, content: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
};
const namesIn = (agents: Array<{ name: string }>) => agents.map((a) => a.name);

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

console.log("--- registry: parsing an agent file ---");
{
	// One table of real files through the one seam that reads them. A case that
	// slips through later goes in here.
	const cases: Array<[string, string, unknown, boolean]> = [
		// label, file content, the def it must yield (undefined = skipped), whether an issue is reported
		[
			"a full file",
			"---\nname: code-reviewer\ndescription: Review diffs\nmodel: frontier\nreasoning: low\ntools: read, grep, find, ls\n---\n\nReview only. Never edit.\n",
			{ name: "code-reviewer", purpose: "Review diffs", model: "frontier", reasoning: "low", tools: ["read", "grep", "find", "ls"], prompt: "Review only. Never edit." },
			false,
		],
		["a YAML list of tools", "---\nname: a\ndescription: b\ntools: [read, bash]\n---\n", { name: "a", purpose: "b", tools: ["read", "bash"] }, false],
		["no tools key means pi's default tools", "---\nname: a\ndescription: b\n---\n", { name: "a", purpose: "b" }, false],
		["a level is normalised", "---\nname: a\ndescription: b\nreasoning: High\n---\n", { name: "a", purpose: "b", reasoning: "high" }, false],
		["a bad level is dropped, the agent kept", "---\nname: a\ndescription: b\nreasoning: banana\n---\n", { name: "a", purpose: "b" }, true],
		["a quoted description with a colon", '---\nname: a\ndescription: "Review: diffs only"\n---\n', { name: "a", purpose: "Review: diffs only" }, false],
		["a leading BOM", "\uFEFF---\nname: a\ndescription: b\n---\n", { name: "a", purpose: "b" }, false],
		["missing name is skipped", "---\ndescription: b\n---\n", undefined, true],
		["missing description is skipped", "---\nname: a\n---\n", undefined, true],
		// A dropped allowlist would mean pi's default tools (bash, edit, write), so these skip the agent.
		["an empty tools list is skipped", "---\nname: a\ndescription: b\ntools: []\n---\n", undefined, true],
		["a null tools key is skipped", "---\nname: a\ndescription: b\ntools:\n---\n", undefined, true],
		["a tools map is skipped", "---\nname: a\ndescription: b\ntools: { read: true }\n---\n", undefined, true],
		["broken YAML is skipped", "---\nname: [a\ndescription: b\n---\n", undefined, true],
		["a YAML scalar frontmatter is skipped", "---\njust text\n---\n", undefined, true],
		// A README beside the agents is not an agent, and not a problem either.
		["no frontmatter is passed over silently", "# About these agents\n", undefined, false],
	];
	for (const [label, content, want, wantIssue] of cases) {
		const parsed = parseSubagentFile(content, "x.md");
		check(label, parsed.def, want);
		check(`${label}: ${wantIssue ? "an issue" : "no issue"}`, parsed.issues.length > 0, wantIssue);
	}
}

console.log("\n--- registry: write, then read back ---");
{
	// Every value the file writer can meet, including the ones plain YAML would
	// misread: a colon, a hash, quotes, a word that parses as a boolean or a
	// number, a model reference that carries a :level, and a body with a rule.
	const defs = [
		{ name: "plain", purpose: "Read-only codebase discovery and investigation", model: "fast", reasoning: "high", tools: ["read", "grep", "find", "ls"] },
		{ name: "tricky", purpose: 'Review: "diffs" only # not a comment', model: "openai-codex/gpt-5.6-sol:low", reasoning: "off", prompt: "Line one.\n\n---\n\nLine after a rule." },
		{ name: "yes", purpose: "true", model: "1.5" },
	];
	for (const def of defs) {
		check(`${def.name} round-trips`, parseSubagentFile(serializeSubagent(def), "x.md").def, def);
	}
	checkTrue("simple values stay plain", serializeSubagent(defs[0]).includes("\ntools: read, grep, find, ls\n"));
}

console.log("\n--- registry: effective model/reasoning ---");
{
	// The second argument is the level a model reference resolved with. The pin
	// names this exact subagent, so it must win.
	const bare = { name: "x", purpose: "y" };
	check("a per-agent pin beats a carried level", effective({ ...bare, reasoning: "low" }, "high").reasoning, "low");
	check("a carried level alone stands", effective(bare, "xhigh").reasoning, "xhigh");
	check("neither leaves the session's level", effective(bare).reasoning, undefined);
	check("the model is the agent's own", effective({ ...bare, model: "fast" }).model, "fast");
}

// ------------------------------------------------------- discovery & trust

console.log("\n--- registry: user and project agents ---");
{
	rmAgents();
	const REPO = join(ROOT, "repo");
	const DEEP = join(REPO, "src", "deep");
	const PROJECT_DIR = join(REPO, ".pi", "agents");
	mkdirSync(DEEP, { recursive: true });

	check("no directory at all is no agents and no issues", loadSubagents(AGENT, DEEP, true), { agents: [], user: [], issues: [] });

	writeAgent(USER_DIR, "reviewer.md", "---\nname: reviewer\ndescription: user reviewer\n---\n");
	writeAgent(USER_DIR, "explorer.md", "---\nname: explorer\ndescription: user explorer\n---\n");
	writeAgent(USER_DIR, "z-clash.md", "---\nname: explorer\ndescription: same name again\n---\n");
	writeAgent(USER_DIR, "notes.txt", "not an agent");
	writeAgent(PROJECT_DIR, "reviewer.md", "---\nname: reviewer\ndescription: project reviewer\ntools: read\n---\n");
	writeAgent(PROJECT_DIR, "migrator.md", "---\nname: migrator\ndescription: project only\n---\n");

	const untrusted = loadSubagents(AGENT, DEEP, false);
	check("untrusted: only user agents run", namesIn(untrusted.agents), ["explorer", "reviewer"]);
	check("untrusted: the user reviewer is the one", untrusted.agents.find((a) => a.name === "reviewer")?.purpose, "user reviewer");
	checkTrue("untrusted: the skipped project dir is said out loud", untrusted.issues.some((i) => i.includes(PROJECT_DIR) && i.includes("not trusted")));
	check("a later duplicate name is skipped", untrusted.agents.find((a) => a.name === "explorer")?.purpose, "user explorer");
	checkTrue("and reported", untrusted.issues.some((i) => i.includes("z-clash.md") && i.includes("duplicate")));
	check("the project dir is found from a subdirectory", untrusted.projectDir, PROJECT_DIR);

	// pi calls a session trusted without asking when .pi/ holds only agents/,
	// and it looks at the cwd only. So a trusted session proves nothing here:
	// the folder that holds .pi/agents needs a decision the user saved.
	const store = new ProjectTrustStore(AGENT);
	const unsaved = loadSubagents(AGENT, DEEP, true);
	check("a trusted session with nothing saved keeps project agents out", namesIn(unsaved.agents), ["explorer", "reviewer"]);
	checkTrue("and says to run /trust for the repo", unsaved.issues.some((i) => i.includes("/trust") && i.includes(REPO)));
	store.set(DEEP, true);
	check("trust saved for a subfolder does not reach the repo above it", namesIn(loadSubagents(AGENT, DEEP, true).agents), ["explorer", "reviewer"]);
	store.set(DEEP, null);
	store.set(REPO, false);
	checkTrue("a saved 'not trusted' keeps them out", loadSubagents(AGENT, DEEP, true).issues.some((i) => i.includes("saved as not trusted")));
	store.set(REPO, null);
	store.set(ROOT, true);
	check("trust saved for a parent folder covers the repo", namesIn(loadSubagents(AGENT, DEEP, true).agents).sort(), ["explorer", "migrator", "reviewer"]);
	store.set(ROOT, null);
	store.set(REPO, true);
	check("a saved decision does not outrank an untrusted session", namesIn(loadSubagents(AGENT, DEEP, false).agents), ["explorer", "reviewer"]);

	const trusted = loadSubagents(AGENT, DEEP, true);
	check("trusted: project agents join", namesIn(trusted.agents).sort(), ["explorer", "migrator", "reviewer"]);
	const reviewer = trusted.agents.find((a) => a.name === "reviewer");
	check("trusted: a project agent replaces the user one of the same name", [reviewer?.purpose, reviewer?.source, reviewer?.tools], ["project reviewer", "project", ["read"]]);
	check("the user list still holds the shadowed agent", trusted.user.find((a) => a.name === "reviewer")?.purpose, "user reviewer");
	check("each agent knows its file", trusted.agents.find((a) => a.name === "migrator")?.filePath, join(PROJECT_DIR, "migrator.md"));
	checkTrue("trusted: no trust issue", !trusted.issues.some((i) => i.includes("not trusted")));

	check("outside the repo there is no project dir", loadSubagents(AGENT, ROOT, true).projectDir, undefined);
	store.set(REPO, null);
	rmAgents();
	rmSync(REPO, { recursive: true, force: true });
}

console.log("\n--- registry: the file a new agent gets ---");
check("kebab-case names map to <name>.md", userAgentPath(AGENT, "code-reviewer"), join(USER_DIR, "code-reviewer.md"));
for (const bad of ["../escape", "a/b", "Code Reviewer", "", "x.md"]) {
	let threw = false;
	try {
		userAgentPath(AGENT, bad);
	} catch {
		threw = true;
	}
	checkTrue(`"${bad}" is refused as a file name`, threw);
}

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
checkTrue("empty config says so", tableLines([])[0].includes("No subagents defined"));
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

console.log("\n--- model resolution: a reference's :level suffix ---");
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

console.log("\n--- model resolution: a full name pi does not list ---");
{
	// pi's `--model` accepts a "provider/id" its list does not hold yet, when
	// the provider is known: the model is a copy of that provider's first
	// listed model, with the id and the name set to the id. The extra fields
	// here stand in for the provider fields (api, base URL) that must be
	// copied. The two OpenRouter ids that hold a slash make a reference that
	// is ambiguous AND has a known provider, so the ambiguity rows prove the
	// fallback never replaces that error.
	const LISTED = [
		{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272000 },
		{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 400000 },
		{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", api: "openai-completions", contextWindow: 128000 },
		{ id: "deepseek/deepseek-chat", name: "DeepSeek Chat (OpenRouter)", provider: "openrouter", api: "openai-completions", contextWindow: 64000 },
		{ id: "deepseek/deepseek-coder", name: "DeepSeek Coder (OpenRouter)", provider: "openrouter", api: "openai-completions", contextWindow: 64000 },
	];
	const codex = (id: string) => ({ ...LISTED[0], id, name: id });
	const openrouter = (id: string) => ({ ...LISTED[3], id, name: id });
	const miss = (ref: string) => ({ ok: false, error: `model "${ref}" matched no available model` });
	const cases: Array<[string, string, unknown]> = [
		// label, reference, the resolution it must give
		["a listed full name is the listed model", "openai-codex/gpt-5.6-sol", { ok: true, model: LISTED[1] }],
		["an unlisted full name on a known provider is a copy of its first model", "openai-codex/gpt-6-sol", { ok: true, model: codex("gpt-6-sol") }],
		["the provider matches without case, and keeps the list's spelling", "OpenAI-Codex/gpt-6-sol", { ok: true, model: codex("gpt-6-sol") }],
		["a :level is split off the id and carried", "openai-codex/gpt-6-sol:high", { ok: true, model: codex("gpt-6-sol"), thinking: "high" }],
		["a suffix that is not a level stays in the id", "openrouter/new-model:free", { ok: true, model: openrouter("new-model:free") }],
		["the id is everything after the first slash", "openrouter/qwen/qwen-9", { ok: true, model: openrouter("qwen/qwen-9") }],
		["an unknown provider is an error", "nobody/gpt-6-sol", miss("nobody/gpt-6-sol")],
		["an unlisted bare id has no provider to copy", "gpt-6-sol", miss("gpt-6-sol")],
		["with a level, the error names the reference as configured", "gpt-6-sol:high", miss("gpt-6-sol:high")],
		["an empty id is an error", "openai-codex/", miss("openai-codex/")],
		["an empty provider is an error", "/gpt-6-sol", miss("/gpt-6-sol")],
		["an ambiguous reference stays an error", "deepseek/deepseek-c", { ok: false, error: 'model "deepseek/deepseek-c" matches several models — use a more specific id' }],
		["and so does its :level form", "deepseek/deepseek-c:high", { ok: false, error: 'model "deepseek/deepseek-c" matches several models — use a more specific id' }],
		// pi matches the id among the provider's own models before it makes one up.
		["a partial name inside a known provider is that provider's listed model", "openai-codex/luna", { ok: true, model: LISTED[0] }],
		["and carries its level", "openai-codex/sol:high", { ok: true, model: LISTED[1], thinking: "high" }],
		[
			"a partial name two of the provider's models share is an error",
			"openai-codex/gpt-5.6",
			{ ok: false, error: 'model "openai-codex/gpt-5.6" matches several models of that provider — use a more specific id' },
		],
	];
	for (const [label, reference, want] of cases) check(label, resolveSuffixedReference(reference, LISTED), want);
	const proxy = { id: "old-model", name: "Old Model", provider: "MyProxy" };
	check("a provider the list spells with capitals still matches", resolveSuffixedReference("myproxy/new-model", [proxy]), {
		ok: true,
		model: { ...proxy, id: "new-model", name: "new-model" },
	});
}

// ------------------------------------------------------------- tool description

console.log("\n--- the task tool description + usage mapping ---");
{
	const desc = buildTaskDescription([{ name: "code-explorer", purpose: "Read-only codebase discovery and investigation" }]);
	checkTrue("lists each subagent and purpose", desc.includes("code-explorer: Read-only codebase discovery") && desc.includes("subagent_type"));
	checkTrue("offers the one-time form", desc.includes("One-time agent: omit subagent_type"));
	checkTrue("its model is a model reference, the session model by default", desc.includes("model (a model reference such as provider/id; default: the session model)"));
	const none = buildTaskDescription([]);
	checkTrue("with no files it still offers the one-time form", none.includes("One-time agent") && !none.includes("Defined subagents"));
}
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
	const agents = [{ name: "explorer", purpose: "look", model: "luna", tools: ["read"] }, { name: "ghost", purpose: "x", model: "does-not-exist" }, { name: "suffixed", purpose: "x", model: "openai-codex/gpt-5.6-luna:high" }];
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, { agents, load: () => agents });
	const ctx = { cwd: ROOT, model: { id: "gpt-5.6-luna", provider: "openai-codex" }, modelRegistry: { getAll: () => MODELS }, isProjectTrusted: () => false };
	const throws = async (params: any) => {
		try { await toolDef.execute("id", params, undefined, undefined, ctx); return ""; } catch (e) { return (e as Error).message; }
	};
	checkTrue("unknown subagent lists valid options", (await throws({ subagent_type: "nobody", prompt: "hi" })).includes("Valid options"));
	checkTrue("and points at the one-time form", (await throws({ subagent_type: "nobody", prompt: "hi" })).includes("Omit subagent_type"));
	checkTrue("empty prompt is rejected", (await throws({ subagent_type: "explorer", prompt: " " })).includes("needs a prompt"));
	checkTrue("unresolvable model is rejected", (await throws({ subagent_type: "ghost", prompt: "go" })).includes("could not be used"));
	// A defined agent's file is the promise: the caller cannot widen its tools
	// or move its model.
	checkTrue("inline tools on a defined agent are refused", (await throws({ subagent_type: "explorer", prompt: "go", tools: ["read", "bash"] })).includes("apply only to a one-time agent"));
	checkTrue("so is an inline model", (await throws({ subagent_type: "explorer", prompt: "go", model: "sol" })).includes("apply only to a one-time agent"));

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

console.log("\n--- the task tool: one-time agents (no subprocess) ---");
{
	let toolDef: any;
	// No agent files at all: a one-time agent needs none.
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, { agents: [], load: () => [] });
	const ctx = { cwd: ROOT, model: { id: "gpt-5.6-luna", provider: "openai-codex" }, modelRegistry: { getAll: () => MODELS }, isProjectTrusted: () => false };
	const run = async (params: any) => {
		const updates: any[] = [];
		let error = "";
		try {
			await toolDef.execute("id", params, AbortSignal.abort(), (u: any) => updates.push(u), ctx);
		} catch (e) {
			error = (e as Error).message;
		}
		return { details: updates[0]?.details, error };
	};

	const bare = await run({ prompt: "count the files" });
	check("no subagent_type runs a one-time agent on the session model", [bare.details?.subagent, bare.details?.model], ["one-time", "openai-codex/gpt-5.6-luna"]);
	checkTrue("and reaches the spawn", bare.error.includes("aborted"));
	check("an empty subagent_type is the same", (await run({ subagent_type: " ", prompt: "go" })).details?.subagent, "one-time");

	const chosen = await run({ prompt: "go", model: "openai-codex/gpt-5.6-sol:max", reasoning: "Low" });
	check("the call's model is resolved, its pin beats the carried level", [chosen.details?.model, chosen.details?.reasoning], ["openai-codex/gpt-5.6-sol", "low"]);
	check("a carried level alone is used", (await run({ prompt: "go", model: "openai-codex/gpt-5.6-sol:max" })).details?.reasoning, "max");
	const unlisted = await run({ prompt: "go", model: "openai-codex/gpt-6-sol:high" });
	check("a full name pi does not list spawns as given, its level carried", [unlisted.details?.model, unlisted.details?.reasoning], ["openai-codex/gpt-6-sol", "high"]);

	const badLevel = await run({ prompt: "go", reasoning: "extreme" });
	checkTrue("a bad level is refused before any spawn", badLevel.details === undefined && badLevel.error.includes("not a thinking level"));
	// Dropping an unknown tool would leave the rest, or none, and none means ALL.
	const tools = await run({ prompt: "go", tools: ["read", "workflow"] });
	checkTrue("a tool a subagent cannot run is refused", tools.details === undefined && tools.error.includes("workflow cannot run in a subagent"));
	checkTrue("an empty tool list is refused", (await run({ prompt: "go", tools: [] })).error.includes("at least one"));
	checkTrue("an unknown model is refused", (await run({ prompt: "go", model: "nope" })).error.includes("could not be used"));
	checkTrue("an empty prompt is refused", (await run({ prompt: " " })).error.includes("needs a prompt"));

	const { oneTimeAgent } = await import("./tool.ts");
	check("tools are normalised and de-duplicated", oneTimeAgent({ tools: ["Read", "grep", "read"] }).tools, ["read", "grep"]);
	checkTrue("its role prompt is the one-time role", rolePrompt(oneTimeAgent({})).startsWith("You are a one-time subagent."));
}

console.log("\n--- the task tool: a file added mid-session runs at once ---");
{
	rmAgents();
	let toolDef: any;
	const load = (c: any) => loadSubagents(AGENT, c.cwd, c.isProjectTrusted()).agents;
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, { agents: [], load });
	const ctx = { cwd: ROOT, model: { id: "gpt-5.6-luna", provider: "openai-codex" }, modelRegistry: { getAll: () => MODELS }, isProjectTrusted: () => false };
	writeAgent(USER_DIR, "late.md", "---\nname: late\ndescription: added after registration\nmodel: sol\n---\n");
	const updates: any[] = [];
	try {
		await toolDef.execute("id", { subagent_type: "late", prompt: "go" }, AbortSignal.abort(), (u: any) => updates.push(u), ctx);
	} catch {
		/* the pre-aborted signal is the point */
	}
	check("the new file is found by name", [updates[0]?.details?.subagent, updates[0]?.details?.model], ["late", "openai-codex/gpt-5.6-sol"]);
	rmAgents();
}


// ------------------------------------- the carried :level precedence, end to end

console.log("\n--- the task tool: carried :level precedence (no subprocess) ---");
{
	// The registry carries an id whose tail LOOKS like a level, to pin that a
	// whole match never manufactures one; the agent files carry real levels,
	// on a listed model and on a full name pi does not list.
	const REGISTRY = [...MODELS, { id: "prompt-machine:high", name: "Prompt Machine", provider: "weird" }];

	let toolDef: any;
	const agents = [
		{ name: "pinned", purpose: "x", model: "openai-codex/gpt-5.6-luna:high", reasoning: "low" },
		{ name: "carried", purpose: "x", model: "openai-codex/gpt-5.6-sol:max" },
		{ name: "unlisted", purpose: "x", model: "openai-codex/gpt-6-sol:high" },
		{ name: "whole-match", purpose: "x", model: "weird/prompt-machine:high" },
		{ name: "plain", purpose: "x", model: "openai-codex/gpt-5.6-luna" },
	];
	registerTaskTool({ registerTool: (def: any) => (toolDef = def) } as never, { agents, load: () => agents });
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
	const carried = await spawnDetails("carried");
	check("a carried level is the spawn's reasoning", carried.reasoning, "max");
	check("and the model spawns bare", carried.model, "openai-codex/gpt-5.6-sol");
	const unlisted = await spawnDetails("unlisted");
	check("a full name pi does not list spawns bare", unlisted.model, "openai-codex/gpt-6-sol");
	check("with its carried level", unlisted.reasoning, "high");
	const whole = await spawnDetails("whole-match");
	check("a whole-matched level-shaped tail yields no level", whole.reasoning, undefined);
	check("with the colon kept in the model id", whole.model, "weird/prompt-machine:high");
	check("no suffix anywhere leaves the session's level", (await spawnDetails("plain")).reasoning, undefined);
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
	// The name becomes the file name, so anything but kebab-case is refused.
	const { ctx, notices } = scriptedCtx({ input: ["../escape"] });
	check("a name that is not a safe file name is refused", await runWizard(ctx as never, undefined, new Set()), undefined);
	checkTrue("and explained", notices.some(([lvl, m]) => lvl === "error" && m.includes("lowercase letters")));
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
	rmAgents();
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
	const h = makePi();
	extension(h.pi as never);

	// Build a command ctx that also serves as the wizard ctx.
	const notices: Array<[string, string]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const q = {
		input: ["reviewer", "Review diffs: correctness first"],
		select: ["openai-codex/gpt-5.6-sol", "low", "Read-only (read, grep, find, ls)"],
		confirm: [false /* prompt? */, true /* save? */],
	};
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		model: { id: "gpt-5.6-luna", provider: "openai-codex" },
		modelRegistry: { getAll: () => MODELS },
		isProjectTrusted: () => false,
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
	checkTrue("task tool is active with no agent files", h.getActive().includes("task"));

	await h.commands.get("subagents").handler("add", ctx);
	const FILE = join(USER_DIR, "reviewer.md");
	checkTrue("the agent file was created", existsSync(FILE));
	check("and reads back as what the wizard built", parseSubagentFile(readFileSync(FILE, "utf8"), FILE).def, {
		name: "reviewer",
		purpose: "Review diffs: correctness first",
		model: "openai-codex/gpt-5.6-sol",
		reasoning: "low",
		tools: ["read", "grep", "find", "ls"],
	});
	checkTrue("confirmation names the file and the agent", notices.some(([lvl, m]) => lvl === "info" && m.includes('Added "reviewer"') && m.includes("reviewer.md")));
	checkTrue("the tool description now lists it", h.tools.find((t) => t.name === "task")?.description.includes("- reviewer: Review diffs"));

	// Edit it: keep the purpose, drop the model pin, open the tools.
	const q3 = { input: [""], select: ["(session default)", "high", "All tools"], confirm: [false, true] };
	const ctx3: any = { ...ctx, ui: { ...ctx.ui, input: async () => q3.input.shift(), select: async () => q3.select.shift(), confirm: async () => q3.confirm.shift() ?? false } };
	await h.commands.get("subagents").handler("edit reviewer", ctx3);
	check("edit rewrites the same file", parseSubagentFile(readFileSync(FILE, "utf8"), FILE).def, { name: "reviewer", purpose: "Review diffs: correctness first", reasoning: "high" });

	// A second add of the same name is refused before any file is touched.
	const qDup = { input: ["reviewer"] };
	const ctxDup: any = { ...ctx, ui: { ...ctx.ui, input: async () => qDup.input.shift() } };
	await h.commands.get("subagents").handler("add", ctxDup);
	checkTrue("a taken name is refused", notices.some(([lvl, m]) => lvl === "error" && m.includes("already exists")));

	// A file that does not parse is not a taken name, but it is still not ours to overwrite.
	writeAgent(USER_DIR, "broken.md", "---\nname: [broken\n---\n");
	const qBroken = { input: ["broken", "anything"], select: ["(session default)", "(inherit)", "All tools"], confirm: [false, true] };
	const ctxBroken: any = { ...ctx, ui: { ...ctx.ui, input: async () => qBroken.input.shift(), select: async () => qBroken.select.shift(), confirm: async () => qBroken.confirm.shift() ?? false } };
	await h.commands.get("subagents").handler("add", ctxBroken);
	check("an unparsable file is left as it was", readFileSync(join(USER_DIR, "broken.md"), "utf8"), "---\nname: [broken\n---\n");
	rmSync(join(USER_DIR, "broken.md"));

	// Remove it.
	const q2 = { confirm: [true] };
	const ctx2: any = { ...ctx, ui: { ...ctx.ui, confirm: async () => q2.confirm.shift() ?? false } };
	await h.commands.get("subagents").handler("remove reviewer", ctx2);
	checkTrue("remove deletes the file", !existsSync(FILE));
	check("and nothing is left to run", namesIn(loadSubagents(AGENT, ROOT, false).agents), []);
	checkTrue("task tool stays active", h.getActive().includes("task"));
	rmAgents();
}

console.log("\n--- wiring: project agents are shown, but not edited here ---");
{
	rmAgents();
	const REPO = join(ROOT, "wired-repo");
	const PROJECT_DIR = join(REPO, ".pi", "agents");
	writeAgent(PROJECT_DIR, "migrator.md", "---\nname: migrator\ndescription: repo migrations\n---\n");
	new ProjectTrustStore(AGENT).set(REPO, true);
	const h = makePi();
	extension(h.pi as never);
	const notices: Array<[string, string]> = [];
	let asked = false;
	const ctx: any = {
		hasUI: true,
		cwd: REPO,
		modelRegistry: { getAll: () => MODELS },
		isProjectTrusted: () => true,
		ui: {
			input: async () => undefined,
			select: async () => ((asked = true), undefined),
			confirm: async () => ((asked = true), true),
			editor: async () => undefined,
			notify: (m: string, l: string) => notices.push([l, m]),
			setStatus: () => {},
		},
	};
	h.commands.get("on:session_start")!({}, ctx);
	checkTrue("a trusted project's agent reaches the tool description", h.tools.find((t) => t.name === "task")?.description.includes("- migrator: repo migrations"));
	await h.commands.get("subagents").handler("list", ctx);
	checkTrue("the table marks it as a project agent", notices.some(([, m]) => m.includes("migrator (project)")));
	await h.commands.get("subagents").handler("remove migrator", ctx);
	checkTrue("remove refuses it and says where it lives", notices.some(([, m]) => m.includes("project agent") && m.includes(join(PROJECT_DIR, "migrator.md"))));
	checkTrue("without asking anything", !asked);
	checkTrue("and the file is untouched", existsSync(join(PROJECT_DIR, "migrator.md")));

	const untrusted = { ...ctx, isProjectTrusted: () => false };
	h.commands.get("on:session_start")!({}, untrusted);
	checkTrue("untrusted, the tool description leaves it out", !h.tools.find((t) => t.name === "task")?.description.includes("migrator"));

	// The review's case: nothing saved, and pi calling the session trusted.
	new ProjectTrustStore(AGENT).set(REPO, null);
	h.commands.get("on:session_start")!({}, ctx);
	checkTrue("with no saved decision the repo's agent stays out of the description", !h.tools.find((t) => t.name === "task")?.description.includes("migrator"));
	let refused = "";
	try {
		await h.tools.find((t) => t.name === "task").execute("id", { subagent_type: "migrator", prompt: "go" }, AbortSignal.abort(), undefined, { ...ctx, model: { id: "gpt-5.6-luna", provider: "openai-codex" } });
	} catch (e) {
		refused = (e as Error).message;
	}
	checkTrue("and task will not run it by name", refused.includes('Unknown subagent "migrator"'));
	rmSync(REPO, { recursive: true, force: true });
}

console.log("\n--- wiring: the panel shows what a spawn would use ---");
{
	// A suffixed model with no per-agent pin and a blanket default: the
	// Reasoning column must show the carried level, and the Model column the
	// bare id — a suffix leaking into either would misreport the spawn.
	rmAgents();
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
	writeSubagent(userAgentPath(AGENT, "veiled"), { name: "veiled", purpose: "suffix carrier", model: "openai-codex/gpt-5.6-luna:high" });
	const h = makePi();
	extension(h.pi as never);
	const notices: Array<[string, string]> = [];
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		modelRegistry: { getAll: () => MODELS },
		isProjectTrusted: () => false,
		ui: { notify: (m: string, l: string) => notices.push([l, m]), setStatus: () => {} },
	};
	await h.commands.get("subagents").handler("list", ctx);
	const table = notices.find(([, m]) => m.includes("Subagent"))?.[1] ?? "";
	checkTrue("the model cell is the bare id", table.includes("gpt-5.6-luna") && !table.includes(":high"));
	checkTrue("the reasoning cell is the carried level", table.includes("High"));
	checkTrue("the table says where the files are", table.includes(USER_DIR));
	rmAgents();
}

// ------------------------------------------------- drafting from a sentence

console.log("\n--- parseDraft: the catalogue is the law ---");
{
	const { parseDraft, buildCatalog } = await import("./draft.ts");
	const catalog = buildCatalog(MODELS, ["reviewer"]);
	const draft = (body: string) => parseDraft(body, catalog, MODELS);
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
		// A person may write a full name pi does not list; a drafter that
		// invents one has left the catalogue it was given.
		const invented = draft(json({ model: "openai-codex/gpt-7-invented" })) as any;
		check("a full name pi does not list is dropped from a draft", invented.def.model, undefined);
		checkTrue("with a note", invented.notes.some((n: string) => n.includes("gpt-7-invented")));
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
}

console.log("\n--- draftSubagent: the session model drafts ---");
{
	// No model is configured for the draft, so it runs on the session model.
	// A registry that refuses every model stops the draft before any network
	// call, and still shows which model the draft asked to call.
	const { buildCatalog, draftSubagent } = await import("./draft.ts");
	const asked: string[] = [];
	const registry = {
		getAll: () => MODELS,
		getApiKeyAndHeaders: async (model: any) => (asked.push(modelRef(model)), { ok: false as const, error: "not signed in" }),
	};
	const outcome = await draftSubagent({ model: MODELS[2], modelRegistry: registry }, "a read-only reviewer", buildCatalog(MODELS, []), 1000);
	check("the draft asks for the session model", asked, ["anthropic/claude-opus-4-8"]);
	check("and a model it cannot call fails the draft", outcome, { ok: false, error: "not signed in" });
	check("with no session model there is nothing to draft with", await draftSubagent({ modelRegistry: registry }, "x", buildCatalog(MODELS, []), 1000), { ok: false, error: "no model available to draft with" });
}

console.log("\n--- wiring: /subagents add <description> ---");
{
	rmAgents();
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));
	const h = makePi();
	extension(h.pi as never);

	const notices: Array<[string, string]> = [];
	let wizardRan = false;
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		isProjectTrusted: () => false,
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
	check("nothing was stored", existsSync(USER_DIR), false);

	// No description is still the wizard.
	await h.commands.get("subagents")!.handler("add", ctx);
	checkTrue("a bare add runs the wizard", wizardRan);
	rmAgents();
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
