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
import { AnnouncedSpendLog, billedTokens, cacheHitPercent, callsFor, collectUsage, emptyTotals, withAnnounced } from "./collect.ts";
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

console.log("\n--- collect: one tool result can be many calls ---");
{
	// The bug this pins: a `wait: true` workflow arrives as ONE tool result
	// carrying the aggregate spend of a whole fleet. Counted as one call, the
	// table put a `1` beside $5.20 in the same column as a `3` beside $3.30, and
	// the Total row added round trips to tool invocations.
	const usage = collectUsage([
		assistant("openai-codex", "gpt-5.6-sol", usageBlock(1000, 200, 0.05)),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "workflow",
				isError: false,
				details: { turns: 24 },
				usage: usageBlock(540_000, 30_000, 5.2),
			},
		},
	]);
	check("the fleet reports its real call count", usage.tools[0]?.totals.calls, 24);
	check("and the total is calls, not invocations", usage.total.calls, 25);
}

console.log("\n--- collect: what callsFor will and will not believe ---");
{
	// A tool that spent money made at least one call, so every unusable shape
	// falls back to 1 rather than to 0 — a zero would hide spend behind a row
	// that claims nothing happened.
	check("a positive integer is taken", callsFor({ turns: 12 }), 12);
	check("absent means one", callsFor({}), 1);
	check("no details at all means one", callsFor(undefined), 1);
	check("zero is not believed", callsFor({ turns: 0 }), 1);
	check("negative is not believed", callsFor({ turns: -5 }), 1);
	check("fractional is not believed", callsFor({ turns: 2.5 }), 1);
	check("a string is not believed", callsFor({ turns: "24" }), 1);
	check("neither is Infinity", callsFor({ turns: Number.POSITIVE_INFINITY }), 1);
	// ultracode's details is a whole progress object with turns lifted to the top.
	check("a fat details object still works", callsFor({ runId: "r1", phases: [], turns: 8 }), 8);
}

console.log("\n--- collect: one producer, one row, whichever route it took ---");
{
	// A synchronous workflow records on the tool result; a background one
	// announces. Same feature. It used to appear as `workflow (tool)` and
	// `workflows` in two different sections, and a *failed* synchronous run
	// silently moved between them.
	const log = new AnnouncedSpendLog();
	log.add({ source: "workflow", detail: "migrate-parser (14:03)", calls: 16, usage: { input: 288_000, cost: 2.8 } });

	const merged = withAnnounced(
		collectUsage([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "workflow",
					isError: false,
					details: { turns: 24 },
					usage: usageBlock(540_000, 30_000, 5.2),
				},
			},
		]),
		log.rows(),
	);

	check("they share one row", merged.tools.map((row) => row.label), ["workflow"]);
	check("no separate announced row is left over", merged.announced?.length, 0);
	check("calls are both routes added up", merged.tools[0]?.totals.calls, 40);
	check("and so is the money", Number(merged.tools[0]!.totals.cost.toFixed(4)), 8);
	// The synchronous run has no spendLabel here, so it produces no named child.
	// Its 24 calls used to vanish from the breakdown, leaving indented lines that
	// summed to less than their own parent — a reader adding them up concluded the
	// row cost $2.80 when it held $8.00. The remainder now gets its own line.
	check("the per-run breakdown survives the merge", merged.tools[0]?.children?.map((row) => row.label), [
		"migrate-parser (14:03)",
		"(unnamed runs)",
	]);
	check("and the remainder carries the unnamed run's calls", merged.tools[0]?.children?.[1]?.totals.calls, 24);
	check("and its money", Number(merged.tools[0]!.children![1]!.totals.cost.toFixed(4)), 5.2);
	check(
		"so the children sum to the parent",
		merged.tools[0]?.children?.reduce((sum, child) => sum + child.totals.calls, 0),
		merged.tools[0]?.totals.calls,
	);
	check("the grand total counts it exactly once", Number(merged.total.cost.toFixed(4)), 8);
	check("and the footnote still knows announcements happened", merged.hasAnnounced, true);
}

