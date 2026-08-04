/**
 * Tests for context-diet.
 *
 * Two of these matter more than the rest, and they are the two invariants the
 * extension is built on:
 *
 *   "pairing survives"  — a dropped result is replaced, not removed. Drop the
 *   message and every subsequent request is rejected by the provider for having
 *   a tool call with no result, which would look like a provider outage rather
 *   than a bug in here.
 *
 *   "stubs are stable"  — the same eviction renders the same bytes twice. This
 *   is the difference between saving money and burning it: the prompt cache
 *   invalidates from the first differing byte, so a stub that drifted would
 *   push the whole context back to the uncached rate on every call.
 *
 * Everything asserted here is reachable without pi's runtime — the modules
 * under test import pi only for types, and the one file that needs the TUI
 * (render.ts) holds nothing but a Text constructor. So unlike the other
 * extensions in this repo, this suite runs from a bare checkout:
 *
 *     jiti agent/extensions/context-diet/context-diet.test.ts
 */
import { DEFAULT_SETTINGS, resolveSettings } from "./config.ts";
import {
	applyDiet,
	collectCandidates,
	describeCall,
	dietLine,
	type EvictionRecord,
	formatBytes,
	formatTokens,
	indexCallLabels,
	planDiet,
	resolveBounds,
	stubText,
} from "./diet.ts";
import { createDiet } from "./session.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

/** Stands in for AgentMessage; the fixtures below only fill the fields the diet reads. */
type Msg = any;

const assistant = (calls: { id: string; name: string; arguments: unknown }[]): Msg => ({
	role: "assistant",
	content: calls.map((c) => ({ type: "toolCall", ...c })),
	timestamp: 0,
});

const result = (id: string, toolName: string, text: string, opts: { isError?: boolean; image?: number } = {}): Msg => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	isError: opts.isError ?? false,
	timestamp: 0,
	content: [{ type: "text", text }, ...(opts.image ? [{ type: "image", data: "x".repeat(opts.image), mimeType: "image/png" }] : [])],
});

/** n read calls and their results, each body `bodyBytes` long. */
function conversation(n: number, bodyBytes = 40_000, opts: { image?: number; errorAt?: number[] } = {}): Msg[] {
	const messages: Msg[] = [];
	for (let i = 0; i < n; i++) {
		messages.push(assistant([{ id: `call_${i}`, name: "read", arguments: { file_path: `src/file-${i}.ts` } }]));
		messages.push(
			result(`call_${i}`, "read", "b".repeat(bodyBytes), {
				isError: opts.errorAt?.includes(i),
				image: opts.image,
			}),
		);
	}
	return messages;
}

const SETTINGS = { ...DEFAULT_SETTINGS, keepRecentResults: 4, keepImages: 2, minResultBytes: 512 };

console.log("--- sizing and labels ---");
check("bytes format at each scale", [formatBytes(812), formatBytes(43_500), formatBytes(2_100_000)], ["812 B", "42.5 KB", "2.0 MB"]);
check("read labelled by path", describeCall("read", { file_path: "src/App.tsx" }), "read src/App.tsx");
check("bash labelled by command", describeCall("bash", { command: "pnpm test" }), "bash pnpm test");
// A 400-line command in a stub would cost more than the output it replaced.
check("long args are clipped", describeCall("bash", { command: "x".repeat(200) }).length <= 70, true);
// Newlines would break the one-line stub into many.
check("newlines flattened", describeCall("bash", { command: "a\n\nb" }), "bash a b");
check("no args, bare name", describeCall("lsp_diagnostics", {}), "lsp_diagnostics");
check("labels come off the tool calls", indexCallLabels(conversation(2)).get("call_1"), "read src/file-1.ts");

console.log("\n--- what a round selects ---");
{
	const messages = conversation(10);
	const candidates = collectCandidates(messages, new Map(), SETTINGS, indexCallLabels(messages));
	check("newest keepRecentResults are spared", candidates.length, 6);
	check("oldest first", [candidates[0].toolCallId, candidates.at(-1)?.toolCallId], ["call_0", "call_5"]);
	check("savings are net of the stub", candidates[0].savedTokens < 10_000 && candidates[0].savedTokens > 9_000, true);
}
{
	const messages = conversation(10, 40_000, { errorAt: [1] });
	const ids = collectCandidates(messages, new Map(), SETTINGS, indexCallLabels(messages)).map((c) => c.toolCallId);
	// A failure the model has not reacted to yet is the last thing to take away.
	check("errors are never dropped", ids.includes("call_1"), false);
}
{
	const messages = conversation(6, 200);
	check("bodies under minResultBytes left alone", collectCandidates(messages, new Map(), SETTINGS, indexCallLabels(messages)).length, 0);
}
{
	// Six screenshots, all inside a keepRecentResults window of 8: the image rule
	// has to reach into the recent window or a burst never gets cleaned up.
	const messages = conversation(6, 300, { image: 200_000 });
	const wide = { ...SETTINGS, keepRecentResults: 8, keepImages: 2 };
	const ids = collectCandidates(messages, new Map(), wide, indexCallLabels(messages)).map((c) => c.toolCallId);
	check("stale screenshots go despite being recent", ids, ["call_0", "call_1", "call_2", "call_3"]);
	check("newest keepImages survive", [ids.includes("call_4"), ids.includes("call_5")], [false, false]);

	// slice(-0) is slice(0), so a naive implementation reads keepImages: 0 as
	// "keep all of them" — the exact inverse of what the setting says.
	const none = { ...SETTINGS, keepRecentResults: 8, keepImages: 0 };
	check("keepImages: 0 keeps none, not all", collectCandidates(messages, new Map(), none, indexCallLabels(messages)).length, 6);
}
{
	const messages = conversation(10);
	const already = new Map<string, EvictionRecord>([["call_0", { toolCallId: "call_0", label: "read x", bytes: 10, savedTokens: 1 }]]);
	const ids = collectCandidates(messages, already, SETTINGS, indexCallLabels(messages)).map((c) => c.toolCallId);
	check("already-dropped are not re-selected", ids.includes("call_0"), false);
}

