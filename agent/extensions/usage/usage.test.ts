/**
 * Unit tests for the usage extension.
 *
 * Run with:
 *   node --experimental-transform-types agent/extensions/usage/usage.test.ts
 *
 * The interesting cases are all about UNDERCOUNTING: every bug this can have
 * makes the session look cheaper than it was, which is the one direction a cost
 * report must never be wrong in.
 */

import { existsSync } from "node:fs";
import { AnnouncedSpendLog, billedTokens, cacheHitPercent, collectUsage, emptyTotals, withAnnounced } from "./collect.ts";
import { formatCost, formatTokens, plainUsage } from "./render.ts";

let failures = 0;

function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) {
		console.log(`      got=${JSON.stringify(got)}`);
		console.log(`     want=${JSON.stringify(want)}`);
	}
}

const usageBlock = (input: number, output: number, cost: number, extra: Record<string, unknown> = {}) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	totalTokens: input + output,
	...extra,
});

const assistant = (provider: string, model: string, usage: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message",
	timestamp: "2026-07-29T10:00:00.000Z",
	message: { role: "assistant", provider, model, usage, ...extra },
});

console.log("--- collect: the obvious case ---");
{
	const usage = collectUsage([
		{ type: "message", timestamp: "2026-07-29T10:00:00.000Z", message: { role: "user", content: "hi" } },
		assistant("openai-codex", "gpt-5.6-sol", usageBlock(1000, 200, 0.05)),
		assistant("openai-codex", "gpt-5.6-sol", usageBlock(500, 100, 0.02)),
	]);
	check("one row per model", usage.models.length, 1);
	check("its calls are summed", usage.models[0]!.totals.calls, 2);
	check("and its cost", Number(usage.models[0]!.totals.cost.toFixed(4)), 0.07);
	check("the label carries the provider", usage.models[0]!.label, "openai-codex/gpt-5.6-sol");
	check("user messages are turns", usage.turns, 1);
	check("nothing failed", usage.failed, 0);
	check("the total matches the only row", usage.total.cost, usage.models[0]!.totals.cost);
}

console.log("\n--- collect: the spend the transcript hides ---");
{
	// Every one of these is a real model call that is NOT an assistant message,
	// which is exactly why summing assistant messages undercounts.
	const usage = collectUsage([
		assistant("openai-codex", "gpt-5.6-sol", usageBlock(1000, 200, 0.05)),
		{
			type: "message",
			timestamp: "2026-07-29T10:01:00.000Z",
			message: { role: "toolResult", toolName: "workflow", isError: false, usage: usageBlock(40_000, 8000, 1.5) },
		},
		{ type: "compaction", timestamp: "2026-07-29T10:02:00.000Z", summary: "…", usage: usageBlock(120_000, 2000, 0.4) },
		{ type: "branch_summary", timestamp: "2026-07-29T10:03:00.000Z", summary: "…", usage: usageBlock(5000, 300, 0.02) },
	]);
	check("the tool is its own row", usage.tools.map((row) => row.label), ["workflow"]);
	check("compaction and branch summary both counted", usage.overhead.map((row) => row.label), ["compaction", "branch summary"]);
	check("the total is all four", Number(usage.total.cost.toFixed(4)), 1.97);
	check("and it is not just the assistant message", usage.total.cost > usage.models[0]!.totals.cost, true);
}

