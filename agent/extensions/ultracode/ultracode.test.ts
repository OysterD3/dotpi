/**
 * Offline tests for the ultracode extension's pure pieces: the keyword scanner
 * (cases derived from Claude Code's matcher) and the workflow script engine
 * (run against a fake spawner — no processes, no network).
 *
 * Run with jiti from any directory where pi's packages resolve (they are not
 * dependencies of this repo — e.g. a scratch dir with @earendil-works/pi-coding-agent
 * installed, or pi's own package dir):
 *     jiti agent/extensions/ultracode/ultracode.test.ts
 */
import { findKeyword, hasUltracodeKeyword } from "./keyword.ts";
import { conformsTo, extractJson, parseMeta, runWorkflowScript, type AgentOptions } from "./engine.ts";
import { UltracodeMode } from "./mode.ts";
import { resolveModelReference } from "./models.ts";
import { formatElapsed, panelLines, statusReport } from "./panel.ts";
import { newProgress, orphanedRunIds, RunRegistry, type WorkflowRun } from "./runs.ts";
import { safeStringify } from "./tool.ts";
import { ENTER_FULL, ENTER_SPARSE, EXIT } from "./reminders.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------- keyword

console.log("--- keyword: matches ---");
check("plain mention", hasUltracodeKeyword("use ultracode to review this"), true);
check("case-insensitive", hasUltracodeKeyword("ULTRACODE the whole repo"), true);
check("alone", hasUltracodeKeyword("ultracode"), true);
check("sentence-final period", hasUltracodeKeyword("do this with ultracode."), true);
check("after newline", hasUltracodeKeyword("fix the bug\nultracode"), true);
check("apostrophe earlier in text", hasUltracodeKeyword("don't skip it, ultracode this"), true);
check("between html tags", hasUltracodeKeyword("<b>ultracode</b>"), true);
check("comparison < is not a span", hasUltracodeKeyword("a < b and ultracode it"), true);

console.log("\n--- keyword: non-matches ---");
check("slash command", hasUltracodeKeyword("/ultracode"), false);
check("any slash-led message", hasUltracodeKeyword("/effort ultracode"), false);
check("backticked", hasUltracodeKeyword("what does `ultracode` do?"), false);
check("double-quoted", hasUltracodeKeyword('the word "ultracode" appears'), false);
check("single-quoted", hasUltracodeKeyword("the word 'ultracode' appears"), false);
check("parenthesised", hasUltracodeKeyword("that mode (ultracode) is odd"), false);
check("bracketed", hasUltracodeKeyword("see [ultracode] in the docs"), false);
check("braced", hasUltracodeKeyword("insert {ultracode} here"), false);
check("angle-tagged", hasUltracodeKeyword("the <ultracode> element"), false);
check("filename", hasUltracodeKeyword("open ultracode.ts please"), false);
check("path prefix", hasUltracodeKeyword("look in extensions/ultracode"), false);
check("hyphen suffix", hasUltracodeKeyword("an ultracode-style sweep"), false);
check("hyphen prefix", hasUltracodeKeyword("non-ultracode runs"), false);
check("question mark", hasUltracodeKeyword("should I use ultracode?"), false);
check("substring of a word", hasUltracodeKeyword("ultracoded output"), false);
check("inside code fence", hasUltracodeKeyword("```\nultracode\n```"), false);
check("empty", hasUltracodeKeyword(""), false);
check("unrelated", hasUltracodeKeyword("just fix the tests"), false);

console.log("\n--- keyword: positions ---");
check(
	"start/end offsets",
	findKeyword("run ultracode now", "ultracode"),
	[{ word: "ultracode", start: 4, end: 13 }],
);
check("multiple mentions", findKeyword("ultracode and ultracode", "ultracode").length, 2);

// ---------------------------------------------------------------------- meta