console.log("\n--- collect: a labelled run completes the breakdown ---");
{
	// With `details.spendLabel` the synchronous run gets its own line, and the
	// children finally add up to their parent. Children that do not sum to their
	// own total are a worse report than no children at all.
	const log = new AnnouncedSpendLog();
	log.add({ source: "workflow", detail: "migrate-parser (14:03)", calls: 16, usage: { input: 288_000, cost: 2.8 } });

	const merged = withAnnounced(
		collectUsage([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "workflow",
					isError: false,
					details: { turns: 24, spendLabel: "code-review (16:01)" },
					usage: usageBlock(540_000, 30_000, 5.2),
				},
			},
		]),
		log.rows(),
	);

	const row = merged.tools[0]!;
	check("both runs are named, costliest first", row.children?.map((child) => child.label), [
		"code-review (16:01)",
		"migrate-parser (14:03)",
	]);
	check("and the children sum to the parent's calls", row.children?.reduce((sum, child) => sum + child.totals.calls, 0), row.totals.calls);
	check("and to its money", Number(row.children!.reduce((sum, child) => sum + child.totals.cost, 0).toFixed(4)), Number(row.totals.cost.toFixed(4)));
}

console.log("\n--- collect: two results from the same run are one line ---");
{
	// Same label twice must add up, not appear twice at half the money each.
	const usage = collectUsage([
		{ type: "message", message: { role: "toolResult", toolName: "workflow", isError: false, details: { turns: 3, spendLabel: "sweep (10:00)" }, usage: usageBlock(100, 10, 1) } },
		{ type: "message", message: { role: "toolResult", toolName: "workflow", isError: false, details: { turns: 5, spendLabel: "sweep (10:00)" }, usage: usageBlock(100, 10, 2) } },
	]);
	check("one child line", usage.tools[0]?.children?.map((child) => child.label), ["sweep (10:00)"]);
	check("with both call counts", usage.tools[0]?.children?.[0]?.totals.calls, 8);
	check("and both costs", Number(usage.tools[0]!.children![0]!.totals.cost.toFixed(4)), 3);
}

console.log("\n--- collect: a lone child is dropped even with nothing announced ---");
{
	// The commonest shape there is: one synchronous workflow, no background runs.
	// pruning lived behind withAnnounced's early return, so this printed the run's
	// figures on two consecutive lines — reading as double the spend — and whether
	// it did depended on whether some *unrelated* extension happened to announce.
	const collected = collectUsage([
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "workflow",
				isError: false,
				details: { turns: 24, spendLabel: "code-review (16:01)" },
				usage: usageBlock(540_000, 30_000, 5.2),
			},
		},
	]);
	const alone = withAnnounced(collected, []);
	check("the duplicate line is gone", alone.tools[0]?.children, undefined);
	check("and the row itself is intact", alone.tools[0]?.totals.calls, 24);

	// With something else announcing, the same report must look the same.
	const log = new AnnouncedSpendLog();
	log.add({ source: "recap", calls: 3, usage: { cost: 0.036 } });
	const withOther = withAnnounced(collected, log.rows());
	check("and it does not reappear when an unrelated source spends", withOther.tools[0]?.children, undefined);
}

console.log("\n--- render: the provenance footnote survives an older stored entry ---");
{
	// /usage stores numbers, not drawings, and re-renders them later. An entry
	// written before `hasAnnounced` existed still has announced rows and no flag;
	// re-keying the footnote without a fallback silently presented in-memory-only
	// figures as if the session file corroborated them.
	const legacy = {
		...collectUsage([]),
		announced: [{ label: "workflows", totals: { ...emptyTotals(), calls: 40, cost: 8 } }],
	};
	const text = plainUsage(legacy, {});
	check("the older entry still warns", text.includes("announced by extensions"), true);
	check("a report with no announced spend does not", plainUsage(collectUsage([]), {}).includes("announced by extensions"), false);
}

console.log("\n--- collect: an announcement from a non-tool keeps its own row ---");
{
	// recap and goal announce but are not tools, so there is nothing to merge
	// into and they must not be swallowed.
	const log = new AnnouncedSpendLog();
	log.add({ source: "recap", calls: 3, usage: { input: 24_000, cost: 0.036 } });
	const merged = withAnnounced(collectUsage([]), log.rows());
	check("it stands alone", merged.announced?.map((row) => row.label), ["recap"]);
	check("with its calls intact", merged.announced?.[0]?.totals.calls, 3);
	check("and reaches the total", Number(merged.total.cost.toFixed(4)), 0.036);
}

