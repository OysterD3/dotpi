/**
 * Live workflow test: does the full path — tool execute → engine → pi
 * subprocess fleet → JSONL parsing → schema retry — work against a real model?
 *
 * Covers what offline tests cannot: actual spawning (wait mode, with a
 * model REFERENCE resolved against the real registry), and one background run
 * whose result is delivered via sendMessage. Not part of the offline suite —
 * needs credentials and the network, and costs a few subagent calls on a
 * small model.
 *
 * Run with jiti from a directory where pi's packages resolve (they are not
 * dependencies of this repo):
 *     jiti agent/extensions/ultracode/ultracode.live.ts
 */
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

// piInvocation() resolves the pi binary from process.argv[1], which inside a
// running pi is pi's own entry script. Reproduce that condition here, resolving
// against the same basis as the static import above — if that import loaded,
// this resolves too. The package only exports ".", so cli.js is taken from
// beside the resolved entry rather than requested as a subpath.
process.argv[1] =
	process.env.PI_CLI ??
	join(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")), "cli.js");

const { registerWorkflowTool } = await import("./tool.ts");
const { RunRegistry } = await import("./runs.ts");
const { DEFAULT_LIMITS } = await import("./config.ts");
const { listRuns, readJournalLines } = await import("./store.ts");

const CWD = mkdtempSync(join(tmpdir(), "ultracode-live-"));
/** A throwaway agent dir, so the run store does not touch the real ~/.pi. */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "ultracode-live-agent-"));

const runtime = await ModelRuntime.create({
	authPath: join(getAgentDir(), "auth.json"),
	modelsStorePath: join(getAgentDir(), "models-store.json"),
});
const models = runtime.getModels("openai-codex");
const model = models.find((m) => m.id === "gpt-5.4-mini") ?? models[0];
if (!model) throw new Error("no model available");

const registry = new RunRegistry();
const tools = new Map<string, any>();
const sent: any[] = [];
const fakePi = {
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	sendMessage: (message: any, options: any) => sent.push({ message, options }),
};
registerWorkflowTool(fakePi as any, {
	registry,
	agentDir: AGENT_DIR,
	settings: () => ({ keywordTrigger: true, limits: DEFAULT_LIMITS }),
});
const tool = tools.get("workflow")!;

const ctx = {
	cwd: CWD,
	hasUI: false,
	model,
	isProjectTrusted: () => false,
	isIdle: () => true,
	modelRegistry: { getAll: () => models },
	// The run snapshots the branch for context forking and the session file for
	// lineage; a headless harness has neither.
	sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
};

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
}

// ------------------------------------------------- wait mode + model routing

const waitScript = [
	"export const meta = { name: 'live-check', description: 'two subagents, one schema-bound', phases: [{ title: 'Ask' }] }",
	"phase('Ask')",
	"const [sum, gold] = await parallel([",
	"  () => agent('What is 2+3?', { label: 'sum', model: 'mini', schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } } }),",
	"  () => agent('What is the chemical symbol for gold? Reply with the symbol only.', { label: 'gold' }),",
	"])",
	"log('both agents answered')",
	"return { sum, gold }",
].join("\n");

const started = Date.now();
try {
	const result = await tool.execute("live1", { script: waitScript, wait: true }, undefined, undefined, ctx);
	const elapsed = Date.now() - started;
	const details = result.details;
	const value = JSON.parse(result.content[0].text.split("Result:\n")[1]) as any;

	console.log(`wait-mode ran in ${elapsed}ms; usage: ${JSON.stringify(details.usage)}`);
	console.log(`result: ${JSON.stringify(value)}`);

	check("status done", details.status === "done", details.status);
	check("two agents ran", details.agentCount === 2, details.agentCount);
	check('reference "mini" routed and answered {value: 5}', value?.sum?.value === 5, value?.sum);
	check("free-text agent mentioned Au", typeof value?.gold === "string" && /\bAu\b/.test(value.gold), value?.gold);
	check("usage counted cost", details.usage.cost > 0, details.usage.cost);
	check("usage attached to tool result", result.usage?.cost?.total > 0, result.usage);
} catch (error) {
	failures++;
	console.log(`FAIL  wait-mode threw: ${error instanceof Error ? error.message : String(error)}`);
}

// ------------------------------------------------------------ background run

const backgroundScript = [
	"export const meta = { name: 'live-bg', description: 'one background subagent' }",
	"return { answer: await agent('What is 10*7? Reply with the number only.', { label: 'product' }) }",
].join("\n");

try {
	const immediate = await tool.execute("live2", { script: backgroundScript }, undefined, undefined, ctx);
	check("background returns immediately", immediate.content[0].text.includes("started in the background"), immediate.content[0].text);
	const run = registry.all().find((r) => r.progress.name === "live-bg")!;
	check("run registered", run !== undefined);
	await run.settled;
	check("background run finished", run.progress.status === "done", run.progress);
	check("result delivered via sendMessage", sent.length === 1 && sent[0].message.customType === "workflow-result", sent);
	check("delivered content has the answer", /70/.test(sent[0]?.message.content ?? ""), sent[0]?.message.content);
	check("idle delivery triggers a turn", sent[0]?.options?.triggerTurn === true, sent[0]?.options);
} catch (error) {
	failures++;
	console.log(`FAIL  background threw: ${error instanceof Error ? error.message : String(error)}`);
}

// ------------------------------------------------- store, transcripts, resume

try {
	const stored = listRuns(AGENT_DIR);
	check("both runs were stored", stored.length === 2, stored.map((meta) => meta.runId));
	const first = stored.find((meta) => meta.name === "live-check");
	check("run.json records the outcome", first?.status === "done", first?.status);
	check("run.json records spend", (first?.usage.cost ?? 0) > 0, first?.usage);

	const records = readJournalLines(AGENT_DIR, first!.runId) as any[];
	const agents = records.filter((record) => record.kind === "agent");
	check("the journal has both agents", agents.length === 2, agents.length);
	check("agents recorded their results", agents.every((record) => record.result !== undefined), agents);

	// Every agent should have left a real pi session behind — that is what
	// makes a finished run debuggable.
	const transcripts = readdirSync(join(AGENT_DIR, "workflow-runs", first!.runId, "agents")).filter((name) => name.endsWith(".jsonl"));
	check("each agent left a transcript", transcripts.length >= 2, transcripts);

	// Resume: the same script against the previous journal should spawn nothing.
	const before = Date.now();
	const resumed = await tool.execute("live3", { script: waitScript, wait: true, resumeFromRunId: first!.runId }, undefined, undefined, ctx);
	const resumeMs = Date.now() - before;
	const details = resumed.details;
	check("resume finished", details.status === "done", details.status);
	check("resume replayed both agents", details.replayedCount === 2, details.replayedCount);
	check("resume spawned nothing", details.usage.cost === 0, details.usage);
	check("resume was fast", resumeMs < 5000, resumeMs);
	check("resume reproduced the result", /"value": ?5/.test(resumed.content[0].text), resumed.content[0].text);
} catch (error) {
	failures++;
	console.log(`FAIL  store/resume threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(CWD, { recursive: true, force: true });
	rmSync(AGENT_DIR, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