console.log("\n--- engine: parseMeta ---");
{
	const script = `export const meta = { name: 'x', description: 'braces { inside } strings', phases: [{ title: 'A' }] }\nreturn 1`;
	const { meta, body } = parseMeta(script);
	check("meta name", meta.name, "x");
	check("meta description keeps braces", meta.description, "braces { inside } strings");
	check("export stripped from body", body.startsWith("const meta"), true);
}
check(
	"missing meta throws",
	(() => {
		try {
			parseMeta("return 1");
			return "no-throw";
		} catch {
			return "threw";
		}
	})(),
	"threw",
);
check(
	"meta needs name and description",
	(() => {
		try {
			parseMeta("export const meta = { name: 'x' }");
			return "no-throw";
		} catch {
			return "threw";
		}
	})(),
	"threw",
);
check(
	"non-literal meta throws",
	(() => {
		try {
			parseMeta("export const meta = { name: f(), description: 'y' }");
			return "no-throw";
		} catch {
			return "threw";
		}
	})(),
	"threw",
);

// ------------------------------------------------------------- json plumbing

console.log("\n--- engine: schema helpers ---");
check("conformsTo object", conformsTo({ a: 1 }, { type: "object", required: ["a"] }), true);
check("conformsTo missing key", conformsTo({}, { type: "object", required: ["a"] }), false);
check("conformsTo rejects array-for-object", conformsTo([], { type: "object" }), false);
check("conformsTo array", conformsTo([1], { type: "array" }), true);
check("extractJson plain", extractJson('{"a":1}'), { a: 1 });
check("extractJson fenced", extractJson('Sure:\n```json\n{"a":1}\n```'), { a: 1 });
check("extractJson prose prefix", extractJson('the answer is {"a":1}'), { a: 1 });
check("extractJson trailing prose", extractJson('{"a":1}\nHope that helps!'), { a: 1 });
check("extractJson wrapped both sides", extractJson('Here: {"a":[1,{"b":"}"}]} — done.'), { a: [1, { b: "}" }] });
check(
	"extractJson garbage throws",
	(() => {
		try {
			extractJson("no json here");
			return "no-throw";
		} catch {
			return "threw";
		}
	})(),
	"threw",
);

// ----------------------------------------------------------------- run: fake

const META = `export const meta = { name: 't', description: 'test' }\n`;

function fakeHooks(replies: (prompt: string, options: AgentOptions, index: number, signal: AbortSignal) => string | Promise<string>) {
	const spawned: Array<{ prompt: string; options: AgentOptions }> = [];
	const logs: string[] = [];
	const phases: string[] = [];
	const lifecycle: Array<{ index: number; event: string; ok?: boolean }> = [];
	return {
		spawned,
		logs,
		phases,
		lifecycle,
		hooks: {
			spawn: async (prompt: string, options: AgentOptions, index: number, signal: AbortSignal) => {
				spawned.push({ prompt, options });
				return replies(prompt, options, index, signal);
			},
			agentStart: (index: number, _label: string, _phase: string | undefined) => void lifecycle.push({ index, event: "start" }),
			agentEnd: (index: number, ok: boolean) => void lifecycle.push({ index, event: "end", ok }),
			log: (message: string) => void logs.push(message),
			phase: (title: string) => void phases.push(title),
		},
	};
}

/** Watch for host-level unhandled rejections across an async block. */
async function withRejectionWatch(run: () => Promise<void>): Promise<number> {
	let unhandled = 0;
	const watcher = () => void unhandled++;
	process.on("unhandledRejection", watcher);
	try {
		await run();
		// Unhandled rejections surface on later ticks; give them time to land.
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		process.removeListener("unhandledRejection", watcher);
	}
	return unhandled;
}

console.log("\n--- engine: basic run ---");
{
	const f = fakeHooks(() => "pong");
	const run = await runWorkflowScript(`${META}phase('Go')\nlog('starting')\nconst a = await agent('ping')\nreturn { a }`, undefined, f.hooks);
	check("script return value", run.result, { a: "pong" });
	check("agent count", run.agentCount, 1);
	check("spawn saw prompt", f.spawned[0]?.prompt, "ping");
	check("phase recorded", f.phases, ["Go"]);
	check("log recorded", f.logs, ["starting"]);
}

console.log("\n--- engine: args and budget stub ---");
{
	const f = fakeHooks(() => "x");
	const run = await runWorkflowScript(
		`${META}return { got: args, total: budget.total, rem: budget.remaining() === Infinity }`,
		["a", "b"],
		f.hooks,
	);
	check("args pass through", run.result, { got: ["a", "b"], total: null, rem: true });
}