console.log("\n--- thresholds ---");
check("bounds from ratios", resolveBounds(272_000, DEFAULT_SETTINGS), { highWater: 217_600, target: 149_600 });
check("absolute overrides win", resolveBounds(272_000, { ...DEFAULT_SETTINGS, highWaterTokens: 200_000, targetTokens: 100_000 }), {
	highWater: 200_000,
	target: 100_000,
});
// A target above the high-water mark would re-trigger every call — the one
// configuration that costs more than it saves.
check("target forced below high water", resolveBounds(100_000, { ...DEFAULT_SETTINGS, highWaterTokens: 50_000, targetTokens: 90_000 }), {
	highWater: 50_000,
	target: 45_000,
});
check(
	"under the mark, no round",
	planDiet({ messages: conversation(10), evicted: new Map(), currentTokens: 100_000, contextWindow: 272_000, settings: SETTINGS }),
	null,
);
check(
	"disabled means never",
	planDiet({
		messages: conversation(40),
		evicted: new Map(),
		currentTokens: 260_000,
		contextWindow: 272_000,
		settings: { ...SETTINGS, enabled: false },
	}),
	null,
);
{
	const messages = conversation(40);
	const plan = planDiet({ messages, evicted: new Map(), currentTokens: 260_000, contextWindow: 272_000, settings: SETTINGS });
	check("a round happens", plan !== null, true);
	check("it stops at the target, not below", plan!.toTokens <= 149_600 && plan!.toTokens > 130_000, true);
	// Hysteresis is the whole reason rounds stay rare. Landing at the high-water
	// mark instead of the target would mean a round on every subsequent call.
	check("it lands well under the high-water mark", plan!.toTokens < 217_600 * 0.8, true);
	check("oldest went first", plan!.records[0].toolCallId, "call_0");
}
{
	// Nothing evictable left: everything is inside the recent window.
	const messages = conversation(3);
	check(
		"no candidates, no plan",
		planDiet({ messages, evicted: new Map(), currentTokens: 260_000, contextWindow: 272_000, settings: SETTINGS }),
		null,
	);
}

console.log("\n--- invariant: pairing survives ---");
{
	const messages = conversation(10);
	const plan = planDiet({ messages, evicted: new Map(), currentTokens: 260_000, contextWindow: 272_000, settings: SETTINGS })!;
	const evicted = new Map(plan.records.map((r) => [r.toolCallId, r]));
	const after = applyDiet(messages, evicted);

	check("same message count", after.length, messages.length);
	check(
		"same toolCallIds in the same order",
		after.filter((m: Msg) => m.role === "toolResult").map((m: Msg) => m.toolCallId),
		messages.filter((m: Msg) => m.role === "toolResult").map((m: Msg) => m.toolCallId),
	);
	check(
		"every tool call still has a result",
		after.filter((m: Msg) => m.role === "assistant").flatMap((m: Msg) => m.content.map((c: Msg) => c.id)).length,
		after.filter((m: Msg) => m.role === "toolResult").length,
	);
	const stub = after.find((m: Msg) => m.role === "toolResult" && m.toolCallId === "call_0") as Msg;
	check("dropped body is one text block", [stub.content.length, stub.content[0].type], [1, "text"]);
	check("stub names the file", stub.content[0].text.includes("read src/file-0.ts"), true);
	check("stub says how to get it back", stub.content[0].text.includes("Re-run the tool"), true);
	check("stub is far smaller than the body", stub.content[0].text.length < 200, true);
	const kept = after.find((m: Msg) => m.role === "toolResult" && m.toolCallId === "call_9") as Msg;
	check("survivors are untouched", kept.content[0].text.length, 40_000);
	check("input array is not mutated", (messages[1] as Msg).content[0].text.length, 40_000);
}