console.log("\n--- collect: merging does not mutate what it merged ---");
{
	// The rows go into a stored /usage entry that re-renders on every redraw, and
	// the log keeps accumulating. Folding twice must not double anything.
	const log = new AnnouncedSpendLog();
	log.add({ source: "workflow", calls: 4, usage: { cost: 1 } });
	const collected = collectUsage([
		{ type: "message", message: { role: "toolResult", toolName: "workflow", isError: false, details: { turns: 2 }, usage: usageBlock(10, 10, 1) } },
	]);
	const first = withAnnounced(collected, log.rows());
	const second = withAnnounced(collected, log.rows());
	check("the source rows are untouched", collected.tools[0]?.totals.calls, 2);
	check("so a second fold matches the first", second.tools[0]?.totals.calls, first.tools[0]?.totals.calls);
	check("and the total does not creep", second.total.cost, first.total.cost);
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
	// An empty announcement list still runs the reconcile pass — that is the whole
	// point of dropping the early return — but must add no rows and must not claim
	// the report contains announced spend.
	check("no announcements, no rows", withAnnounced(base, []).announced, []);
	check("and no announced-spend footnote", withAnnounced(base, []).hasAnnounced, false);

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

	// Per-run rows. No /workflows surface prints a price any more, so "which of
	// these five cost $40" is answered here or nowhere.
	const perRun = new AnnouncedSpendLog();
	perRun.add({ source: "workflows", detail: "code-review (16:01)", calls: 24, usage: { input: 540_000, cost: 5.2 } });
	perRun.add({ source: "workflows", detail: "migrate-parser (14:03)", calls: 16, usage: { input: 360_000, cost: 2.8 } });
	perRun.add({ source: "recap", usage: { cost: 0.01 } });
	const [workflows, recap] = perRun.rows();
	check("the source row still totals them", Number(workflows?.totals.cost.toFixed(2)), 8);
	check("with a child per run, costliest first", workflows?.children?.map((row) => row.label), [
		"code-review (16:01)",
		"migrate-parser (14:03)",
	]);
	check("each carrying its own cost", workflows?.children?.map((row) => row.totals.cost), [5.2, 2.8]);
	check("and its own calls", workflows?.children?.map((row) => row.totals.calls), [24, 16]);
	check("no detail, no children", recap?.children, undefined);
	// A lone run that IS its parent earns no line. The log emits it regardless —
	// it cannot know whether the finished row will also hold a tool result's
	// spend — so the rule is applied by withAnnounced, against the real parent.
	const single = new AnnouncedSpendLog();
	single.add({ source: "workflows", detail: "only (09:00)", usage: { cost: 1 } });
	check("the log emits it", single.rows()[0]?.children?.length, 1);
	check("the report drops it", withAnnounced(collectUsage([]), single.rows()).announced?.[0]?.children, undefined);
	// Children are snapshots too, for the same reason the parents are.
	const snap = perRun.rows()[0]!.children![0]!.totals.cost;
	perRun.add({ source: "workflows", detail: "code-review (16:01)", usage: { cost: 99 } });
	check("children are copies", snap, 5.2);
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
	// The real source name, not a literal. The merge that keeps a workflow in ONE
	// row turns entirely on this string matching ultracode's tool name — rename
	// it back to "workflows" and the two-rows-in-two-sections confusion returns
	// silently, with every other test still green.
	const config = await import("../ultracode/config.ts");
	const source = config.SPEND_SOURCE;

	const log = new AnnouncedSpendLog();
	log.add({
		source,
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

	// The invariant itself: an announcement lands on the row of the tool that
	// made it, rather than beside it.
	const sameRow = withAnnounced(
		collectUsage([
			{
				type: "message",
				message: { role: "toolResult", toolName: "workflow", isError: false, details: { turns: 2 }, usage: usageBlock(10, 10, 1) },
			},
		]),
		log.rows(),
	);
	check("the announced source is the tool's own name", sameRow.tools.map((row) => row.label), ["workflow"]);
	check("so nothing is left standing beside it", sameRow.announced?.length, 0);
	check("and both routes are in one call count", sameRow.tools[0]?.totals.calls, 2 + delta.turns);

	// Fresh log for the standalone assertions below, so the row is only the
	// announcement and not the merge built above.
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