console.log("\n--- engine: parallel never rejects ---");
{
	const f = fakeHooks((prompt) => {
		if (prompt === "boom") throw new Error("kaput");
		return "ok";
	});
	const run = await runWorkflowScript(
		`${META}const r = await parallel([() => agent('fine'), () => { throw new Error('sync') }, () => agent('boom')])\nreturn r`,
		undefined,
		f.hooks,
	);
	// agent() swallows the spawn failure into null; the sync-throwing thunk also nulls.
	check("results with nulls", run.result, ["ok", null, null]);
	check("failure logged", f.logs.some((l) => l.includes("kaput")), true);
}

console.log("\n--- engine: pipeline semantics ---");
{
	const f = fakeHooks((prompt) => `saw:${prompt}`);
	const run = await runWorkflowScript(
		`${META}return await pipeline([10, 20], (prev, item, i) => agent('p' + prev), (prev, item, i) => ({ prev, item, i }))`,
		undefined,
		f.hooks,
	);
	check("stages chain with (prev, item, index)", run.result, [
		{ prev: "saw:p10", item: 10, i: 0 },
		{ prev: "saw:p20", item: 20, i: 1 },
	]);
}
{
	const f = fakeHooks(() => "ok");
	const run = await runWorkflowScript(
		`${META}return await pipeline([1, 2], (prev) => { if (prev === 1) throw new Error('drop'); return 'kept' }, (prev) => prev + '!')`,
		undefined,
		f.hooks,
	);
	check("throwing stage drops item, skips rest", run.result, [null, "kept!"]);
}

console.log("\n--- engine: schema retry ---");
{
	let calls = 0;
	const f = fakeHooks(() => (++calls === 1 ? "not json" : '{"bugs":[]}'));
	const run = await runWorkflowScript(
		`${META}return await agent('find', { schema: { type: 'object', required: ['bugs'] } })`,
		undefined,
		f.hooks,
	);
	check("retry then parse", run.result, { bugs: [] });
	check("two spawns", f.spawned.length, 2);
	check("retry prompt carries feedback", f.spawned[1]?.prompt.includes("previous reply could not be used"), true);
	check("retries share one lifecycle row", f.lifecycle, [
		{ index: 1, event: "start" },
		{ index: 1, event: "end", ok: true },
	]);
}
{
	const f = fakeHooks(() => "never json");
	const run = await runWorkflowScript(
		`${META}return await agent('find', { schema: { type: 'object', required: ['bugs'] } })`,
		undefined,
		f.hooks,
	);
	check("exhausted retries -> null", run.result, null);
}

console.log("\n--- engine: caps and aborts ---");
{
	const f = fakeHooks(() => "x");
	const outcome = await runWorkflowScript(
		`${META}return await parallel(new Array(5000).fill(0).map(() => () => agent('x')))`,
		undefined,
		f.hooks,
	).then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("4096") ? "capped" : "wrong-error"),
	);
	check("parallel item cap", outcome, "capped");
}
{
	const f = fakeHooks(() => "x");
	const outcome = await runWorkflowScript(
		`${META}for (let i = 0; i < 1001; i++) { const r = await agent('x'); if (r === null) return 'agent-null' }\nreturn 'done'`,
		undefined,
		f.hooks,
	).then(
		(run) => run.result,
		(error) => (error instanceof Error && error.message.includes("1000-agent") ? "capped" : "wrong-error"),
	);
	check("1000-agent backstop", outcome, "capped");
}
{
	const f = fakeHooks(() => "x");
	const controller = new AbortController();
	controller.abort();
	const outcome = await runWorkflowScript(`${META}return await agent('x')`, undefined, f.hooks, controller.signal).then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("aborted") ? "aborted" : "wrong-error"),
	);
	check("pre-aborted signal rejects", outcome, "aborted");
	check("no spawn after abort", f.spawned.length, 0);
}

