/**
 * Live workflow test: does the full path — tool execute → engine → pi
 * subprocess fleet → JSONL parsing → schema retry — work against a real model?
 *
 * Everything else is unit/e2e tested offline; this checks actual spawning:
 * two parallel subagents (one schema-constrained), usage accounting, and the
 * final tool result. Not part of the offline suite — needs credentials and
 * the network, and costs a few subagent calls on a small model.
 *
 * Run with jiti from a directory where pi's packages resolve (they are not
 * dependencies of this repo):
 *     jiti agent/extensions/ultracode/ultracode.live.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// piInvocation() resolves the pi binary from process.argv[1], which inside a
// running pi is pi's own entry script. Reproduce that condition here.
process.argv[1] =
	"/Users/oysterlee/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.81.1/8c1adef989f2d9abbd49ba1abe62d1ade279fa2c19c1265a0ffed8b50758c8aa/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const { registerWorkflowTool } = await import("./tool.ts");

const CWD = mkdtempSync(join(tmpdir(), "ultracode-live-"));

const tools = new Map<string, any>();
registerWorkflowTool({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {});
const tool = tools.get("workflow")!;

const ctx = {
	cwd: CWD,
	hasUI: false,
	model: { provider: "openai-codex", id: "gpt-5.4-mini", name: "mini", reasoning: true, contextWindow: 200_000 },
	isProjectTrusted: () => false,
};

const script = [
	"export const meta = { name: 'live-check', description: 'two subagents, one schema-bound', phases: [{ title: 'Ask' }] }",
	"phase('Ask')",
	"const [sum, gold] = await parallel([",
	"  () => agent('What is 2+3?', { label: 'sum', schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } } }),",
	"  () => agent('What is the chemical symbol for gold? Reply with the symbol only.', { label: 'gold' }),",
	"])",
	"log('both agents answered')",
	"return { sum, gold }",
].join("\n");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
}

const started = Date.now();
const updates: any[] = [];
try {
	const result = await tool.execute("live1", { script }, undefined, (u: any) => updates.push(u), ctx);
	const elapsed = Date.now() - started;
	const details = result.details;
	const value = details && (JSON.parse(result.content[0].text.split("Result:\n")[1]) as any);

	console.log(`ran in ${elapsed}ms; usage: ${JSON.stringify(details.usage)}`);
	console.log(`result: ${JSON.stringify(value)}`);

	check("status done", details.status === "done", details.status);
	check("two agents ran", details.agentCount === 2, details.agentCount);
	check("schema agent returned {value: 5}", value?.sum?.value === 5, value?.sum);
	check("free-text agent mentioned Au", typeof value?.gold === "string" && /\bAu\b/.test(value.gold), value?.gold);
	check("usage counted turns", details.usage.turns >= 2, details.usage.turns);
	check("usage counted cost", details.usage.cost > 0, details.usage.cost);
	check("progress streamed", updates.length >= 3, updates.length);
	check("log line captured", details.logs.includes("both agents answered"), details.logs);
} catch (error) {
	failures++;
	console.log(`FAIL  workflow threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(CWD, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
