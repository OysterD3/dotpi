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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// piInvocation() resolves the pi binary from process.argv[1], which inside a
// running pi is pi's own entry script. Reproduce that condition here.
process.argv[1] =
	"/Users/oysterlee/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.81.1/8c1adef989f2d9abbd49ba1abe62d1ade279fa2c19c1265a0ffed8b50758c8aa/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const { registerWorkflowTool } = await import("./tool.ts");
const { RunRegistry } = await import("./runs.ts");

const CWD = mkdtempSync(join(tmpdir(), "ultracode-live-"));

const runtime = await ModelRuntime.create({
	authPath: "/Users/oysterlee/.pi/agent/auth.json",
	modelsStorePath: "/Users/oysterlee/.pi/agent/models-store.json",
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
registerWorkflowTool(fakePi as any, { registry });
const tool = tools.get("workflow")!;

const ctx = {
	cwd: CWD,
	hasUI: false,
	model,
	isProjectTrusted: () => false,
	isIdle: () => true,
	modelRegistry: { getAll: () => models },
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
} finally {
	rmSync(CWD, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
