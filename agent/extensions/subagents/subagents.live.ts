/**
 * Live subagents test: does the full path — task tool execute → subprocess with
 * a pinned model, reasoning level, and tool allowlist → JSONL parsing → report
 * back — work against a real model?
 *
 * Not part of the offline suite: needs credentials and the network, and costs
 * one small subagent call.
 *
 * Run with jiti from a directory where pi's packages resolve:
 *     jiti agent/extensions/subagents/subagents.live.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

process.argv[1] =
	"/Users/oysterlee/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.81.1/8c1adef989f2d9abbd49ba1abe62d1ade279fa2c19c1265a0ffed8b50758c8aa/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const { registerTaskTool } = await import("./tool.ts");

const CWD = mkdtempSync(join(tmpdir(), "subagents-live-"));

const runtime = await ModelRuntime.create({
	authPath: "/Users/oysterlee/.pi/agent/auth.json",
	modelsStorePath: "/Users/oysterlee/.pi/agent/models-store.json",
});
const models = runtime.getModels("openai-codex");
const small = models.find((m) => m.id === "gpt-5.4-mini") ?? models[0];
if (!small) throw new Error("no model available");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
}

const settings = {
	defaults: { model: small.id, reasoning: "low" },
	agents: [
		{ name: "calculator", purpose: "Answer arithmetic questions", tools: ["read", "grep", "find", "ls"], reasoning: "low" },
	],
};

const tools = new Map<string, any>();
registerTaskTool({ registerTool: (t: any) => tools.set(t.name, t) } as never, { settings: () => settings as never });
const tool = tools.get("task")!;

const ctx = {
	cwd: CWD,
	hasUI: false,
	model: models.find((m) => m.id !== small.id) ?? small,
	modelRegistry: { getAll: () => models },
	isProjectTrusted: () => false,
};

const started = Date.now();
try {
	const result = await tool.execute(
		"live1",
		{ subagent_type: "calculator", description: "multiply", prompt: "What is 6 * 7? Reply with just the number." },
		undefined,
		(u: any) => console.log(`  update: ${u.content?.[0]?.text}`),
		ctx,
	);
	const text = result.content[0].text as string;
	console.log(`\nsubagent ran in ${Date.now() - started}ms on ${small.provider}/${small.id}`);
	console.log(`--- report ---\n${text}\n--------------`);
	console.log(`usage: ${JSON.stringify(result.usage)}`);
	console.log(`details: ${JSON.stringify(result.details)}`);

	check("report came back", text.trim().length > 0, text);
	check("answer is 42", /\b42\b/.test(text), text);
	check("ran on the pinned model", result.details?.model === `${small.provider}/${small.id}`, result.details);
	check("reasoning recorded", result.details?.reasoning === "low", result.details);
	check("usage counted cost", (result.usage?.cost?.total ?? 0) > 0, result.usage);
} catch (error) {
	failures++;
	console.log(`FAIL  task threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(CWD, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
