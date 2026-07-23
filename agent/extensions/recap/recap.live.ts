/**
 * Live recap test: does a real model, given the transcribed Claude Code prompt,
 * actually produce a short plain-text recap?
 *
 * Everything else about /recap is unit-tested offline. This checks the one thing
 * unit tests cannot: that the prompt yields a usable one- or two-sentence summary
 * from a real provider, and that it obeys the "no markdown, under 40 words"
 * shape. Not part of the offline suite — it needs credentials and the network.
 *
 * Run directly:
 *     pnpm dlx jiti agent/extensions/recap/recap.live.ts
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { RECAP_SYSTEM, recapRequest } from "./prompts.ts";
import { buildTranscript } from "./transcript.ts";

const runtime = await ModelRuntime.create({
	authPath: "/Users/oysterlee/.pi/agent/auth.json",
	modelsStorePath: "/Users/oysterlee/.pi/agent/models-store.json",
});

const model =
	runtime.getModels("openai-codex").find((m) => m.id === "gpt-5.6-sol") ?? runtime.getModels("openai-codex")[0];
if (!model) throw new Error("no model available");
console.log(`model: ${model.provider}/${model.id}  window=${model.contextWindow}`);

// ModelRuntime.getAuth nests credentials under .auth; the ModelRegistry facade
// the extension uses flattens them. This harness talks to the runtime directly.
const resolved = await runtime.getAuth(model);
const auth = (resolved as unknown as { auth: { apiKey?: string; headers?: Record<string, string> } } | undefined)?.auth;
if (!auth) throw new Error("no auth");

function msg(role: string, text: string) {
	return { type: "message", message: { role, content: [{ type: "text", text }] } };
}

const CASES: Array<{ name: string; entries: unknown[] }> = [
	{
		name: "mid-task debugging",
		entries: [
			msg("user", "the checkout page 500s intermittently, find out why"),
			msg("assistant", "I reproduced it: the 500 comes from a null `session.userId` in `finalizeOrder`. I added logging and confirmed it only happens for guest checkouts. Next I'll guard the guest path."),
		],
	},
	{
		name: "feature build",
		entries: [
			msg("user", "add dark mode to the settings screen"),
			msg("assistant", "I added a theme toggle, wired it to a `useTheme` hook, and updated the settings screen. Tests pass. Still need to persist the choice to localStorage."),
		],
	},
];

let failures = 0;
for (const testCase of CASES) {
	const transcript = buildTranscript(testCase.entries as never, model.contextWindow);

	const started = Date.now();
	const response = await completeSimple(
		model,
		{ systemPrompt: RECAP_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: recapRequest(transcript.text) }], timestamp: Date.now() }] },
		{ apiKey: auth.apiKey, headers: auth.headers, timeoutMs: 30_000, reasoning: "minimal" },
	);
	const ms = Date.now() - started;

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	const words = text.split(/\s+/).filter(Boolean).length;
	// Structural markdown only. A backticked code identifier (`session.userId`) is
	// the one thing models reliably add and is harmless in a terminal recap, so it
	// is not counted against the "no markdown" instruction here.
	const hasMarkdown = /\*\*|^#{1,6}\s|^\s*[-•]\s|\[[^\]]+\]\([^)]+\)/m.test(text);
	const nonEmpty = text.length > 0;
	const reasonableLength = words > 0 && words <= 60; // 40 is the ask; allow slack

	const ok = nonEmpty && reasonableLength && !hasMarkdown;
	if (!ok) failures++;

	console.log(`\n${ok ? "PASS" : "FAIL"}  ${testCase.name}  (${ms}ms, ${words} words)`);
	console.log(`   ${text}`);
	if (hasMarkdown) console.log("   ^ contained structural markdown, which the prompt forbids");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