console.log("\n--- collect: a tool result without usage is not a call ---");
{
	// Almost every tool result has no usage — read, bash, grep. Counting them
	// would put a "tool" row with 200 calls and $0.00 at the bottom of the table.
	const usage = collectUsage([
		{ type: "message", message: { role: "toolResult", toolName: "read", isError: false } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", isError: false } },
	]);
	check("no tool rows", usage.tools.length, 0);
	check("no phantom calls", usage.total.calls, 0);
}

console.log("\n--- collect: a compaction pi did not pay for ---");
{
	const usage = collectUsage([{ type: "compaction", summary: "…", firstKeptEntryId: "x", tokensBefore: 100 }]);
	check("an entry with no usage adds no row", usage.overhead.length, 0);
}

console.log("\n--- collect: errors and interrupts ---");
{
	const usage = collectUsage([
		assistant("anthropic", "claude-haiku-4-5", usageBlock(100, 0, 0.001), { stopReason: "error" }),
		assistant("anthropic", "claude-haiku-4-5", usageBlock(100, 50, 0.002), { stopReason: "aborted" }),
		assistant("anthropic", "claude-haiku-4-5", usageBlock(100, 50, 0.002), { stopReason: "stop" }),
	]);
	check("failures are counted", usage.failed, 2);
	// A call that errored was still billed for whatever it consumed.
	check("but their spend still counts", Number(usage.total.cost.toFixed(4)), 0.005);
	check("and so do their calls", usage.total.calls, 3);
}

console.log("\n--- collect: ordering and totals ---");
{
	const usage = collectUsage([
		assistant("cheap", "small", usageBlock(100, 10, 0.001)),
		assistant("dear", "large", usageBlock(100, 10, 5)),
		assistant("free", "local", usageBlock(9_000_000, 10, 0)),
	]);
	check("costliest first", usage.models.map((row) => row.label), ["dear/large", "cheap/small", "free/local"]);

	const totals = emptyTotals();
	totals.input = 400;
	totals.cacheRead = 1200;
	totals.cacheWrite = 400;
	totals.output = 50;
	check("billed tokens include the cache", billedTokens(totals), 2050);
	check("cache hit share ignores output", Math.round(cacheHitPercent(totals)!), 60);
	check("no input means no share to report", cacheHitPercent(emptyTotals()), undefined);
}

console.log("\n--- collect: entries are the whole file, not one branch ---");
{
	// An abandoned fork was paid for. Sessions are stored as a tree and
	// getEntries() hands back all of it, so this only has to not filter.
	const usage = collectUsage([
		assistant("p", "m", usageBlock(100, 10, 0.1)),
		assistant("p", "m", usageBlock(100, 10, 0.1)),
		assistant("p", "m", usageBlock(100, 10, 0.1)),
	]);
	check("every call counted", usage.total.calls, 3);
	check("rewinding does not refund", Number(usage.total.cost.toFixed(4)), 0.3);
}

console.log("\n--- collect: workflow spend folded in ---");
{
	// ultracode announces pi's Usage FLATTENED — `cost` is a number here, where
	// every other source in this file nests it under `{ total }`. Reading the
	// wrong one is silent (`(12.5).total` is undefined, which folds in as zero),
	// so this fixture must stay the shape ultracode actually sends. An earlier
	// version of this test used `{ total: 12.5 }` and passed against code that
	// reported every workflow as free.
	const log = new AnnouncedSpendLog();
	log.add({ source: "workflows", calls: 40, usage: { input: 500_000, output: 40_000, cacheRead: 2_000_000, reasoning: 90_000, cost: 12.5 } });
	const base = collectUsage([assistant("p", "m", usageBlock(1000, 100, 0.05))]);
	const merged = withAnnounced(base, log.rows());
	check("an announced row appears", merged.announced?.map((row) => row.label), ["workflows"]);
	check("the flat cost is read", merged.announced?.[0]?.totals.cost, 12.5);
	check("and its tokens with it", [merged.announced?.[0]?.totals.input, merged.announced?.[0]?.totals.cacheRead], [500_000, 2_000_000]);
	check("reasoning is carried, not dropped", merged.announced?.[0]?.totals.reasoning, 90_000);
	check("calls come from the announcement", merged.announced?.[0]?.totals.calls, 40);
	check("the total includes it", Number(merged.total.cost.toFixed(2)), 12.55);
	check("the session's own total is untouched", Number(base.total.cost.toFixed(2)), 0.05);
	check("no announcements, no rows", withAnnounced(base, []).announced, undefined);

	// Increments, not snapshots: a second announcement from the same source adds
	// to the first rather than replacing it. recap fires repeatedly in one
	// session, so replacing would report only the most recent call.
	log.add({ source: "workflows", calls: 2, usage: { cost: 0.5 } });
	check("a second announcement accumulates", log.rows()[0]?.totals.cost, 13);
	check("and its calls with it", log.rows()[0]?.totals.calls, 42);

	// Sources are separate rows, so one producer cannot hide another.
	log.add({ source: "recap", usage: { cost: 0.02 } });
	check("a second source is its own row", log.rows().map((row) => row.label), ["workflows", "recap"]);
	check("calls default to one", log.rows()[1]?.totals.calls, 1);

	// Malformed announcements degrade rather than crash or corrupt the table.
	const junk = new AnnouncedSpendLog();
	junk.add(undefined);
	junk.add({ source: "", usage: { cost: 1 } } as never);
	check("a nameless announcement is ignored", junk.rows(), []);
	junk.add({ source: "odd", usage: {} });
	check("a spend block with nothing in it", junk.rows()[0]?.totals.cost, 0);

	check("reset clears the tally", (() => { log.reset(); return log.rows(); })(), []);

	// rows() is a SNAPSHOT. A /usage entry stores these and is re-rendered on
	// every redraw, so handing out the live Totals made an old report restate
	// itself with today's numbers over a total that never moved.
	const live = new AnnouncedSpendLog();
	live.add({ source: "workflows", usage: { input: 1000, cost: 0.1 } });
	const snapshot = withAnnounced(collectUsage([]), live.rows());
	const before = plainUsage(snapshot, {});
	live.add({ source: "workflows", usage: { input: 9000, cost: 5 } });
	check("a stored report does not move under it", plainUsage(snapshot, {}), before);
	check("while the log itself has moved on", live.rows()[0]?.totals.cost, 5.1);
	check("and the rows still sum to their own total", snapshot.announced?.[0]?.totals.cost, snapshot.total.cost);

	// Every field is coerced, not just cost: one non-numeric token count would
	// turn an accumulator into a string via `+` and stay broken for the session.
	const junky = new AnnouncedSpendLog();
	junky.add({ source: "x", usage: { input: "1200", output: null, cost: 0.02 } } as never);
	junky.add({ source: "x", usage: { input: 300, cost: 0.01 } });
	check("a string token count does not poison the sum", junky.rows()[0]?.totals.input, 300);
	check("nor turn the type to string", typeof junky.rows()[0]?.totals.input, "number");
	check("and the good fields still land", Number(junky.rows()[0]?.totals.cost.toFixed(4)), 0.03);
}

console.log("\n--- collect: the announced shape is the one a real producer sends ---");
// Guards the contract end to end rather than against a fixture: this drives
// ultracode's real spawn accounting, so a change on either side fails here.
//
// The only place this extension reaches across to another, and it is a test
// reaching, not the extension — `usage` still installs on its own. Whether
// ultracode is present is decided by the FILESYSTEM, and the import itself is
// unguarded: catching ERR_MODULE_NOT_FOUND instead reported "not installed" for
// any missing specifier anywhere in ultracode's import graph, so a broken
// dependency of spawn.ts would silently retire the one guard against the
// flat-vs-nested `cost` bug and the suite would still be green.
const ultracodeSpawn = new URL("../ultracode/spawn.ts", import.meta.url);
const ultracode = existsSync(ultracodeSpawn) ? await import("../ultracode/spawn.ts") : undefined;
if (!ultracode) {
	console.log("SKIP  ultracode is not installed beside this extension");
} else {
	const { applyTurn, emptyUsage } = ultracode;
	// Exactly what tool.ts announces: one subagent turn's delta, flattened.
	const total = emptyUsage();
	const delta = applyTurn(total, {
		input: 1000,
		output: 200,
		cacheRead: 5000,
		reasoning: 150,
		cost: { total: 3.25 },
		totalTokens: 6200,
	});
	const log = new AnnouncedSpendLog();
	log.add({
		source: "workflows",
		calls: delta.turns,
		usage: {
			input: delta.input,
			output: delta.output,
			cacheRead: delta.cacheRead,
			cacheWrite: delta.cacheWrite,
			reasoning: delta.reasoning,
			cost: delta.cost,
		},
	});

	const merged = withAnnounced(collectUsage([]), log.rows());
	check("a real producer's payload lands as money", merged.announced?.[0]?.totals.cost, 3.25);
	check("and as tokens", merged.announced?.[0]?.totals.input, 1000);
	check("and as reasoning", merged.announced?.[0]?.totals.reasoning, 150);
	check("and as calls", merged.announced?.[0]?.totals.calls, 1);
	check("and reaches the grand total", merged.total.cost, 3.25);
}

console.log("\n--- render: formatting ---");
{
	check("small counts are exact", formatTokens(942), "942");
	check("thousands keep a decimal", formatTokens(9420), "9.4k");
	check("tens of thousands round", formatTokens(94_200), "94k");
	check("millions", formatTokens(9_420_000), "9.42M");
	check("cents matter when cents are the total", formatCost(0.0003), "$0.0003");
	check("and stop mattering past a hundred", formatCost(1284.5678), "$1284.57");
}

console.log("\n--- render: the table lines up ---");
{
	const log = new AnnouncedSpendLog();
	log.add({ source: "workflows", calls: 40, usage: { input: 900_000, output: 50_000, cost: 8 } });
	const usage = withAnnounced(
		collectUsage([
			{ type: "message", timestamp: "2026-07-29T10:00:00.000Z", message: { role: "user", content: "hi" } },
			assistant("openai-codex", "gpt-5.6-sol", usageBlock(1_200_000, 84_300, 12.3456, { cacheRead: 980_100 })),
			assistant("anthropic", "claude-haiku-4-5", usageBlock(23_400, 1200, 0.0231)),
			{ type: "compaction", timestamp: "2026-07-29T11:00:00.000Z", summary: "…", usage: usageBlock(140_000, 3100, 0.42) },
		]),
		log.rows(),
	);
	const text = plainUsage(usage, { sessionId: "019f89f7", contextTokens: 84_200, contextWindow: 272_000, contextPercent: 31, elapsedMs: 3_600_000 });
	const lines = text.split("\n");

	// Every table line is the same width, which is the only property that makes
	// a padded column table readable — and the first thing a new column breaks.
	const tableLines = lines.filter((line) => /^(Source|openai-codex|anthropic|compaction|workflows|Total|─)/.test(line));
	check("every table row is present", tableLines.length, 7);
	check("all the same width", new Set(tableLines.map((line) => line.length)).size, 1);

	check("the headline names the session", lines[0]!.includes("019f89f7"), true);
	check("and the turn count", lines[0]!.includes("1 turn"), true);
	check("the context meter is drawn", lines[1]!.startsWith("Context  ["), true);
	const total = tableLines.find((line) => line.startsWith("Total"))!;
	// 12.3456 + 0.0231 (models) + 0.42 (compaction) + 8 (workflows).
	check("the total is the sum of the rows", total.includes("$20.7887"), true);
	check("no line carries an escape sequence", /\x1b/.test(text), false);
}

console.log("\n--- render: nothing spent yet ---");
{
	const text = plainUsage(collectUsage([]), {});
	check("says so rather than drawing an empty table", text.includes("Nothing spent yet"), true);
	check("and has no total line", text.includes("Total"), false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