console.log("\n--- invariant: stubs are stable ---");
{
	const record: EvictionRecord = { toolCallId: "call_7", label: "read src/App.tsx", bytes: 43_500, savedTokens: 10_000 };
	check("same record, same bytes", stubText(record), stubText({ ...record }));
	const messages = conversation(10);
	const evicted = new Map([["call_0", record]]);
	const first = applyDiet(messages, evicted);
	const second = applyDiet(messages, evicted);
	check("same map, same render", JSON.stringify(first), JSON.stringify(second));
	// The context keeps growing between rounds; the stub for an old eviction must
	// not notice. If it did, the cache would break on every call, not every round.
	const later = applyDiet([...messages, ...conversation(3)], evicted);
	check("later calls render it identically", (later[1] as Msg).content[0].text, (first[1] as Msg).content[0].text);
}
{
	const messages = conversation(10);
	check("nothing evicted, array passed straight through", applyDiet(messages, new Map()) === messages, true);
}

console.log("\n--- settings ---");
check("empty block is all defaults", resolveSettings(undefined), DEFAULT_SETTINGS);
check("valid values are taken", resolveSettings({ keepImages: 8, targetRatio: 0.4 }).keepImages, 8);
check("out-of-range falls back", resolveSettings({ highWaterRatio: 4 }).highWaterRatio, DEFAULT_SETTINGS.highWaterRatio);
check("wrong type falls back", resolveSettings({ keepRecentResults: "lots" }).keepRecentResults, DEFAULT_SETTINGS.keepRecentResults);
// Rejected as a pair: honouring one half would silently produce a config the
// file does not describe.
check("inverted ratios rejected together", resolveSettings({ highWaterRatio: 0.4, targetRatio: 0.8 }), DEFAULT_SETTINGS);
check("enabled: false is honoured", resolveSettings({ enabled: false }).enabled, false);

console.log("\n--- across calls ---");
{
	const diet = createDiet(SETTINGS);
	const messages = conversation(40);
	const first = diet.step({ messages, contextWindow: 272_000, reportedTokens: 260_000 });
	check("a round reports itself once", first.entry !== undefined, true);
	check("and trims the request", first.messages !== undefined, true);

	// The next call sees the *trimmed* size, because pi anchors on what the
	// provider billed. Hysteresis has to hold here or every call is a round.
	const second = diet.step({ messages, contextWindow: 272_000, reportedTokens: first.entry!.toTokens });
	check("the next call is not another round", second.entry, undefined);
	check("but evictions are still applied", second.messages !== undefined, true);
	check("and identically", JSON.stringify(second.messages), JSON.stringify(first.messages));
	check("the set did not grow", diet.size, first.entry!.dropped);

	// Far below the mark now. Sticky means sticky: un-dropping would move the
	// cache's first mismatch backwards and re-bill everything after it.
	const third = diet.step({ messages, contextWindow: 272_000, reportedTokens: 40_000 });
	check("nothing comes back when context is small again", diet.size, first.entry!.dropped);
	check("stubs still render", JSON.stringify(third.messages), JSON.stringify(first.messages));
}
{
	const diet = createDiet(SETTINGS);
	const messages = conversation(40);
	check("under the mark, the request is left alone", diet.step({ messages, contextWindow: 272_000, reportedTokens: 50_000 }), {});
	check("no model, no window, no diet", diet.step({ messages, contextWindow: 0, reportedTokens: 900_000 }), {});
}
{
	// view() is how the size going into a call is measured: the standing set
	// applied, nothing decided. It must not evict on its own.
	const diet = createDiet(SETTINGS);
	const messages = conversation(40);
	check("view decides nothing", diet.view(messages) === messages, true);
	const step = diet.step({ messages, contextWindow: 272_000, reportedTokens: 260_000 });
	check("view then matches what step sends", JSON.stringify(diet.view(messages)), JSON.stringify(step.messages));
	check("and repeats without growing the set", [diet.view(messages).length, diet.size], [messages.length, step.entry!.dropped]);
}
{
	// null is what pi reports between a compaction and the next response.
	const diet = createDiet({ ...SETTINGS, highWaterTokens: 1_000, targetTokens: 500 });
	const step = diet.step({ messages: conversation(40), contextWindow: 272_000, reportedTokens: null });
	check("null falls back to the local estimate", step.entry !== undefined, true);
}
{
	const diet = createDiet(SETTINGS);
	const messages = conversation(40);
	diet.step({ messages, contextWindow: 272_000, reportedTokens: 260_000 });
	check("something was dropped", diet.size > 0, true);
	diet.reset();
	check("reset forgets it", diet.size, 0);
	check("and the request goes through whole", diet.step({ messages, contextWindow: 272_000, reportedTokens: 50_000 }), {});
}

console.log("\n--- the transcript line ---");
check("plural", dietLine({ dropped: 38, fromTokens: 221_400, toTokens: 149_100 }), "Context diet — dropped 38 stale results, 221k → 149k");
check("singular", dietLine({ dropped: 1, fromTokens: 1_000, toTokens: 900 }), "Context diet — dropped 1 stale result, 1k → 900");
check("token format", [formatTokens(999), formatTokens(1_500)], ["999", "2k"]);

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
