/**
 * Live subagents test: does the full path — task tool execute → subprocess with
 * a pinned model, reasoning level, and tool allowlist → JSONL parsing → report
 * back — work against a real model, for a defined subagent and for a one-time
 * agent?
 *
 * Not part of the offline suite: needs credentials and the network, and costs
 * two small subagent calls.
 *
 * Run with jiti from a directory where pi's packages resolve:
 *     jiti agent/extensions/subagents/subagents.live.ts
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Resolved against the same basis as the static import above. The package only
// exports ".", so cli.js is taken from beside the resolved entry point.
process.argv[1] =
	process.env.PI_CLI ??
	join(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")), "cli.js");

const { registerTaskTool } = await import("./tool.ts");

const CWD = mkdtempSync(join(tmpdir(), "subagents-live-"));

const runtime = await ModelRuntime.create({
	authPath: join(getAgentDir(), "auth.json"),
	modelsStorePath: join(getAgentDir(), "models-store.json"),
});
const models = runtime.getModels("openai-codex");
const small = models.find((m) => m.id === "gpt-5.4-mini") ?? models[0];
if (!small) throw new Error("no model available");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
}

const agents = [
	{ name: "calculator", purpose: "Answer arithmetic questions", model: small.id, tools: ["read", "grep", "find", "ls"], reasoning: "low" },
];

const tools = new Map<string, any>();
registerTaskTool({ registerTool: (t: any) => tools.set(t.name, t) } as never, { agents, load: () => agents });
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

	// No subagent_type: the call names the model, level and tools itself.
	const oneTime = await tool.execute(
		"live2",
		{ description: "multiply", prompt: "What is 7 * 8? Reply with just the number.", model: small.id, reasoning: "low", tools: ["read"] },
		undefined,
		(u: any) => console.log(`  update: ${u.content?.[0]?.text}`),
		ctx,
	);
	const oneTimeText = oneTime.content[0].text as string;
	console.log(`--- one-time report ---\n${oneTimeText}\n--------------`);
	check("one-time: answer is 56", /\b56\b/.test(oneTimeText), oneTimeText);
	check("one-time: ran on the model the call named", oneTime.details?.model === `${small.provider}/${small.id}` && oneTime.details?.subagent === "one-time", oneTime.details);
} catch (error) {
	failures++;
	console.log(`FAIL  task threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(CWD, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