console.log("\n--- engine: rejection safety ---");
{
	const f = fakeHooks(() => "x");
	let outcome: unknown;
	const unhandled = await withRejectionWatch(async () => {
		// agent(42) is invalid and its promise is never awaited: the run itself
		// must still succeed, and the host must see no unhandled rejection.
		const run = await runWorkflowScript(`${META}agent(42)\nreturn 'survived'`, undefined, f.hooks);
		outcome = run.result;
	});
	check("dropped invalid agent() does not reject the host", unhandled, 0);
	check("run still completes", outcome, "survived");
}
{
	// Abort while two agents run: the run must reject, the losers of the
	// Promise.all race must not surface as host unhandled rejections.
	const controller = new AbortController();
	const f = fakeHooks(
		(_prompt, _options, _index, signal) =>
			new Promise<string>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("killed")), { once: true });
			}),
	);
	let outcome = "";
	const unhandled = await withRejectionWatch(async () => {
		const run = runWorkflowScript(
			`${META}return await parallel([() => agent('a'), () => agent('b')])`,
			undefined,
			f.hooks,
			controller.signal,
		);
		setTimeout(() => controller.abort(), 10);
		outcome = await run.then(
			() => "no-throw",
			(error) => (error instanceof Error && error.message.includes("aborted") ? "aborted" : `wrong: ${error}`),
		);
	});
	check("abort mid-parallel fails the run", outcome, "aborted");
	check("no unhandled rejections from the race", unhandled, 0);
}
{
	// A script that abandons a slow agent: the run ends, the abandoned agent is
	// cancelled via its signal rather than left running.
	let sawAbort = false;
	const f = fakeHooks(
		(_prompt, _options, _index, signal) =>
			new Promise<string>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						sawAbort = true;
						resolve("cancelled");
					},
					{ once: true },
				);
			}),
	);
	const unhandled = await withRejectionWatch(async () => {
		const run = await runWorkflowScript(`${META}agent('slow')\nreturn 'done'`, undefined, f.hooks);
		check("run returns without waiting on the orphan", run.result, "done");
	});
	check("orphaned agent was cancelled", sawAbort, true);
	check("orphan produced no unhandled rejection", unhandled, 0);
}
{
	// The 1000-agent cap must fail the run even when agent() is called through
	// parallel(), which nulls ordinary failures.
	const f = fakeHooks(() => "x");
	const outcome = await runWorkflowScript(
		`${META}
for (let round = 0; round < 2; round++) {
  await parallel(new Array(600).fill(0).map(() => () => agent('x')))
}
return 'never'`,
		undefined,
		f.hooks,
	).then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("1000-agent") ? "capped" : `wrong: ${error}`),
	);
	check("agent cap propagates through parallel", outcome, "capped");
}

console.log("\n--- engine: nested workflow() refused ---");
{
	const f = fakeHooks(() => "x");
	const outcome = await runWorkflowScript(`${META}workflow('other')\nreturn 1`, undefined, f.hooks).then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("not supported") ? "refused" : "wrong-error"),
	);
	check("workflow() throws", outcome, "refused");
}

console.log("\n--- engine: concurrency is bounded ---");
{
	let active = 0;
	let peak = 0;
	const f = fakeHooks(async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return "x";
	});
	await runWorkflowScript(
		`${META}await parallel(new Array(40).fill(0).map(() => () => agent('x')))\nreturn 1`,
		undefined,
		f.hooks,
	);
	check("peak concurrency <= 16", peak <= 16, true);
	check("all 40 ran", f.spawned.length, 40);
}

console.log("\n--- engine: cancel interrupts a sleeping script ---");
{
	const f = fakeHooks(() => "x");
	const controller = new AbortController();
	const startedAt = Date.now();
	const run = runWorkflowScript(
		`${META}await new Promise((resolve) => setTimeout(resolve, 5000))\nreturn 'slept'`,
		undefined,
		f.hooks,
		controller.signal,
	);
	setTimeout(() => controller.abort(), 30);
	const outcome = await run.then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("aborted") ? "aborted" : `wrong: ${error}`),
	);
	check("sleeping script cancelled", outcome, "aborted");
	check("cancellation was prompt", Date.now() - startedAt < 2000, true);
}

// ------------------------------------------------------------ model resolver

