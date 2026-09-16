/** Real Pi receive path; only the provider response and compaction summary are fixtures.
 * Requires Pi >= 0.85.1, where isIdle() includes manual compaction.
 * Run against the installed Pi SDK, not an older local dependency copy:
 *     pnpm dlx jiti agent/extensions/intercom/receiver.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CONFIG, MESSAGE_TYPE } from "./config.ts";
import { registerIntercom } from "./index.ts";
import { layout, putMessage } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "intercom-receiver-"));
const oldPollMs = CONFIG.pollMs;
CONFIG.pollMs = 10;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json") });
modelRuntime.registerProvider("intercom-test", {
	baseUrl: "http://unused.invalid",
	apiKey: "fixture",
	api: "openai-completions",
	models: [{ id: "receiver", name: "Receiver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
});
const requests: string[] = [];
let compactionStarted = false;
let finishCompaction: (() => void) | undefined;
let cancelCompaction = false;
const resourceLoader = new DefaultResourceLoader({
	cwd: root, agentDir: root, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	extensionFactories: [(pi) => {
		registerIntercom(pi, { agentDir: root });
		pi.on("session_before_compact", async (event) => {
			compactionStarted = true;
			await new Promise<void>((resolve) => { finishCompaction = resolve; });
			if (cancelCompaction) return { cancel: true };
			return { compaction: { summary: "Fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	}],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
	cwd: root, agentDir: root, settingsManager, resourceLoader, modelRuntime,
	model: modelRuntime.getModel("intercom-test", "receiver"), sessionManager: SessionManager.inMemory(root),
	noTools: "builtin",
});
session.agent.streamFunction = (model, context) => {
	requests.push(JSON.stringify(context.messages));
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text: "Received" }], api: model.api, provider: model.provider, model: model.id,
		usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end();
	return stream;
};
const errors: string[] = [];
await session.bindExtensions({ mode: "rpc", uiContext: {} as never, onError: (error) => errors.push(error.error) });
const l = layout(root);
const send = (text: string) => putMessage(l, session.sessionId, {
	from: { id: "sender", name: "Sender", cwd: root }, text, summary: text, sentAt: Date.now(),
});
const until = async (done: () => boolean) => {
	for (let i = 0; i < 200 && !done(); i++) await sleep(10);
	assert.ok(done(), "receiver did not reach the expected state");
};

try {
	send("idle receiver probe");
	await until(() => requests.length === 1 && session.isIdle);
	assert.ok(requests[0].includes("idle receiver probe"));
	assert.equal(session.messages.at(-1)?.role, "assistant");
	console.log("PASS idle delivery starts a real agent response");

	for (const cancel of [false, true]) {
		cancelCompaction = cancel;
		compactionStarted = false;
		const compacting = session.compact().then(() => undefined, (error: Error) => error);
		try {
			await until(() => compactionStarted);
			const before = requests.length;
			const marker = `during ${cancel ? "cancelled" : "completed"} compaction`;
			send(marker);
			await sleep(CONFIG.pollMs * 5);
			assert.equal(requests.length, before, "do not start a model turn inside manual compaction");
			assert.equal(readdirSync(join(l.inbox, session.sessionId)).length, 1, "keep mail until compaction ends");
			finishCompaction!();
			const result = await compacting;
			assert.equal(result instanceof Error, cancel);
			await until(() => requests.length === before + 1 && session.isIdle);
			assert.ok(requests.at(-1)?.includes(marker));
			assert.equal(session.messages.at(-1)?.role, "assistant");
			assert.equal(session.messages.filter((message) => message.role === "custom" && message.customType === MESSAGE_TYPE && String(message.content).includes(marker)).length, 1);
			console.log(`PASS mail starts one response after ${cancel ? "cancelled" : "completed"} compaction`);
		} finally {
			finishCompaction?.();
			await compacting;
		}
	}
	assert.deepEqual(errors, []);
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	CONFIG.pollMs = oldPollMs;
	rmSync(root, { recursive: true, force: true });
}
