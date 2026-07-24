/**
 * Live advisor test: does the full path — tool execute → branch flattening →
 * tool-less pi subprocess → JSONL parsing → advice back — work against a real
 * reviewer model?
 *
 * Covers what the offline suite cannot: the actual spawn of the reviewer with a
 * real model reference, and that non-empty advice and usage come back. Not part
 * of the offline suite — needs credentials and the network, and costs one small
 * model call.
 *
 * Run with jiti from a directory where pi's packages resolve:
 *     jiti agent/extensions/advisor/advisor.live.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// piInvocation() resolves the pi binary from process.argv[1], which inside a
// running pi is pi's own entry script. Reproduce that condition here.
process.argv[1] =
	"/Users/oysterlee/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.81.1/8c1adef989f2d9abbd49ba1abe62d1ade279fa2c19c1265a0ffed8b50758c8aa/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const { registerAdvisorTool } = await import("./tool.ts");

const CWD = mkdtempSync(join(tmpdir(), "advisor-live-"));

const runtime = await ModelRuntime.create({
	authPath: "/Users/oysterlee/.pi/agent/auth.json",
	modelsStorePath: "/Users/oysterlee/.pi/agent/models-store.json",
});
const models = runtime.getModels("openai-codex");
const reviewer = models.find((m) => m.id === "gpt-5.4-mini") ?? models[0];
const mainModel = models.find((m) => m.id !== reviewer?.id) ?? { id: "main-placeholder", provider: "placeholder" };
if (!reviewer) throw new Error("no reviewer model available");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
}

const tools = new Map<string, any>();
registerAdvisorTool({ registerTool: (t: any) => tools.set(t.name, t) } as never, {
	reference: () => `${reviewer.provider}/${reviewer.id}`,
});
const tool = tools.get("advisor")!;

// A small, real-looking session: the agent is about to do something risky.
const branch = [
	{
		type: "message",
		message: {
			role: "user",
			content: "Load this config file and use its values. It comes from a user upload.",
		},
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I'll parse it with yaml.load so I get real Python objects." },
				{ type: "toolCall", name: "read", arguments: { path: "config.yaml" } },
			],
		},
	},
	{
		type: "message",
		message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "port: 8080\nname: demo\n" }] },
	},
];

const ctx = {
	cwd: CWD,
	hasUI: false,
	model: mainModel,
	modelRegistry: { getAll: () => models },
	sessionManager: { getBranch: () => branch },
};

const started = Date.now();
try {
	const result = await tool.execute("live1", {}, undefined, (u: any) => console.log(`  update: ${u.content?.[0]?.text}`), ctx);
	const elapsed = Date.now() - started;
	const advice = result.content[0].text as string;
	console.log(`\nadvisor ran in ${elapsed}ms on ${reviewer.provider}/${reviewer.id}`);
	console.log(`--- advice ---\n${advice}\n--------------`);
	console.log(`usage: ${JSON.stringify(result.usage)}`);

	check("advice came back non-empty", advice.trim().length > 0, advice);
	check("it was not the same-model skip", result.details?.skipped === undefined, result.details);
	check("usage counted cost", (result.usage?.cost?.total ?? 0) > 0, result.usage);
	check("reviewer model recorded", result.details?.advisorModel === `${reviewer.provider}/${reviewer.id}`, result.details);
} catch (error) {
	failures++;
	console.log(`FAIL  advisor threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(CWD, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