console.log("\n--- models: reference resolution ---");
{
	const MODELS = [
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "anthropic", id: "claude-sonnet-5-20250929", name: "Sonnet 5 (dated)" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" },
		{ provider: "anthropic", id: "claude-fable-5", name: "Fable 5" },
		{ provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
	];
	const resolve = (reference: string) => {
		const outcome = resolveModelReference(reference, MODELS);
		return outcome.ok ? `${outcome.model.provider}/${outcome.model.id}` : `error:${outcome.error.includes("matches") ? "ambiguous" : "none"}`;
	};
	check("canonical provider/id", resolve("anthropic/claude-sonnet-5"), "anthropic/claude-sonnet-5");
	check("bare exact id", resolve("claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
	check('"sonnet" prefers the alias over the dated id', resolve("sonnet"), "anthropic/claude-sonnet-5");
	check('"fable" resolves by name', resolve("fable"), "anthropic/claude-fable-5");
	check('"mini" resolves by partial id', resolve("mini"), "openai-codex/gpt-5.4-mini");
	check('"claude" is ambiguous', resolve("claude"), "error:ambiguous");
	check("unknown reference errors", resolve("nope"), "error:none");
	check("case-insensitive", resolve("SONNET"), "anthropic/claude-sonnet-5");
}

// ------------------------------------------------------------ runs and panel

console.log("\n--- runs: registry ---");
{
	const registry = new RunRegistry();
	const makeRun = (status: "running" | "done"): WorkflowRun => {
		const progress = newProgress(registry.nextId(), "r");
		progress.status = status;
		return { progress, controller: new AbortController(), startedAt: 0, settled: Promise.resolve() };
	};
	const running = makeRun("running");
	registry.add(running);
	check("active lists running runs", registry.active().length, 1);
	check("cancel running", registry.cancel(running.progress.runId), "cancelled");
	check("cancel aborts the controller", running.controller.signal.aborted, true);
	running.progress.status = "done";
	check("cancel finished run", registry.cancel(running.progress.runId), "not-running");
	check("cancel unknown run", registry.cancel("wf-99"), "unknown");
	const stillRunning = makeRun("running");
	registry.add(stillRunning);
	for (let i = 0; i < 8; i++) registry.add(makeRun("done"));
	// 9 finished runs pruned to 5; the running one is never pruned.
	check("finished runs pruned to the last 5", registry.all().length, 6);
	check("running run survives pruning", registry.get(stillRunning.progress.runId) !== undefined, true);
}

console.log("\n--- runs: orphaned background runs in a resumed branch ---");
{
	const started = (id: string) => ({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: `Workflow "audit" started in the background (id: ${id}).` }] },
	});
	const finished = (id: string) => ({
		type: "custom_message",
		customType: "workflow-result",
		content: `Workflow "audit" (${id}) finished: 3 agents, 6 turns, $0.10.`,
	});
	const cancelled = (id: string) => ({
		type: "custom_message",
		customType: "workflow-result",
		content: `Workflow "audit" (${id}) was cancelled after 1 agent ($0.01): workflow aborted`,
	});
	check("start with no result is orphaned", orphanedRunIds([started("wf-1")]), ["wf-1"]);
	check("finished run is not orphaned", orphanedRunIds([started("wf-1"), finished("wf-1")]), []);
	check("cancelled run is not orphaned", orphanedRunIds([started("wf-2"), cancelled("wf-2")]), []);
	check(
		"only the unresolved one is reported",
		orphanedRunIds([started("wf-1"), finished("wf-1"), started("wf-2")]),
		["wf-2"],
	);
	check("no workflow traffic -> none", orphanedRunIds([{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]), []);
	check("empty branch -> none", orphanedRunIds([]), []);
}

console.log("\n--- tool: safeStringify ---");
{
	const items = [{ id: 1 }, { id: 2 }];
	check(
		"shared reference is NOT a cycle",
		JSON.parse(safeStringify({ items, best: items[0] })),
		{ items: [{ id: 1 }, { id: 2 }], best: { id: 1 } },
	);
	check(
		"same object three times serializes fully",
		JSON.parse(safeStringify([{ v: 7 }, { v: 7 }])),
		[{ v: 7 }, { v: 7 }],
	);
	const cyclic: Record<string, unknown> = { name: "root" };
	cyclic.self = cyclic;
	check("true cycle is replaced", JSON.parse(safeStringify(cyclic)), { name: "root", self: "[circular]" });
	const deep: any = { a: { b: { c: {} } } };
	deep.a.b.c.back = deep.a;
	check("deep cycle is replaced", JSON.parse(safeStringify(deep)), { a: { b: { c: { back: "[circular]" } } } });
	const selfArray: unknown[] = [1];
	selfArray.push(selfArray);
	check("array cycle is replaced", JSON.parse(safeStringify(selfArray)), [1, "[circular]"]);
	check("bigint becomes a string", JSON.parse(safeStringify({ n: 10n })), { n: "10" });
	check("undefined result", safeStringify(undefined), "(the script returned no value)");
}

console.log("\n--- panel ---");
{
	check("elapsed seconds", formatElapsed(42_000), "42s");
	check("elapsed minutes", formatElapsed(65_000), "1m05s");
	check("elapsed hours", formatElapsed(3_720_000), "1h02m");
	check("no runs -> panel hidden", panelLines([], 0), undefined);

	const progress = newProgress("wf-1", "review");
	progress.phases.push({ title: "Find", agents: [{ label: "a", status: "done" }, { label: "b", status: "running" }] });
	progress.usage.cost = 0.1234;
	const run: WorkflowRun = { progress, controller: new AbortController(), startedAt: 0, settled: Promise.resolve() };
	const lines = panelLines([run], 65_000)!;
	check("panel line carries id, phases, cost, elapsed", lines[0], "◆ wf-1 review  Find 1/2  1 running  $0.1234  1m05s");
	check("panel hint line", lines.at(-1)?.includes("/workflows"), true);
	check("status report includes finished shape", statusReport([run], 65_000).startsWith("◆ wf-1 review — Find 1/2"), true);
	check("status report empty message", statusReport([], 0), "No workflows in this session.");
}

// ------------------------------------------------------------- mode cadence

console.log("\n--- mode: reminder cadence ---");
{
	const mode = new UltracodeMode();
	check("off by default", mode.isOn(), false);
	check("off -> no reminder", mode.reminderForTurn(), null);
	mode.enable();
	check("first turn on -> full", mode.reminderForTurn(), ENTER_FULL);
	const quiet: Array<string | null> = [];
	for (let i = 0; i < 9; i++) quiet.push(mode.reminderForTurn());
	check("turns 2-10 quiet", quiet.every((r) => r === null), true);
	check("turn 11 -> sparse", mode.reminderForTurn(), ENTER_SPARSE);
	check("turn 12 quiet again", mode.reminderForTurn(), null);
	mode.disable();
	check("first turn off -> exit", mode.reminderForTurn(), EXIT);
	check("exit only once", mode.reminderForTurn(), null);
}
{
	const mode = new UltracodeMode();
	mode.enable();
	mode.disable();
	check("on/off with no turn -> no exit reminder", mode.reminderForTurn(), null);
}
{
	const mode = new UltracodeMode();
	mode.enable();
	check("announce", mode.reminderForTurn(), ENTER_FULL);
	mode.disable();
	mode.enable(); // exit reminder never delivered: resume silently
	check("re-enable before exit delivered stays quiet", mode.reminderForTurn(), null);
}
{
	const mode = new UltracodeMode();
	mode.enable();
	mode.reminderForTurn();
	mode.disable();
	check("exit delivered", mode.reminderForTurn(), EXIT);
	mode.enable();
	check("fresh enable re-announces in full", mode.reminderForTurn(), ENTER_FULL);
}
{
	const mode = new UltracodeMode();
	mode.restore({ on: true, announced: true, turnsSinceReminder: 9, exitPending: false });
	check("restored state continues cadence", mode.reminderForTurn(), ENTER_SPARSE);
}
{
	const mode = new UltracodeMode();
	mode.restore({ on: false, announced: true, turnsSinceReminder: 0, exitPending: true });
	check("restored pending exit is delivered", mode.reminderForTurn(), EXIT);
	check("and only once", mode.reminderForTurn(), null);
}
{
	const mode = new UltracodeMode();
	mode.restore({ on: true, announced: true, turnsSinceReminder: 0, exitPending: true });
	check("exitPending ignored while on", mode.reminderForTurn(), null);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
