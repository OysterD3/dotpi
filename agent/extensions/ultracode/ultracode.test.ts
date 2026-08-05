/**
 * Offline tests for the ultracode extension's pure pieces: the keyword scanner
 * and the workflow script engine
 * (run against a fake spawner — no processes, no network).
 *
 * Run with jiti from any directory where pi's packages resolve (they are not
 * dependencies of this repo — e.g. a scratch dir with @earendil-works/pi-coding-agent
 * installed, or pi's own package dir):
 *     jiti agent/extensions/ultracode/ultracode.test.ts
 */
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { findKeyword, hasUltracodeKeyword } from "./keyword.ts";
import { parseAgentTypes } from "./agents.ts";
import { conformsTo, extractJson, parseMeta, runWorkflowScript, validateScript, type AgentOptions } from "./engine.ts";
import { branchSections, buildContextBundle, renderParent } from "./context.ts";
import { agentKey, ReplayIndex, shellKey, stableStringify } from "./journal.ts";
import { CONFIG, DEFAULT_SETTINGS } from "./config.ts";
import { SUBAGENT_PREAMBLE } from "./description.ts";
import { hasMessageSinceLastUserTurn, UltracodeMode } from "./mode.ts";
import { resolveModelReference } from "./models.ts";
import { formatElapsed, interruptedNotice, panelLines, progressFromJournal, sessionRuns, spendRuns, startedLabel, statusReport } from "./panel.ts";
import {
	allAgentsFailed,
	newProgress,
	PauseGate,
	RunRegistry,
	tallyAgents,
	type AgentRow,
	type WorkflowRun,
} from "./runs.ts";
import { addUsage, applyTurn, buildArgs, emptyUsage, scrubArg, stderrDetail, type ReportedUsage } from "./spawn.ts";
import {
	agentSessionId,
	countToolCalls,
	createRun,
	isSettled,
	listRuns,
	newRunId,
	pruneRuns,
	readAgentPrompt,
	readMeta,
	reconcile,
	appendJournalLine,
	readJournalLines,
	sharedSessionId,
	unresumedInterrupted,
	type RunMeta,
	sessionActivity,
} from "./store.ts";
import { EDIT_STREAK_TOOLS, EditStreak, restoreEditStreak } from "./streak.ts";
import { resolveScript, resolveThinking, safeStringify, WORKFLOW_TOOL_NAME } from "./tool.ts";
import {
	agentStatusIcon,
	clipKeepingTail,
	isAgentSettled,
	ORPHAN_TICKS,
	packHints,
	SPLIT_MIN_WIDTH,
	WorkflowsPanel,
	zipColumns,
	type PanelResult,
} from "./tui.ts";
import { editStreakReminder, ENTER_FULL, ENTER_SPARSE, EXIT, routingReminder } from "./reminders.ts";
import { findModelMentions, modelVocabulary } from "./routing.ts";

/** The session the panel fixtures below belong to. */
const SESSION = "sess-under-test";

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
	// parallel() used to refuse more than 4096 items. There is no cap now, so a
	// call that would once have been rejected outright simply runs.
	const outcome = await runWorkflowScript(
		`${META}return (await parallel(new Array(4200).fill(0).map(() => () => agent('x')))).length`,
		undefined,
		f.hooks,
	).then(
		(run) => run.result,
		(error) => `threw: ${error}`,
	);
	check("parallel() takes any number of items", outcome, 4200);
	check("and every one of them ran", f.spawned.length, 4200);
}
{
	const f = fakeHooks(() => "x");
	// The 1000-agent runaway backstop is gone too: a run may start as many
	// agents as its script asks for.
	const outcome = await runWorkflowScript(
		`${META}for (let i = 0; i < 1001; i++) { const r = await agent('x'); if (r === null) return 'agent-null' }\nreturn 'done'`,
		undefined,
		f.hooks,
	).then(
		(run) => run.result,
		(error) => `threw: ${error}`,
	);
	check("no cap on agents per run", outcome, "done");
	check("all 1001 spawned", f.spawned.length, 1001);
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
	// The same, through parallel(), which is where the old cap surfaced as a
	// fatal rather than a nulled thunk. Two rounds of 600 is 1200 agents.
	const f = fakeHooks(() => "x");
	const outcome = await runWorkflowScript(
		`${META}
for (let round = 0; round < 2; round++) {
  await parallel(new Array(600).fill(0).map(() => () => agent('x')))
}
return 'done'`,
		undefined,
		f.hooks,
	).then(
		(run) => run.result,
		(error) => `threw: ${error}`,
	);
	check("nor through parallel", outcome, "done");
	check("all 1200 spawned", f.spawned.length, 1200);
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

console.log("\n--- engine: concurrency is unbounded ---");
{
	// This is the change, stated as a number. The semaphore used to hold peak at
	// min(16, cores - 2) and queue the rest; every agent a script starts now
	// starts immediately, so 40 items in one parallel() is 40 at once.
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
	check("nothing is queued: all 40 run at once", peak, 40);
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

	// An unresolvable reference fails EVERY agent that uses it, so the message
	// is all that stands between one bad word in a script and a dead fleet. The
	// local run store holds five runs killed outright by model "agent" and
	// model "coding" — each re-authored under a new name rather than corrected,
	// because "use a more specific id" never said which ids existed.
	const failure = (reference: string) => {
		const outcome = resolveModelReference(reference, MODELS);
		return outcome.ok ? "resolved" : outcome.error;
	};
	const ambiguous = failure("claude");
	check("an ambiguous reference names the candidates", ambiguous.includes("anthropic/claude-sonnet-5"), true);
	check("all of them", ambiguous.includes("anthropic/claude-haiku-4-5") && ambiguous.includes("anthropic/claude-fable-5"), true);
	check("and says to use one", ambiguous.includes("use one of those ids"), true);
	// The "agent"/"coding" case: not a model name at all. Seeing the real list
	// is what stops the next attempt being another guess.
	const unknown = failure("agent");
	check("an unknown reference lists what is available", unknown.includes("available:"), true);
	check("with real ids in it", unknown.includes("anthropic/claude-sonnet-5"), true);
	// Long registries are capped, and say so rather than looking complete.
	const many = Array.from({ length: 12 }, (_, i) => ({ provider: "p", id: `m-${i}`, name: `M ${i}` }));
	const capped = resolveModelReference("zzz", many);
	check("a long list is capped", capped.ok ? "" : capped.error.includes("and 4 more"), true);
}

// --------------------------------------------------- routing in the request

console.log("\n--- routing: model mentions in the triggering prompt ---");
{
	const REGISTRY = [
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "anthropic", id: "claude-fable-5", name: "Fable 5" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" },
		{ provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
	];
	const vocabulary = modelVocabulary(REGISTRY);
	const mentions = (text: string) => findModelMentions(text, vocabulary);

	check("vocabulary has family words", [...vocabulary].includes("sonnet") && [...vocabulary].includes("fable"), true);
	check("vocabulary has full ids", vocabulary.has("claude-sonnet-5"), true);
	check("vocabulary drops noise words", vocabulary.has("use") || vocabulary.has("the"), false);

	check(
		"the headline request",
		mentions("ultracode, use sonnet for implementation and fable to review"),
		["sonnet", "fable"],
	);
	check("single model", mentions("ultracode audit this with haiku"), ["haiku"]);
	check("order follows the request", mentions("review with fable, build with sonnet"), ["fable", "sonnet"]);
	check("full id counted once, not as fragments", mentions("use claude-sonnet-5 please"), ["claude-sonnet-5"]);
	check("case-insensitive", mentions("use Sonnet"), ["sonnet"]);
	check("deduped by span", mentions("sonnet, sonnet, sonnet").length, 3);
	check("no models named", mentions("ultracode refactor the auth module"), []);
	check("substring is not a mention", mentions("the sonnets of shakespeare"), []);
	check("empty prompt", mentions(""), []);
	check("empty registry", findModelMentions("use sonnet", modelVocabulary([])), []);
	check("limit is honoured", findModelMentions("sonnet fable haiku mini sonnet fable haiku", vocabulary, 3).length, 3);

	check(
		"reminder names the models and shows the option",
		routingReminder(["sonnet", "fable"]),
		'This request names models (sonnet, fable). Route the workflow accordingly: pass each agent whose role the request covers a matching model reference via the agent() model option, e.g. agent(prompt, { model: "sonnet" }).',
	);
}

console.log("\n--- routing: a word is only a model if it resolves to one ---");
{
	// The registry that caused it. Splitting ids into segments made "coding" a
	// vocabulary word, so any prompt about a CODING AGENT produced a reminder
	// instructing agent(prompt, { model: "coding" }) — a reference matching two
	// kimi models and resolving to neither. Three agents dead per run, and the
	// instruction came from us rather than from the user.
	const REGISTRY = [
		{ provider: "kimi-coding", id: "kimi-for-coding", name: "Kimi for Coding" },
		{ provider: "kimi-coding", id: "kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed" },
		{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
	];
	const vocabulary = modelVocabulary(REGISTRY);

	check("an ambiguous segment is not a model name", vocabulary.has("coding"), false);
	check("nor is it found in a prompt", findModelMentions("build the pi coding agent GUI", vocabulary), []);
	// The mechanism, stated directly: vocabulary and resolver cannot disagree.
	check("but an unambiguous one is", vocabulary.has("sol"), true);
	check("and is found", findModelMentions("ultracode, use sol for this", vocabulary), ["sol"]);
	// Full ids are explicit and always usable, ambiguous segments or not.
	check("full ids survive", vocabulary.has("kimi-for-coding"), true);
	check(
		"and can still be named outright",
		findModelMentions("use kimi-for-coding please", vocabulary),
		["kimi-for-coding"],
	);
	// "kimi" matches both kimi models, so it is not a routing signal either.
	check("a shared family word is not a signal", vocabulary.has("kimi"), false);

	// Regression guard for the original registry: real family words must still
	// work when they genuinely identify one model.
	const clean = modelVocabulary([
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "anthropic", id: "claude-fable-5", name: "Fable 5" },
	]);
	check("distinct families still resolve", clean.has("sonnet") && clean.has("fable"), true);
	// "claude" is in both ids, so it names no single model — and never did.
	check("a shared prefix does not", clean.has("claude"), false);
}

// ------------------------------------------------------------ runs and panel

console.log("\n--- runs: registry, pause and cancel ---");
{
	const registry = new RunRegistry();
	const makeRun = (id: string, status: "running" | "done" | "paused"): WorkflowRun => {
		const progress = newProgress(id, "r");
		progress.status = status;
		return { progress, controller: new AbortController(), gate: new PauseGate(), startedAt: 0, settled: Promise.resolve() };
	};
	const running = makeRun("wf-a", "running");
	registry.add(running);
	check("active lists running runs", registry.active().length, 1);
	check("pause a running run", registry.pause("wf-a"), "paused");
	check("pause sets the gate", running.gate.isPaused(), true);
	// The gate is the authority: a run pauses before any agent observes it, so
	// pausing and resuming between agents has to work.
	check("pausing twice", registry.pause("wf-a"), "already");
	check("resume before the pause was observed", registry.resume("wf-a"), "resumed");
	check("resume clears the gate", running.gate.isPaused(), false);
	check("resuming a running run", registry.resume("wf-a"), "already");
	running.progress.status = "paused";
	check("paused runs stay active", registry.active().length, 1);
	running.progress.status = "running";
	check("cancel running", registry.cancel("wf-a"), "cancelled");
	check("cancel aborts the controller", running.controller.signal.aborted, true);
	running.progress.status = "done";
	check("cancel finished run", registry.cancel("wf-a"), "not-running");
	check("cancel unknown run", registry.cancel("wf-99"), "unknown");
	check("pause unknown run", registry.pause("wf-99"), "unknown");
}

console.log("\n--- runs: the pause gate ---");
{
	const gate = new PauseGate();
	const controller = new AbortController();
	check("open gate does not block", await Promise.race([gate.wait(controller.signal).then(() => "through"), Promise.resolve("through")]), "through");

	gate.pause();
	let released = false;
	const parked = gate.wait(controller.signal).then(() => void (released = true));
	await new Promise((resolve) => setTimeout(resolve, 5));
	check("paused gate parks the caller", released, false);
	check("gate reports one waiter", gate.waiting(), 1);
	gate.resume();
	await parked;
	check("resume releases the waiter", released, true);

	// A cancelled run must never leave an agent parked forever.
	const gate2 = new PauseGate();
	const controller2 = new AbortController();
	gate2.pause();
	const parked2 = gate2.wait(controller2.signal);
	controller2.abort();
	await parked2;
	check("abort releases a parked waiter", true, true);
}

console.log("\n--- runs: interrupted runs from the store ---");
{
	const meta = (runId: string): RunMeta => ({
		runId,
		name: "audit",
		status: "interrupted",
		cwd: "/p",
		pid: 1,
		startedAt: 0,
		agentCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 },
	});
	check("no interrupted runs -> no notice", interruptedNotice([]), undefined);
	const one = interruptedNotice([meta("wf-1")])!;
	check("names the run", one.includes("wf-1"), true);
	check("says it is resumable", one.includes('resumeFromRunId: "wf-1"'), true);
	check("singular phrasing", one.includes("its result message will"), true);
	const two = interruptedNotice([meta("wf-1"), meta("wf-2")])!;
	check("names both runs", two.includes("wf-1, wf-2"), true);
	check("plural phrasing", two.includes("their result messages will"), true);
	// It used to list every dead run but offer resumeFromRunId for only the
	// first, so a session that lost three was told how to recover one.
	check("every dead run gets its own resume call", two.includes('resumeFromRunId: "wf-2"'), true);
	// Across 23 runs in this store, resume was never used once — every failure
	// was answered by authoring a fresh workflow. The notice has to say not to.
	check("re-authoring is ruled out explicitly", one.includes("do NOT write a new workflow"), true);
}

console.log("\n--- runs: judging a run on its agents, not on the script returning ---");
{
	const withAgents = (statuses: Array<AgentRow["status"]>) => {
		const progress = newProgress("wf-1", "review");
		progress.phases.push({
			title: "Find",
			agents: statuses.map((status, index) => ({ index, label: `a${index}`, status, startedAt: 0 })),
		});
		return progress;
	};

	check("counts every outcome", tallyAgents(withAgents(["done", "failed", "replayed", "done"])), {
		total: 4,
		done: 2,
		failed: 1,
		replayed: 1,
	});
	check("spans phases", tallyAgents(progressOverTwoPhases()).total, 3);

	// The case that cost the most: a script that swallowed every failure and
	// returned cleanly, reported as "done" with 0 turns and $0.00.
	check("all failed is a failure", allAgentsFailed(tallyAgents(withAgents(["failed", "failed"]))), true);
	// But one dead verifier out of five has not invalidated the other four.
	check("a partial failure is not", allAgentsFailed(tallyAgents(withAgents(["done", "failed"]))), false);
	check("a clean run is not", allAgentsFailed(tallyAgents(withAgents(["done", "done"]))), false);
	// A script may legitimately spawn nothing; that is not a fleet that died.
	check("no agents at all is not a failure", allAgentsFailed(tallyAgents(newProgress("wf-1", "review"))), false);
	// A resumed run whose every agent replayed from the journal did no new work
	// and must not read as a wipeout.
	check("all replayed is not a failure", allAgentsFailed(tallyAgents(withAgents(["replayed", "replayed"]))), false);
}

function progressOverTwoPhases() {
	const progress = newProgress("wf-1", "review");
	progress.phases.push({
		title: "Find",
		agents: [{ index: 0, label: "a", status: "done", startedAt: 0 }],
	});
	progress.phases.push({
		title: "Verify",
		agents: [
			{ index: 1, label: "b", status: "failed", startedAt: 0 },
			{ index: 2, label: "c", status: "done", startedAt: 0 },
		],
	});
	return progress;
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

	const row = (index: number, label: string, status: AgentRow["status"]): AgentRow => ({ index, label, status, startedAt: 0 });
	const progress = newProgress("wf-1", "review");
	progress.phases.push({ title: "Find", agents: [row(1, "a", "done"), row(2, "b", "running")] });
	progress.usage.cost = 0.1234;
	const run: WorkflowRun = { progress, controller: new AbortController(), gate: new PauseGate(), startedAt: 0, settled: Promise.resolve() };
	const lines = panelLines([run], 65_000)!;
	check("panel line carries name, phases, elapsed", lines[0], "◆ review  Find 1/2  1 running  1m05s");
	// The footer sits under the prompt and is clipped; money lives in /usage.
	check("and no running total", lines[0]!.includes("$"), false);
	// The hint sits directly under the prompt, where the gesture applies, so the
	// gesture leads and the command follows. `includes("/workflows")` alone
	// passed on any string that mentioned the command anywhere.
	const hint = lines.at(-1)!;
	check("panel hint leads with the gesture", hint.startsWith("  shift+↓ "), true);
	check("panel hint still names the command", hint.includes("/workflows"), true);
	// The statusline clips this line with truncateToWidth and never wraps it, so
	// the gesture has to survive a narrow terminal. Growing the hint past this
	// bound should be a deliberate act, not a side effect of a reworded verb.
	check("hint stays inside a narrow footer", visibleWidth(hint) <= 60, true);
	check("the gesture survives a clip", truncateToWidth(hint, 40).includes("shift+↓"), true);

	// A replayed agent counts as done in every summary.
	const resumed = newProgress("wf-2", "review");
	resumed.phases.push({ title: "Find", agents: [row(1, "a", "replayed"), row(2, "b", "done")] });
	const resumedRun: WorkflowRun = {
		progress: resumed,
		controller: new AbortController(),
		gate: new PauseGate(),
		startedAt: 0,
		settled: Promise.resolve(),
	};
	check("replayed agents count as done", panelLines([resumedRun], 0)![0]!.includes("Find 2/2"), true);

	const meta: RunMeta = {
		runId: "wf-1",
		name: "review",
		status: "running",
		cwd: "/p",
		pid: 1,
		startedAt: 0,
		agentCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.1234, totalTokens: 0, turns: 4 },
	};
	const live = new Map([["wf-1", run]]);
	check("status report shows a live run's phases", statusReport([meta], live, 65_000).startsWith("◆ review — Find 1/2"), true);

	// The one surface that still prints an id, because it is the one you copy an
	// id from. The clock label between them is local-time formatted, so this
	// asserts the two ends rather than a string that would differ per machine.
	const settled = statusReport([{ ...meta, status: "done", endedAt: 65_000 }], new Map(), 65_000);
	check("status report leads with the name", settled.startsWith("✓ review — done · 2 agents · 1m05s · "), true);
	check("and quotes no price", settled.includes("$"), false);
	check("and keeps the id at the end, where it is addressable", settled.endsWith("[wf-1]"), true);
	check("the id is nowhere else in the line", settled.split("wf-1").length - 1, 1);
	check("status report empty message", statusReport([], new Map(), 0), "No workflow runs in this session.");

	// Built from local-time components on both sides, so the assertion holds in
	// any timezone — the thing under test is the same-day/other-day split.
	const noon = new Date(2026, 6, 29, 12, 0).getTime();
	check("a run from today reads as a clock time", startedLabel(new Date(2026, 6, 29, 9, 7).getTime(), noon), "09:07");
	check("and pads both halves", startedLabel(new Date(2026, 6, 29, 0, 4).getTime(), noon), "00:04");
	const older = startedLabel(new Date(2026, 6, 27, 9, 7).getTime(), noon);
	check("an older run reads as a date instead", older.includes(":"), false);
	check("naming the day it ran", older.includes("27"), true);
	// Midnight is the boundary, not 24 hours: a run from 23:50 last night is
	// yesterday's, however recent it feels.
	check("just before midnight is a different day", startedLabel(new Date(2026, 6, 28, 23, 50).getTime(), noon).includes(":"), false);
}

// ------------------------------------------------------------------ new: store

console.log("\n--- the panel-opening gesture is not the bare arrow ---");
{
	// index.ts registers shift+down, and pi's dispatcher consumes a matched key
	// unconditionally — it never consults the handler's return value. So if
	// shift+down ever matched a plain ↓, the editor would lose cursor-down and
	// history-forward outright, which no other test here would notice.
	check("plain ↓ (CSI) is not the gesture", matchesKey("\x1b[B", "shift+down"), false);
	check("plain ↓ (SS3) is not the gesture", matchesKey("\x1bOB", "shift+down"), false);
	// The two encodings a terminal actually sends for shift+↓; if neither
	// matched, the key would be inert and the footer hint would be a lie.
	check("CSI modifier form is the gesture", matchesKey("\x1b[1;2B", "shift+down"), true);
	check("legacy shift form is the gesture", matchesKey("\x1b[b", "shift+down"), true);
}

console.log("\n--- store: ids ---");
{
	const a = newRunId(1000);
	const b = newRunId(1000);
	check("ids are unique within a millisecond", a !== b, true);
	check("ids sort by time", newRunId(1000) < newRunId(2000), true);
	// pi requires /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ for --session-id,
	// and agent session ids are built from the run id.
	const legal = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
	check("run id is a legal session id", legal.test(a), true);
	check("agent session id is legal", legal.test(agentSessionId(a, 7)), true);
	check("retry session id is legal", legal.test(agentSessionId(a, 7, 2)), true);
	check("retries get distinct ids", agentSessionId(a, 7) !== agentSessionId(a, 7, 1), true);
	check("settled statuses", [isSettled("running"), isSettled("paused"), isSettled("done"), isSettled("interrupted")], [false, false, true, true]);
}

console.log("\n--- store: round trip, listing, pruning, reconcile ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-store-"));
	try {
		const make = (runId: string, status: RunMeta["status"], startedAt: number, pid = process.pid): RunMeta => ({
			runId,
			name: `run-${runId}`,
			status,
			cwd: "/p",
			pid,
			startedAt,
			agentCount: 1,
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.5, totalTokens: 3, turns: 1 },
		});

		createRun(dir, make("wf-1", "done", 100), "export const meta = {}\n");
		createRun(dir, make("wf-2", "done", 200), "x");
		createRun(dir, make("wf-3", "running", 300, 999_999), "y");

		check("readMeta round trips", readMeta(dir, "wf-1")?.name, "run-wf-1");
		check("unknown run reads as undefined", readMeta(dir, "nope"), undefined);
		check("listRuns is newest first", listRuns(dir).map((meta) => meta.runId), ["wf-3", "wf-2", "wf-1"]);

		appendJournalLine(dir, "wf-1", { kind: "log", seq: 1, t: 0, message: "hello" });
		appendJournalLine(dir, "wf-1", { kind: "phase", seq: 2, t: 0, title: "Find" });
		check("journal round trips", readJournalLines(dir, "wf-1").length, 2);
		check("journal of an unknown run is empty", readJournalLines(dir, "nope"), []);

		// A run whose owning pid is gone becomes interrupted; live ones are left be.
		const interrupted = reconcile(dir);
		check("dead pid becomes interrupted", interrupted.map((meta) => meta.runId), ["wf-3"]);
		check("status persisted", readMeta(dir, "wf-3")?.status, "interrupted");
		check("reconcile is idempotent", reconcile(dir).length, 0);

		pruneRuns(dir, 1);
		check("pruning keeps the newest settled runs", listRuns(dir).map((meta) => meta.runId), ["wf-3"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- new: journal

console.log("\n--- journal: keys and replay ---");
{
	check("stable stringify sorts keys", stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
	check("stable stringify drops undefined", stableStringify({ a: undefined, b: 1 }), '{"b":1}');
	check("same prompt and options -> same key", agentKey("p", { model: "sonnet" }), agentKey("p", { model: "sonnet" }));
	check("key ignores key order", agentKey("p", { model: "a", schema: { x: 1 } }), agentKey("p", { schema: { x: 1 }, model: "a" }));
	check("relabelling does not change the key", agentKey("p", { label: "one" }), agentKey("p", { label: "two" }));
	check("a different phase does not change the key", agentKey("p", { phase: "A" }), agentKey("p", { phase: "B" }));
	check("a different prompt changes the key", agentKey("p", {}) !== agentKey("q", {}), true);
	check("a different model changes the key", agentKey("p", { model: "a" }) !== agentKey("p", { model: "b" }), true);
	check("a different context changes the key", agentKey("p", { context: { parent: 2 } }) !== agentKey("p", { context: { parent: 3 } }), true);
}

console.log("\n--- journal: the replay index ---");
{
	const record = (seq: number, key: string, status: "done" | "failed", result?: unknown) => ({
		kind: "agent" as const,
		seq,
		t: 0,
		index: seq,
		key,
		label: `a${seq}`,
		status,
		result,
		startedAt: 0,
		endedAt: 1,
	});
	const index = new ReplayIndex([record(1, "k1", "done", "one"), record(2, "k2", "failed"), record(3, "k1", "done", "two")]);
	check("only successful agents are replayable", index.size, 2);
	check("first take", index.take("k1"), { hit: true, record: record(1, "k1", "done", "one") });
	check("repeats replay in journal order", (index.take("k1") as { record: { result: unknown } }).record.result, "two");
	check("a third take misses", index.take("k1"), { hit: false });
	check("a failed agent is not replayed", index.take("k2"), { hit: false });
	check("an unknown key misses", index.take("nope"), { hit: false });
	check("hits are counted", index.hitCount, 2);
	check("out-of-order records replay in seq order", new ReplayIndex([record(3, "k", "done", "b"), record(1, "k", "done", "a")]).take("k"), {
		hit: true,
		record: record(1, "k", "done", "a"),
	});
}

console.log("\n--- journal: rebuilding a run's view ---");
{
	const meta: RunMeta = {
		runId: "wf-1",
		name: "review",
		status: "done",
		cwd: "/p",
		pid: 1,
		startedAt: 0,
		endedAt: 10,
		agentCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.02, totalTokens: 0, turns: 2 },
	};
	const progress = progressFromJournal(meta, [
		{ kind: "phase", seq: 1, t: 0, title: "Find" },
		{ kind: "agent", seq: 2, t: 0, index: 2, key: "k", label: "b", phase: "Find", status: "done", startedAt: 0, endedAt: 5 },
		{ kind: "agent", seq: 3, t: 0, index: 1, key: "k", label: "a", phase: "Find", status: "done", startedAt: 0, endedAt: 4, replayed: true },
		{ kind: "log", seq: 4, t: 0, message: "done" },
		{ kind: "agent", seq: 5, t: 0, index: 3, key: "k", label: "c", status: "failed", error: "boom", startedAt: 0, endedAt: 6 },
	]);
	check("phases are rebuilt", progress.phases.map((phase) => phase.title), ["Find", "Agents"]);
	check("agents sort by index inside a phase", progress.phases[0]!.agents.map((agent) => agent.label), ["a", "b"]);
	check("replayed agents are marked", progress.phases[0]!.agents[0]!.status, "replayed");
	check("replayed agents are counted", progress.replayedCount, 1);
	check("a phaseless agent lands under Agents", progress.phases[1]!.agents[0]!.label, "c");
	check("failures carry their reason", progress.phases[1]!.agents[0]!.error, "boom");
	check("logs are rebuilt", progress.logs, ["done"]);
	check("totals come from run.json", progress.usage.cost, 0.02);
	check("a journal-less run still renders", progressFromJournal(meta, []).phases, []);
}

// ---------------------------------------------------------------- new: context

console.log("\n--- context: rendering the parent branch ---");
{
	const message = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
	const branch = [
		message("user", "first"),
		message("assistant", "second"),
		{ type: "custom", message: undefined },
		message("user", "third"),
		message("assistant", ""),
	];
	check("only user and assistant text becomes sections", branchSections(branch), ["User: first", "Assistant: second", "User: third"]);
	check("a string content body works", branchSections([{ type: "message", message: { role: "user", content: "plain" } }]), ["User: plain"]);
	check("the last N turns are kept", renderParent(branch, 2, 10_000), "Assistant: second\n\nUser: third");
	check('"all" keeps everything', renderParent(branch, "all", 10_000).split("\n\n").length, 3);
	check("zero turns renders nothing", renderParent(branch, 0, 10_000), "");
	// A tight budget drops the OLDEST first and says how many went.
	const tight = renderParent(branch, "all", 20);
	check("budget keeps the newest", tight.endsWith("User: third"), true);
	check("budget announces what it dropped", tight.startsWith("[2 earlier message(s) omitted]"), true);
	check("empty branch renders nothing", renderParent([], "all", 100), "");
}

console.log("\n--- context: the seed bundle ---");
{
	const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "the ask" }] } }];
	check("nothing requested -> no bundle", buildContextBundle({ context: {}, branch, cwd: "/p" }), undefined);

	const text = buildContextBundle({ context: { text: "findings" }, branch, cwd: "/p" })!;
	check("literal text is carried", text.includes("## Context\n\nfindings"), true);
	check("the bundle explains itself", text.startsWith("The following is context forked from"), true);

	const parent = buildContextBundle({ context: { parent: 1 }, branch, cwd: "/p" })!;
	check("parent turns are carried", parent.includes("## Conversation so far\n\nUser: the ask"), true);

	const missing = buildContextBundle({ context: { files: ["definitely-not-here.txt"] }, branch, cwd: "/p" })!;
	check("an unreadable file is reported, not fatal", missing.includes("could not be read"), true);

	const real = buildContextBundle({ context: { files: ["config.ts"] }, branch, cwd: import.meta.dirname })!;
	check("a real file is embedded", real.includes("### config.ts"), true);

	// Ordering, asserted on a bundle that actually HAS all three sections. The
	// old assertion compared against `indexOf("## Conversation") + 1e9` on a
	// bundle built without a parent, so the right-hand side was ~1e9 and it was
	// true no matter what the function emitted — including the reverse order,
	// and including no files section at all. It was the only coverage of the
	// ordering code, in the same hunk that rewrote it.
	const ordered = buildContextBundle({
		context: { text: "background", files: ["config.ts"], parent: 1 },
		branch,
		cwd: import.meta.dirname,
	})!;
	const at = (heading: string) => ordered.indexOf(heading);
	check("all three sections are present", [at("## Context"), at("## Files"), at("## Conversation")].every((i) => i >= 0), true);
	check("text comes before files", at("## Context") < at("## Files"), true);
	check("files come before the parent conversation", at("## Files") < at("## Conversation"), true);

	// The seed used to be cut at 60k characters. It is not any more: an agent
	// given half a file, with no way to tell it was half, fails in a way that is
	// far harder to see than a large prompt.
	const huge = buildContextBundle({ context: { text: "x".repeat(200_000) }, branch, cwd: "/p" })!;
	check("nothing is truncated", huge.includes("[context truncated]"), false);
	check("and the whole seed survives", huge.includes("x".repeat(200_000)), true);
}

// ----------------------------------------------------------------- new: engine

console.log("\n--- engine: validation and exports ---");
{
	check(
		"a second export does not break the body",
		(await runWorkflowScript(`${META}export const SCHEMA = { type: 'object' }\nreturn SCHEMA.type`, undefined, fakeHooks(() => "x").hooks)).result,
		"object",
	);
	check(
		"an exported function works too",
		(await runWorkflowScript(`${META}export function f() { return 3 }\nreturn f()`, undefined, fakeHooks(() => "x").hooks)).result,
		3,
	);
	check("the word export inside a string survives", parseMeta(`${META}return "export const x"`).body.includes('"export const x"'), true);
	// A syntax error must fail validation, not a background run minutes later.
	check(
		"validateScript catches a syntax error",
		(() => {
			try {
				validateScript(`${META}return (\n`);
				return "no-throw";
			} catch (error) {
				return (error as Error).message.startsWith("workflow script does not compile") ? "threw" : "wrong-error";
			}
		})(),
		"threw",
	);
	check("validateScript passes a good script", validateScript(`${META}return 1`).meta.name, "t");
}

console.log("\n--- engine: determinism ---");
{
	const bans = async (expression: string) => {
		const outcome = await runWorkflowScript(`${META}return ${expression}`, undefined, fakeHooks(() => "x").hooks).then(
			() => "allowed",
			(error: Error) => (error.message.includes("would break resume") ? "banned" : `other: ${error.message}`),
		);
		return outcome;
	};
	check("Date.now() is banned", await bans("Date.now()"), "banned");
	check("argless new Date() is banned", await bans("new Date().getTime()"), "banned");
	check("Math.random() is banned", await bans("Math.random()"), "banned");
	check("Math still works otherwise", (await runWorkflowScript(`${META}return Math.max(1, 2)`, undefined, fakeHooks(() => "x").hooks)).result, 2);
	check(
		"new Date(value) still works",
		(await runWorkflowScript(`${META}return new Date(0).getUTCFullYear()`, undefined, fakeHooks(() => "x").hooks)).result,
		1970,
	);
	// Scripts can opt out, and then they simply are not resumable.
	const opted = `export const meta = { name: 't', description: 'd', deterministic: false }\nreturn typeof Date.now()`;
	check("a script can opt out", (await runWorkflowScript(opted, undefined, fakeHooks(() => "x").hooks)).result, "number");
}

console.log("\n--- engine: replay ---");
{
	const f = fakeHooks(() => "live");
	const served = new Map([[agentKey("cached", {}), "from-journal"]]);
	const hooks = {
		...f.hooks,
		replay: (key: string) => (served.has(key) ? { hit: true as const, value: served.get(key) } : { hit: false as const }),
	};
	const run = await runWorkflowScript(`${META}const a = await agent('cached')\nconst b = await agent('fresh')\nreturn [a, b]`, undefined, hooks);
	check("a cache hit returns the stored value", run.result, ["from-journal", "live"]);
	check("a replayed agent is not spawned", f.spawned.map((call) => call.prompt), ["fresh"]);
	check("replays are counted", run.replayedCount, 1);
	check("replayed agents still count toward the total", run.agentCount, 2);
	check("a replayed agent reports lifecycle events", f.lifecycle.filter((entry) => entry.event === "start").length, 2);
}

console.log("\n--- engine: shared sessions ---");
{
	// Sequential chaining is the supported shape: each agent continues the
	// conversation the previous one left.
	const f = fakeHooks(async (prompt) => `saw:${prompt}`);
	const chained = await runWorkflowScript(
		`${META}const a = await agent('one', { session: 'explore' })\nconst b = await agent('two', { session: 'explore' })\nreturn [a, b]`,
		undefined,
		f.hooks,
	);
	check("a chain runs to completion", chained.result, ["saw:one", "saw:two"]);
	check("both agents carry the session", f.spawned.map((c) => c.options.session), ["explore", "explore"]);

	// The guard. Two agents holding one session at once would interleave their
	// turns into a single transcript, and every later link would be reading
	// state assembled in an undefined order.
	const g = fakeHooks(async () => {
		await new Promise((resolve) => setTimeout(resolve, 15));
		return "x";
	});
	const clash = await runWorkflowScript(
		`${META}return await parallel([() => agent('a', { session: 's' }), () => agent('b', { session: 's' })])`,
		undefined,
		g.hooks,
	).then(
		() => "no-throw",
		(error: Error) => error.message,
	);
	check("concurrent use of one session fails the run", clash.includes('two agents hold the shared session "s" at once'), true);
	// Fatal rather than a nulled agent: by the time the second arrives the
	// chain's ordering is already undefined, so continuing would produce wrong
	// answers that look right.
	check("and it says how to fix it", clash.includes("continued sequentially"), true);

	// The lock must survive a failing agent, or one failure would wedge the
	// chain for the rest of the run.
	let calls = 0;
	const h = fakeHooks(async () => {
		calls++;
		if (calls === 1) throw new Error("boom");
		return "recovered";
	});
	const afterFailure = await runWorkflowScript(
		`${META}const a = await agent('one', { session: 's' })\nconst b = await agent('two', { session: 's' })\nreturn [a, b]`,
		undefined,
		h.hooks,
	);
	check("a failed agent releases its session", afterFailure.result, [null, "recovered"]);

	// Different names are independent and may run concurrently.
	const i = fakeHooks(async (prompt) => prompt);
	const parallelOk = await runWorkflowScript(
		`${META}return await parallel([() => agent('a', { session: 'x' }), () => agent('b', { session: 'y' })])`,
		undefined,
		i.hooks,
	);
	check("distinct sessions run concurrently", parallelOk.result, ["a", "b"]);

	// A name that is not a usable string is a script error, caught before it can
	// become a strange file on disk.
	const j = fakeHooks(async () => "x");
	const blank = await runWorkflowScript(`${META}return await agent('a', { session: '  ' })`, undefined, j.hooks).then(
		() => "no-throw",
		(error: Error) => error.message,
	);
	check("a blank session name is rejected", blank.includes("session must be a non-empty string"), true);
}

console.log("\n--- engine: a shared session is never replayed ---");
{
	// Resume allocates a fresh runId, so a replayed agent writes no session file
	// into the new run. A later live agent in the same chain would find nothing,
	// quietly start a new conversation, and return an answer computed without
	// the accumulated context — right-looking and wrong. So the chain re-runs.
	const f = fakeHooks(async (prompt) => `live:${prompt}`);
	const served = new Map([[agentKey("cached", {}), "from-journal"]]);
	const chainKey = agentKey("cached", { session: "s" });
	served.set(chainKey, "from-journal-chain");
	const hooks = {
		...f.hooks,
		replay: (key: string) => (served.has(key) ? { hit: true as const, value: served.get(key) } : { hit: false as const }),
	};
	const run = await runWorkflowScript(
		`${META}const plain = await agent('cached')\nconst chained = await agent('cached', { session: 's' })\nreturn { plain, chained }`,
		undefined,
		hooks,
	);
	check("a plain agent still replays", (run.result as { plain: string }).plain, "from-journal");
	check("a shared-session agent does not", (run.result as { chained: string }).chained, "live:cached");
	check("only the chained one is spawned", f.spawned.map((c) => c.prompt), ["cached"]);
	check("and only the plain one counts as replayed", run.replayedCount, 1);
	// Silently re-running would show up as an unexplained bill on a resume.
	check("the reason is logged", f.logs.some((l) => l.includes('session "s" is shared')), true);
	check("once per session", f.logs.filter((l) => l.includes('session "s" is shared')).length, 1);
}

console.log("\n--- journal: session is part of an agent's identity ---");
{
	// Shared-session agents never replay, but they are still RECORDED. If the
	// key ignored `session`, a later plain agent with the same prompt would
	// match one and be handed a result computed with a whole chain behind it.
	check("session changes the key", agentKey("p", {}) === agentKey("p", { session: "s" }), false);
	check("different sessions are different agents", agentKey("p", { session: "a" }) === agentKey("p", { session: "b" }), false);
	check("the same session is the same agent", agentKey("p", { session: "a" }), agentKey("p", { session: "a" }));
}

console.log("\n--- store: shared session ids ---");
{
	check("named after the run and the session", sharedSessionId("wf-1-2", "explore").startsWith("wf-1-2-sexplore-"), true);
	check("stable for one name", sharedSessionId("wf-1-2", "explore"), sharedSessionId("wf-1-2", "explore"));
	// Injective, or two chains would silently share one transcript. A slug alone
	// is not: these two collapse to the same slug.
	check("slug collisions are separated", sharedSessionId("wf-1", "my session") === sharedSessionId("wf-1", "my-session"), false);
	// An agent literally named "1" must not land on agent index 1's file.
	check("never collides with an agent index", sharedSessionId("wf-1", "1") === agentSessionId("wf-1", 1), false);
	// Awkward names still have to produce a usable file name and pi session id.
	check("unusable characters are stripped", /^wf-1-s[a-z0-9-]+$/.test(sharedSessionId("wf-1", "../../etc/passwd")), true);
	check("an all-symbol name still yields an id", /^wf-1-ssession-[0-9a-f]{8}$/.test(sharedSessionId("wf-1", "!!!")), true);
}

console.log("\n--- engine: pause ---");
{
	const f = fakeHooks(() => "x");
	let paused = true;
	let parked = 0;
	const hooks = {
		...f.hooks,
		waitWhilePaused: async () => {
			if (!paused) return;
			parked++;
			while (paused) await new Promise((resolve) => setTimeout(resolve, 2));
		},
	};
	const run = runWorkflowScript(`${META}return await agent('one')`, undefined, hooks);
	await new Promise((resolve) => setTimeout(resolve, 10));
	check("a paused run spawns nothing", f.spawned.length, 0);
	check("the call is parked", parked, 1);
	paused = false;
	check("unpausing lets it through", (await run).result, "x");
}

console.log("\n--- engine: settled outcomes ---");
{
	const outcomes: Array<{ label: string; status: string; attempts: number }> = [];
	const f = fakeHooks((prompt: string) => (prompt.includes("bad") ? Promise.reject(new Error("nope")) : "ok"));
	const hooks = {
		...f.hooks,
		agentSettled: (outcome: { label: string; status: string; attempts: number }) =>
			void outcomes.push({ label: outcome.label, status: outcome.status, attempts: outcome.attempts }),
	};
	await runWorkflowScript(`${META}await agent('good', { label: 'g' })\nawait agent('bad', { label: 'b' })\nreturn 1`, undefined, hooks);
	check("every agent reports an outcome", outcomes, [
		{ label: "g", status: "done", attempts: 1 },
		{ label: "b", status: "failed", attempts: 1 },
	]);

	// A schema agent that never produces usable JSON must report every attempt
	// it burned, not zero.
	const retried: number[] = [];
	const g = fakeHooks(() => "not json");
	await runWorkflowScript(`${META}await agent('x', { schema: { type: 'object', required: ['a'] } })\nreturn 1`, undefined, {
		...g.hooks,
		agentSettled: (outcome: { attempts: number }) => void retried.push(outcome.attempts),
	});
	check("a failed schema agent counts its retries", retried, [2]);
}

// ------------------------------------------------------------- new: agent types

console.log("\n--- agents: the subagent registry ---");
{
	const registry = parseAgentTypes({
		defaults: { model: "gpt-5", reasoning: "high" },
		agents: [
			{ name: "explorer", purpose: "look", tools: ["read", "grep"], reasoning: "low", model: "haiku" },
			{ name: "bad-level", purpose: "x", reasoning: "turbo" },
			{ name: "", purpose: "nameless" },
			"not an object",
		],
	});
	check("valid agents are kept", [...registry.types.keys()], ["explorer", "bad-level"]);
	check("tools are carried", registry.types.get("explorer")?.tools, ["read", "grep"]);
	check("reasoning maps to a thinking level", registry.types.get("explorer")?.thinking, "low");
	check("an invalid level is dropped, not fatal", registry.types.get("bad-level")?.thinking, undefined);
	check("defaults are parsed", registry.defaults, { model: "gpt-5", thinking: "high" });
	check("junk parses to an empty registry", parseAgentTypes(null).types.size, 0);
}

// ---------------------------------------------------------------- new: plumbing

console.log("\n--- config: nothing is limited any more ---");
{
	// The limits block is gone, and these pin that it stays gone. Every cap it
	// held either never bound the runs that hurt (one agent deep for an hour is
	// not shortened by a concurrency cap) or actively killed work in progress.
	const config = CONFIG as Record<string, unknown>;
	for (const gone of ["maxConcurrency", "maxAgentsPerRun", "maxItemsPerCall", "agentTimeoutMs", "contextBudgetChars", "fileBudgetChars"]) {
		check(`${gone} is gone`, gone in config, false);
	}
	// What is left is plumbing, and it has to keep working: without retainRuns
	// the run store grows without bound.
	check("retention survives as an internal", typeof CONFIG.retainRuns, "number");
	check("so does the schema retry", typeof CONFIG.schemaRetries, "number");
	// A limits block left behind in settings.json must be inert, not honoured.
	check("settings carry no limits", "limits" in DEFAULT_SETTINGS, false);
}

console.log("\n--- spawn: argument building ---");
{
	const base = { prompt: "do it", cwd: "/p", approved: false };
	check("no session dir -> ephemeral", buildArgs(base).includes("--no-session"), true);
	const kept = buildArgs({ ...base, sessionDir: "/runs/agents", sessionId: "wf-1-a1" });
	check("a session dir keeps the transcript", kept.includes("--no-session"), false);
	check("session dir is passed", kept.slice(kept.indexOf("--session-dir"), kept.indexOf("--session-dir") + 2), ["--session-dir", "/runs/agents"]);
	check("session id is passed", kept.slice(kept.indexOf("--session-id"), kept.indexOf("--session-id") + 2), ["--session-id", "wf-1-a1"]);
	const withTools = buildArgs({ ...base, tools: ["read", "grep"] });
	check("tools are joined", withTools.slice(withTools.indexOf("--tools"), withTools.indexOf("--tools") + 2), ["--tools", "read,grep"]);
	check("a role prompt is passed", buildArgs({ ...base, appendSystemPrompt: "you are x" }).includes("--append-system-prompt"), true);
	check("trust is forwarded", buildArgs({ ...base, approved: true }).includes("--approve"), true);
	check("the prompt is last", buildArgs(base).at(-1), "do it");
	check("extensions stay off", buildArgs(base).includes("--no-extensions"), true);

	// The new-session notice must not be reported as the cause of a failure.
	check(
		"the session-id notice is filtered out",
		stderrDetail("Warning: No project session found with id 'wf-1-a1'; creating a new session with that id."),
		"",
	);
	check("a real error still surfaces", stderrDetail("Warning: No project session found with id 'x'\nmodel is overloaded"), "model is overloaded");
	check("empty stderr", stderrDetail("   "), "");

	// pi's own errors often END with a documentation path on its own line.
	// Returning the last line reported the PATH, so every model-resolution
	// failure read `subagent failed: /Users/…/docs/models.md` — a pointer to a
	// file instead of the sentence directly above it.
	check(
		"a trailing docs path is not the reason",
		stderrDetail('model "agent" matches several models\n/Users/me/pnpm/@earendil-works/pi-coding-agent/docs/models.md'),
		'model "agent" matches several models',
	);
	check("a trailing URL is not either", stderrDetail("auth failed\nhttps://example.com/docs"), "auth failed");
	// A path is only set ASIDE, not banned: if it is all there is, it beats "".
	check("but a lone path still beats nothing", stderrDetail("/Users/me/docs/models.md"), "/Users/me/docs/models.md");
	// The message is often split across lines, so a few are kept.
	check(
		"a split message is kept together",
		stderrDetail('No model matched "x".\nAvailable: a, b'),
		'No model matched "x". Available: a, b',
	);
	check("and capped", stderrDetail("x".repeat(400)).length, 301);
	// Dropping the pointer left the words that introduced it: "…Use /login to
	// log into a provider. See:" reads as though something went missing.
	check(
		"the dangling connector goes with the path",
		stderrDetail("No API key found for kimi-coding. Use /login to log in. See:\n/Users/me/docs/models.md"),
		"No API key found for kimi-coding. Use /login to log in.",
	);
	check("a sentence ending in 'see' is not mangled", stderrDetail("nothing left to see here"), "nothing left to see here");
	// The benign notice must never come back, even as the last resort — an agent
	// that only announced its new session id would otherwise report that
	// announcement as its cause of death.
	check(
		"the notice never returns as a fallback",
		stderrDetail("Warning: No project session found with id 'x'; creating a new session with that id."),
		"",
	);

	// Node's spawn rejects an argv slot containing a NUL and kills the call
	// before the child exists. A subagent prompt carries forked context and
	// earlier stages' results, so one binary byte upstream failed whole fleets.
	const dirty = buildArgs({ ...base, prompt: "do\0 it", model: "a\0b", appendSystemPrompt: "role\0" });
	check("nulls are stripped from the prompt", dirty.at(-1), "do it");
	check("and from every other argument", dirty.some((a) => a.includes("\0")), false);
	check("scrubbing leaves clean text alone", scrubArg("plain text"), "plain text");
}

console.log("\n--- spawn: a turn's usage delta ---");
{
	// The whole point of the delta is that a caller can add them up AS THEY
	// ARRIVE instead of waiting for the child to exit, and be left holding
	// exactly what the child's own totals say. If these two ever diverge, live
	// cost quietly disagrees with the final number written to run.json.
	const turns: ReportedUsage[] = [
		{ input: 100, output: 20, cacheRead: 0, cacheWrite: 500, reasoning: 0, cost: { total: 0.01 }, totalTokens: 620 },
		{ input: 50, output: 30, cacheRead: 600, cacheWrite: 0, reasoning: 0, cost: { total: 0.02 }, totalTokens: 1300 },
		// A compaction inside the child: context shrinks, spend does not.
		{ input: 40, output: 10, cacheRead: 200, cacheWrite: 0, reasoning: 0, cost: { total: 0.005 }, totalTokens: 400 },
	];
	const total = emptyUsage();
	const summed = emptyUsage();
	for (const turn of turns) addUsage(summed, applyTurn(total, turn));
	check("deltas sum to the totals", summed, total);
	check("cost is the sum of the turns", Number(total.cost.toFixed(4)), 0.035);
	check("totalTokens follows the last turn, not the peak", total.totalTokens, 400);
	check("every turn counted", total.turns, 3);

	// A turn the provider reported nothing for still happened.
	const bare = emptyUsage();
	const bareDelta = applyTurn(bare, undefined);
	check("an unmeasured turn still counts", bare.turns, 1);
	check("and adds nothing else", [bareDelta.input, bareDelta.output, bareDelta.cost, bareDelta.totalTokens], [0, 0, 0, 0]);
}

console.log("\n--- tool: where a script comes from ---");
{
	check("inline script", resolveScript({ script: "s" }, "/agent").source, "inline");
	check(
		"nothing given is an error",
		(() => {
			try {
				resolveScript({}, "/agent");
				return "no-throw";
			} catch (error) {
				return (error as Error).message.includes("requires one of") ? "threw" : "wrong-error";
			}
		})(),
		"threw",
	);
	check(
		"an unknown saved name names the directory it looked in",
		(() => {
			try {
				resolveScript({ name: "nope" }, "/agent");
				return "no-throw";
			} catch (error) {
				return (error as Error).message.includes("/agent/workflows") ? "threw" : `wrong: ${(error as Error).message}`;
			}
		})(),
		"threw",
	);
	check(
		"an unreadable path is reported",
		(() => {
			try {
				resolveScript({ scriptPath: "/definitely/not/here.js" }, "/agent");
				return "no-throw";
			} catch (error) {
				return (error as Error).message.startsWith("cannot read scriptPath") ? "threw" : "wrong-error";
			}
		})(),
		"threw",
	);
	check(
		"resuming a run with no stored script is an error",
		(() => {
			try {
				resolveScript({ resumeFromRunId: "wf-missing" }, mkdtempSync(join(tmpdir(), "wf-empty-")));
				return "no-throw";
			} catch (error) {
				return (error as Error).message.includes("stored script is missing") ? "threw" : "wrong-error";
			}
		})(),
		"threw",
	);
}

// -------------------------------------------------------------------- new: TUI

console.log("\n--- tui: the control panel ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-tui-"));
	try {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.25, totalTokens: 0, turns: 2 };
		createRun(dir, { runId: "wf-1", name: "review", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, endedAt: 5000, agentCount: 2, usage }, "s");
		createRun(dir, { runId: "wf-2", name: "audit", status: "error", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 100, endedAt: 200, agentCount: 1, usage, error: "boom" }, "s");
		appendJournalLine(dir, "wf-1", { kind: "phase", seq: 1, t: 0, title: "Find" });
		appendJournalLine(dir, "wf-1", {
			kind: "agent",
			seq: 2,
			t: 0,
			index: 1,
			key: "k",
			label: "finder",
			phase: "Find",
			model: "openai/gpt-5",
			status: "done",
			startedAt: 0,
			endedAt: 2000,
			sessionFile: "/tmp/agent.jsonl",
		});
		appendJournalLine(dir, "wf-1", { kind: "phase", seq: 3, t: 0, title: "Check" });
		appendJournalLine(dir, "wf-1", {
			kind: "agent",
			seq: 4,
			t: 0,
			index: 2,
			key: "k2",
			label: "checker",
			phase: "Check",
			model: "openai/gpt-5-mini",
			status: "done",
			startedAt: 0,
			endedAt: 3000,
			sessionFile: "/tmp/agent2.jsonl",
		});

		const notices: string[] = [];
		// "open" distinguishes "never closed" from "closed with nothing to hand back".
		let handed: PanelResult | undefined | "open" = "open";
		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{
				agentDir: dir,
				registry: new RunRegistry(),
				sessionId: SESSION,
				notify: (message) => void notices.push(message),
				requestRender: () => {},
				rows: () => 40,
			},
			theme,
			(value) => void (handed = value),
		);

		const text = () => panel.render(80).join("\n");

		// --- framing: a rule above and below, hints where the footer would be.
		{
			const lines = panel.render(60);
			const rule = "─".repeat(60);
			check("the panel opens with a full-width rule", lines[0], rule);
			const lower = lines.lastIndexOf(rule);
			check("a second rule closes the body", lower > 1 && lower < lines.length - 1, true);
			check("the hints sit under the lower rule", lines.slice(lower + 1).join("").includes("q close"), true);
			check("nothing draws a box any more", lines.join("").includes("╭"), false);
		}

		check("the run list opens first", text().includes("✦ Workflows"), true);
		check("both runs are listed, newest first", /audit[\s\S]*review/.test(text()), true);
		check("the newest is selected", text().includes("▸ ✗ audit"), true);

		panel.handleInput("\x1b[B");
		check("↓ moves down", text().includes("▸ ✓ review"), true);

		panel.handleInput("\x1b[C");
		check("→ opens the run", text().includes("Find  1/1"), true);
		check("its agents are listed", text().includes("finder"), true);

		panel.handleInput("g");
		check("g shows the log pane", text().includes("no log lines"), true);
		panel.handleInput("g");

		panel.handleInput("\r");
		check("enter opens the agent", text().includes("openai/gpt-5"), true);
		check("agent detail shows elapsed", text().includes("2s"), true);
		check("agent detail shows its transcript", text().includes("/tmp/agent.jsonl"), true);

		// ↑↓ walks the agent list with the detail still open.
		panel.handleInput("\x1b[B");
		check("↓ in the detail view steps to the next agent", text().includes("/tmp/agent2.jsonl"), true);
		panel.handleInput("\x1b[A");
		check("↑ steps back", text().includes("/tmp/agent.jsonl"), true);

		panel.handleInput("\x1b[D");
		check("← goes back to the run", text().includes("Find  1/1"), true);

		// A run this process is not driving cannot be paused or cancelled, and
		// says so rather than pretending.
		panel.handleInput("p");
		check("pausing a foreign run is refused", text().includes("not running in this session"), true);
		panel.handleInput("\x1b[B");
		check("the next keystroke clears the status", text().includes("not running in this session"), false);

		panel.handleInput("R");
		check("R hands out a resume instruction", (handed as PanelResult)?.editorText?.includes('resumeFromRunId: "wf-1"'), true);
		check("R explains itself", (handed as PanelResult)?.notice?.includes("press enter to send it"), true);
		check("R says nothing from inside the panel", notices, []);

		panel.dispose();

		// --- a run in flight reports where it has got to, not what it last wrote.
		//
		// run.json is written on a throttle while agents stream, so a panel that
		// read only the file would show a live run several seconds behind — and
		// this list is where the decision to cancel gets made.
		{
			const live = new RunRegistry();
			const progress = newProgress("wf-1", "review");
			progress.usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 3.5, totalTokens: 15, turns: 4 };
			progress.agentCount = 7;
			live.add({
				progress,
				controller: new AbortController(),
				gate: new PauseGate(),
				startedAt: 0,
				settled: Promise.resolve(),
			} as WorkflowRun);

			const watching = new WorkflowsPanel(
				{ agentDir: dir, registry: live, sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
				theme,
				() => {},
			);
			const listed = watching.render(120).join("\n");
			check("a live run's agent count comes from the registry", listed.includes("7 agent(s)"), true);
			// The other run has no registry entry, so the file is all there is.
			check("a run this process does not own still reports", listed.includes("1 agent(s)"), true);

			// The panel never shows money — not in the list, not on a run, not on an
			// agent. Spend is still tracked (this run's progress carries $3.50 and
			// the store's runs carry $0.25); it belongs to /usage, not here.
			const everyView = [listed];
			watching.handleInput("\x1b[C");
			everyView.push(watching.render(120).join("\n"));
			watching.handleInput("\r");
			everyView.push(watching.render(120).join("\n"));
			check("no view quotes a price", everyView.filter((view) => view.includes("$")), []);
			watching.dispose();
		}

		// An empty store still renders rather than throwing.
		const empty = mkdtempSync(join(tmpdir(), "wf-tui-empty-"));
		const blank = new WorkflowsPanel(
			{ agentDir: empty, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		check("an empty store renders", blank.render(80).join("\n").includes("No workflow runs in this session yet."), true);
		blank.handleInput("\x1b[C");
		check("drilling into nothing is a no-op", blank.render(80).join("\n").includes("No workflow runs in this session yet."), true);
		let escaped = false;
		const trapped = new WorkflowsPanel(
			{ agentDir: empty, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => void (escaped = true),
		);
		trapped.handleInput("\x03");
		check("ctrl+c closes the panel", escaped, true);
		trapped.dispose();
		blank.dispose();
		rmSync(empty, { recursive: true, force: true });

		// --- width: a line wider than the terminal tears the TUI down, so this is
		// checked at every width and in every view, with content that does not fit.
		const wide = mkdtempSync(join(tmpdir(), "wf-tui-wide-"));
		createRun(
			wide,
			{ runId: "wf-w", name: "レビュー🚀".repeat(6), status: "running", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, agentCount: 1, usage },
			"s",
		);
		appendJournalLine(wide, "wf-w", { kind: "phase", seq: 1, t: 0, title: "レビュー".repeat(10) });
		appendJournalLine(wide, "wf-w", {
			kind: "agent",
			seq: 2,
			t: 0,
			index: 1,
			key: "k",
			label: "a".repeat(300),
			phase: "レビュー".repeat(10),
			model: "openai/gpt-5",
			status: "done",
			startedAt: 0,
			endedAt: 2000,
			sessionFile: `/tmp/${"deep/".repeat(40)}agent.jsonl`,
		});
		{
			const stops = [
				{ label: "runs", keys: [] as string[] },
				{ label: "run", keys: ["\x1b[C"] },
				{ label: "run+logs", keys: ["g"] },
				{ label: "agent", keys: ["g", "\x1b[C"] },
			];
			const wp = new WorkflowsPanel(
				{ agentDir: wide, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 24 },
				theme,
				() => {},
			);
			const tooWide: string[] = [];
			for (const stop of stops) {
				for (const key of stop.keys) wp.handleInput(key);
				for (const width of [20, 30, 40, 80, 200]) {
					for (const line of wp.render(width)) {
						if (visibleWidth(line) > width) tooWide.push(`${stop.label}@${width}: ${visibleWidth(line)}`);
					}
				}
			}
			check("no rendered line ever exceeds the width it was given", tooWide, []);
			wp.dispose();
		}
		rmSync(wide, { recursive: true, force: true });

		// --- height, scroll markers and a caret that stays on screen.
		const many = mkdtempSync(join(tmpdir(), "wf-tui-many-"));
		for (let i = 0; i < 60; i++) {
			createRun(
				many,
				{ runId: `wf-${i}`, name: `run ${i}`, status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: i, endedAt: i + 5000, agentCount: 1, usage },
				"s",
			);
		}
		// The newest run has three phases: a heading per phase is exactly what the
		// agent-list budget has to pay for.
		let seq = 0;
		for (const phase of ["Plan", "Implement", "Review"]) {
			appendJournalLine(many, "wf-59", { kind: "phase", seq: ++seq, t: 0, title: phase });
			for (let i = 0; i < 6; i++) {
				appendJournalLine(many, "wf-59", {
					kind: "agent",
					seq: ++seq,
					t: 0,
					index: seq,
					key: `k${seq}`,
					label: `${phase} agent ${i}`,
					phase,
					model: "openai/gpt-5",
					status: "done",
					startedAt: 0,
					endedAt: 1000,
				});
			}
		}
		{
			const stops = [
				{ label: "runs", keys: [] as string[] },
				{ label: "run", keys: ["\x1b[C"] },
				{ label: "run+logs", keys: ["g"] },
				{ label: "agent", keys: ["g", "\x1b[C"] },
			];
			const over: string[] = [];
			for (const rows of [24, 40]) {
				const p = new WorkflowsPanel(
					{ agentDir: many, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => rows },
					theme,
					() => {},
				);
				for (const stop of stops) {
					for (const key of stop.keys) p.handleInput(key);
					const height = p.render(80).length;
					if (height > rows - CONFIG.screenReserve) over.push(`${stop.label}@${rows}: ${height}`);
				}
				p.dispose();
			}
			check("the panel leaves the reserved transcript rows alone", over, []);
		}
		{
			const p = new WorkflowsPanel(
				{ agentDir: many, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 24 },
				theme,
				() => {},
			);
			const shown = () => p.render(80);
			const counted = () => {
				const lines = shown();
				return {
					rows: lines.filter((line) => /run \d+ /.test(line)).length,
					before: Number(/↑ (\d+) more/.exec(lines.join("\n"))?.[1] ?? 0),
					after: Number(/↓ (\d+) more/.exec(lines.join("\n"))?.[1] ?? 0),
				};
			};
			const top = counted();
			check("at the top only the downward marker shows", [top.before > 0, top.after > 0], [false, true]);
			check("every run is either drawn or counted", top.rows + top.before + top.after, 60);

			for (let i = 0; i < 30; i++) p.handleInput("\x1b[B");
			const mid = counted();
			check("mid-list both markers show", [mid.before > 0, mid.after > 0], [true, true]);
			check("the window still accounts for every run", mid.rows + mid.before + mid.after, 60);

			// The caret must survive every step of a long walk, not just the ends.
			let lost = 0;
			for (let i = 30; i < 59; i++) {
				p.handleInput("\x1b[B");
				if (!shown().join("").includes("▸")) lost++;
			}
			check("the caret stays on screen all the way down", lost, 0);
			check("and lands on the oldest run", shown().join("\n").includes("▸ ✓ run 0 "), true);
			const bottom = counted();
			check("at the bottom only the upward marker shows", [bottom.before > 0, bottom.after > 0], [true, false]);
			p.dispose();
		}
		rmSync(many, { recursive: true, force: true });

		// --- the caret follows its run, not its row: a new run pushes every row
		// down, and `c` cancels whatever the caret is on.
		{
			const shifting = mkdtempSync(join(tmpdir(), "wf-tui-shift-"));
			createRun(shifting, { runId: "wf-1", name: "one", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, endedAt: 1, agentCount: 0, usage }, "s");
			createRun(shifting, { runId: "wf-2", name: "two", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 100, endedAt: 101, agentCount: 0, usage }, "s");
			const p = new WorkflowsPanel(
				{ agentDir: shifting, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
				theme,
				() => {},
			);
			p.handleInput("\x1b[B");
			check("the caret starts on the older run", p.render(80).join("\n").includes("▸ ✓ one"), true);
			createRun(shifting, { runId: "wf-3", name: "three", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 200, endedAt: 201, agentCount: 0, usage }, "s");
			// The panel polls once a second; this is that tick, without the wait.
			(p as unknown as { refresh(): void }).refresh();
			check("a newer run does not steal the selection", p.render(80).join("\n").includes("▸ ✓ one"), true);
			p.dispose();
			rmSync(shifting, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- panel: /workflows lists this session's runs ---");
{
	const meta = (runId: string, sessionId?: string): RunMeta => ({
		runId,
		name: runId,
		status: "done",
		cwd: "/p",
		pid: 1,
		startedAt: 0,
		endedAt: 1,
		agentCount: 0,
		sessionId,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 },
	});
	const none = () => false;
	const all = [meta("mine", "s1"), meta("theirs", "s2"), meta("ancient")];

	check("this session's runs are listed", sessionRuns(all, "s1", none).map((m) => m.runId), ["mine"]);
	check("another session's are not", sessionRuns(all, "s2", none).map((m) => m.runId), ["theirs"]);
	// A run recorded before the session id was written has no way to match, and
	// reads as history rather than as this session's.
	check("nor runs from before ids were recorded", sessionRuns(all, "s1", none).some((m) => m.runId === "ancient"), false);

	// The escape hatch: an ephemeral session (`--no-session`) has no id, so
	// nothing could ever match it. Without this a running fleet would vanish
	// from the panel of the very session driving it.
	check("a session with no id sees nothing stored", sessionRuns(all, undefined, none), []);
	check("but still sees what it is driving", sessionRuns(all, undefined, (id) => id === "ancient").map((m) => m.runId), ["ancient"]);
	check("and a live run outranks a foreign id", sessionRuns(all, "s1", (id) => id === "theirs").map((m) => m.runId), ["mine", "theirs"]);

	// Session scoping is a browsing convenience, but `R resume run` lives in
	// this panel. Filtering out an interrupted run from an earlier session
	// removed the only way to reach the very thing the notice tells the model to
	// resume, leaving its id recoverable only by reading run.json by hand.
	const dead = { ...meta("crashed", "s2"), status: "interrupted" as const };
	const withDead = [meta("mine", "s1"), dead];
	check(
		"an unresumed interrupted run crosses the session boundary",
		sessionRuns(withDead, "s1", none).map((m) => m.runId).sort(),
		["crashed", "mine"],
	);
	// ...and stops crossing it once something has picked it up, or the panel
	// would keep showing finished business forever.
	const resumer = { ...meta("retry", "s2"), resumedFrom: "crashed" };
	check(
		"but not once it has been resumed",
		sessionRuns([...withDead, resumer], "s1", none).map((m) => m.runId),
		["mine"],
	);
	// Only interrupted. An aborted run was cancelled on purpose and an errored
	// one already reported itself, with a resume hint, in its own session.
	const cancelled = { ...meta("cancelled", "s2"), status: "aborted" as const };
	const broken = { ...meta("broken", "s2"), status: "error" as const };
	check(
		"deliberate and reported endings stay scoped out",
		sessionRuns([meta("mine", "s1"), cancelled, broken], "s1", none).map((m) => m.runId),
		["mine"],
	);

	// Spend is scoped harder than browsing is. The interrupted-run exception
	// above exists so `R resume run` can reach a fleet another session
	// abandoned — charging this session for it would be a plain overcount, and
	// the session that ran it has already reported it.
	check("this session's runs are billed here", spendRuns(all, "s1", none).map((m) => m.runId), ["mine"]);
	check("another session's are not", spendRuns(all, "s2", none).map((m) => m.runId), ["theirs"]);
	check("nor is an interrupted run owed by one", spendRuns(withDead, "s1", none).map((m) => m.runId), ["mine"]);
	// Same escape hatch as the panel's, and for the same reason: an ephemeral
	// session has no id, so a fleet it is driving right now would otherwise be
	// billed to nobody.
	check("an ephemeral session is still billed for what it drives", spendRuns(all, undefined, (id) => id === "ancient").map((m) => m.runId), ["ancient"]);
}

console.log("\n--- tool: the reasoning-level chain ---");
{
	const defaults = { thinking: "low" } as never;
	const type = { thinking: "medium" } as never;
	check("the call wins", resolveThinking({ thinking: "high" } as never, type, defaults), "high");
	check("then the agent type", resolveThinking({} as never, type, defaults), "medium");
	check("then the registry default", resolveThinking({} as never, undefined, defaults), "low");
	check("nothing anywhere -> omit --thinking", resolveThinking({} as never, undefined, {} as never), undefined);

	// The bug. Testing `typeof thinking === "string"` short-circuited the chain,
	// so one capital letter failed THINKING_LEVELS, returned undefined, and threw
	// away BOTH the agent type's level and the registry default. --thinking was
	// then omitted and the child fell back to its own settings.json
	// defaultThinkingLevel — the max-reasoning blowup reading defaults.thinking
	// was added to prevent, restored invisibly by a generated script's casing.
	check("a mis-cased level is normalised, not dropped", resolveThinking({ thinking: "High" } as never, type, defaults), "high");
	check("so is stray whitespace", resolveThinking({ thinking: " high " } as never, type, defaults), "high");
	check("an unusable level falls through to the type", resolveThinking({ thinking: "maximum" } as never, type, defaults), "medium");
	check(
		"and past the type to the default",
		resolveThinking({ thinking: "maximum" } as never, { thinking: "nonsense" } as never, defaults),
		"low",
	);
}

console.log("\n--- store: tailing a live agent session ---");
{
	const dir = mkdtempSync(join(tmpdir(), "sess-"));
	const file = join(dir, "live.jsonl");
	const entry = (o: unknown) => `${JSON.stringify(o)}\n`;
	writeFileSync(
		file,
		entry({ type: "session", id: "x" }) +
			entry({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "let me\n  look" }] } }) +
			entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "pnpm test" } }] } }) +
			entry({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "17 passed" }] } }) +
			entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "now fix the flake" }] } }) +
			entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Tests   are   green" }] } }),
	);
	const events = sessionActivity(file);
	check("tool calls are surfaced with their subject", events.filter((e) => e.kind === "tool").map((e) => [e.name, e.detail]), [["bash", "pnpm test"]]);
	check("assistant text is surfaced", events.at(-1), { kind: "text", name: "", detail: "Tests are green" });
	// Whitespace is collapsed because these render as one line each.
	check("multi-line thinking becomes one line", events[0], { kind: "thinking", name: "", detail: "let me look" });
	// A tool RESULT is not the agent acting; showing it would drown the view in
	// build output, which is the thing the agent is reading, not doing. Assert on
	// the fixture's actual result text: an earlier version of this checked for a
	// `kind` of "result", which sessionActivity never emits, so it passed while
	// "17 passed" was sitting in the output it claimed to exclude.
	check("tool results are not activity", events.map((e) => e.detail), ["let me look", "pnpm test", "Tests are green"]);
	check("nor is the user's prompt", events.some((e) => e.detail.includes("fix the flake")), false);

	// The case a live tail always hits: the child is mid-write.
	appendFileSync(file, '{"type":"message","message":{"role":"assist');
	const torn = sessionActivity(file);
	check("a half-written final line is skipped, not thrown on", torn.at(-1)?.detail, "Tests are green");

	check("a missing file is empty, not an error", sessionActivity(join(dir, "nope.jsonl")), []);
	check("the limit is honoured", sessionActivity(file, 1).length, 1);

	// The tail is READ, not merely parsed. Three 150 KB records keep the line
	// count far under the parse cap, so only a bounded read from the end can
	// keep the first one out — which is the property that stops a redraw from
	// costing more the longer the agent has been running.
	const big = join(dir, "big.jsonl");
	const bulk = (tag: string) =>
		entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `${tag} ${"x".repeat(150_000)}` }] } });
	writeFileSync(big, bulk("ANCIENT") + bulk("MIDDLE") + bulk("RECENT"));
	const tailed = sessionActivity(big);
	check("only the last bytes are read", tailed.map((e) => e.detail.slice(0, 6)), ["RECENT"]);
	check("and a huge block is bounded before collapsing", tailed[0]!.detail.length <= 512, true);

	// The query beats the scope: a search's `path` is usually "." and says
	// nothing, while the pattern is the whole reason the call happened.
	const args = join(dir, "args.jsonl");
	writeFileSync(
		args,
		entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "search", arguments: { path: ".", pattern: "TODO" } }] } }) +
			entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "odd", arguments: { needle: "haystack" } }] } }),
	);
	check("a search shows its pattern, not its scope", sessionActivity(args).map((e) => e.detail), ["TODO", "haystack"]);

	rmSync(dir, { recursive: true, force: true });
}

console.log("\n--- runs: the shape measures ---");
{
	const p = newProgress("wf-x", "demo");
	check("peak starts at zero", p.peakConcurrency, 0);
	check("depth starts at zero", p.deepestAgentTurns, 0);
	// These are the two numbers that separate a fleet from a queue and a split
	// task from one agent grinding. Both were previously unrecoverable from
	// run.json — only by hand-parsing journal timestamps.
	check("both are persisted fields on progress", "peakConcurrency" in p && "deepestAgentTurns" in p, true);
}

console.log("\n--- journal: the key covers what options only NAME ---");
{
	const opts = { agentType: "explorer", context: { files: ["a.ts"] } };
	// Same call, different resolved role -> different key. Before this, editing a
	// role's prompt or model in subagents.json left every cached result valid and
	// a resume replayed an answer produced by the OLD role.
	const roleA = agentKey("audit", opts, { agentDef: { model: "sonnet", prompt: "be brief" } });
	const roleB = agentKey("audit", opts, { agentDef: { model: "sonnet", prompt: "be exhaustive" } });
	check("editing the role's prompt invalidates", roleA === roleB, false);
	const modelA = agentKey("audit", opts, { agentDef: { model: "sonnet" } });
	const modelB = agentKey("audit", opts, { agentDef: { model: "opus" } });
	check("so does changing its model", modelA === modelB, false);

	// Same call, different file CONTENT -> different key. We hash the path in
	// options, but the bundle is materialised at spawn time, so a path-only key
	// survived an edit to the file it names.
	const fileA = agentKey("audit", opts, { contextDigest: "a.ts:1111" });
	const fileB = agentKey("audit", opts, { contextDigest: "a.ts:2222" });
	check("editing a context file invalidates", fileA === fileB, false);

	// And the key is still stable when nothing changed, or replay never hits.
	check("identical inputs, identical key", agentKey("audit", opts, { agentDef: { model: "x" } }), agentKey("audit", opts, { agentDef: { model: "x" } }));
	check("omitting extras is still supported", typeof agentKey("audit", opts), "string");
}

console.log("\n--- engine: shell() is the un-fakeable gate ---");
{
	// The whole point: the script reads an exit code the AGENT cannot author.
	// A workflow that gates on an agent asserting the tests passed is gating on
	// prose — measured here as "17/17 passing" for an app that never started.
	const calls: Array<{ command: string; cwd: string }> = [];
	const f = fakeHooks(() => "x");
	const hooks = {
		...f.hooks,
		shell: async (command: string, _o: unknown, _s: unknown) => {
			calls.push({ command, cwd: "/proj" });
			return { exitCode: command.includes("pass") ? 0 : 1, stdout: "out", stderr: "", truncated: false, timedOut: false };
		},
	};
	const run = await runWorkflowScript(
		`${META}const a = await shell('pnpm test --pass')
const b = await shell('pnpm test --fail')
return [a.exitCode, b.exitCode, a.stdout]`,
		undefined,
		hooks as never,
		undefined,
		{ cwd: "/proj" },
	);
	check("the real exit code reaches the script", run.result, [0, 1, "out"]);
	check("both commands ran on the host", calls.map((c) => c.command), ["pnpm test --pass", "pnpm test --fail"]);
}
{
	// Untrusted project: shell() must THROW, not resolve to something harmless.
	// A gate that silently stops gating is worse than no gate.
	const f = fakeHooks(() => "x");
	const outcome = await runWorkflowScript(`${META}return await shell('pnpm test')`, undefined, f.hooks, undefined, {}).then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("not trusted") ? "refused" : `wrong: ${error}`),
	);
	check("no trust -> shell() refuses loudly", outcome, "refused");
}
{
	const f = fakeHooks(() => "x");
	const hooks = { ...f.hooks, shell: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false }) };
	const outcome = await runWorkflowScript(`${META}return await shell('  ')`, undefined, hooks as never, undefined, { cwd: "/p" }).then(
		() => "no-throw",
		(error) => (error instanceof Error && error.message.includes("non-empty command") ? "rejected" : `wrong: ${error}`),
	);
	check("an empty command is rejected", outcome, "rejected");
}

console.log("\n--- engine: a gate is never replayed ---");
{
	// A verdict describes the tree at a moment; on a resume that moment has
	// passed. Replaying one certified a state that no longer existed, and
	// replaying a killed call's exitCode null wedged the gate permanently.
	let ran = 0;
	const f = fakeHooks(() => "x");
	const hooks = {
		...f.hooks,
		replay: () => ({ hit: true, value: { exitCode: 0, stdout: "STALE", stderr: "", truncated: false, timedOut: false } }),
		shell: async () => {
			ran++;
			return { exitCode: 1, stdout: "FRESH", stderr: "", truncated: false, timedOut: false };
		},
	};
	const run = await runWorkflowScript(`${META}return await shell('pnpm test')`, undefined, hooks as never, undefined, { cwd: "/p" });
	check("the command actually ran", ran, 1);
	check("and the script got the live verdict, not the cached one", (run.result as { stdout: string }).stdout, "FRESH");
}

console.log("\n--- engine: a scope that cannot open is fatal ---");
{
	// parallel() nulls anything that is not a WorkflowFatalError, so a git
	// failure used to yield [null, null] and a run reported "finished: 0 agents".
	const f = fakeHooks(() => "x");
	const hooks = { ...f.hooks, worktree: async () => { throw new Error("fatal: not a git repository"); } };
	const outcome = await runWorkflowScript(
		`${META}return await parallel([() => withWorktree('a', () => agent('one'))])`,
		undefined,
		hooks as never,
		undefined,
		{ cwd: "/p" },
	).then(() => "no-throw", (error) => (error instanceof Error && error.message.includes("could not open a scope") ? "fatal" : `wrong: ${error}`));
	check("it fails the run instead of nulling to success", outcome, "fatal");
}

console.log("\n--- journal: the key separates worktree scopes ---");
{
	// Two scopes running the same prompt are two pieces of work. Without cwd in
	// the key the second was served the first's result and its scope stayed
	// empty — and was then discarded as having changed nothing.
	check("same prompt, different scope -> different key", agentKey("build", { cwd: "/a" }) === agentKey("build", { cwd: "/b" }), false);
	check("no scope is still stable", agentKey("build", {}), agentKey("build", {}));
}

console.log("\n--- journal: shell keys and replay ---");
{
	// Salted, so a shell key can never be served an agent's result or vice versa
	// even if the text were identical.
	check("shell and agent keys are different domains", shellKey("x", "/p", {}) === agentKey("x", {}), false);
	check("cwd is significant", shellKey("pnpm test", "/a", {}) === shellKey("pnpm test", "/b", {}), false);
	check("options are significant", shellKey("t", "/p", {}) === shellKey("t", "/p", { timeoutMs: 5 }), false);
	check("same call, same key", shellKey("t", "/p", { timeoutMs: 5 }), shellKey("t", "/p", { timeoutMs: 5 }));

	// Shell records are journaled for the audit trail but must NOT be indexed
	// for replay. A gate's verdict is about the tree at a moment, and a resume
	// is precisely the case where that moment has passed: replaying a green exit
	// certifies code that has since changed, and replaying a killed call's
	// exitCode null wedges the gate so no resume can ever get past it.
	const key = shellKey("pnpm test", "/p", {});
	const index = new ReplayIndex([
		{ kind: "shell", seq: 1, t: 1, key, command: "pnpm test", cwd: "/p", exitCode: 0, startedAt: 0, endedAt: 1, result: { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false } },
	]);
	check("a shell record is not replayable", index.take(key).hit, false);
	check("and does not count as a cached result", index.size, 0);
}

console.log("\n--- store: work still owed ---");
{
	const meta = (runId: string, status: RunMeta["status"], resumedFrom?: string, cwd = "/p"): RunMeta => ({
		runId,
		name: runId,
		status,
		cwd,
		pid: 1,
		startedAt: 0,
		endedAt: 1,
		agentCount: 0,
		resumedFrom,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 },
	});

	check(
		"an interrupted run is owed",
		unresumedInterrupted([meta("a", "interrupted")]).map((m) => m.runId),
		["a"],
	);
	// resumedFrom is written by the run that picks it up, so the debt is settled
	// by the existence of a child — not by anything the parent records.
	check(
		"until something resumes it",
		unresumedInterrupted([meta("a", "interrupted"), meta("b", "done", "a")]).map((m) => m.runId),
		[],
	);
	// A resume that itself died leaves the debt outstanding — on the child now,
	// since that is the run holding the newer journal.
	check(
		"a resume that also died is owed in its turn",
		unresumedInterrupted([meta("a", "interrupted"), meta("b", "interrupted", "a")]).map((m) => m.runId),
		["b"],
	);
	check(
		"other endings are not owed",
		unresumedInterrupted([meta("a", "done"), meta("b", "aborted"), meta("c", "error"), meta("d", "running")]),
		[],
	);

	// Project scoping. The run store is global — listRuns reads every directory
	// under workflow-runs — while a resume spawns its agents in the CURRENT
	// session's cwd. Without a filter, one abandoned run in repo-A was advertised
	// in every session in every other repo, permanently, and taking the hint
	// would have re-run repo-A's agents in the wrong tree.
	const here = [meta("a", "interrupted", undefined, "/repo-a"), meta("b", "interrupted", undefined, "/repo-b")];
	check(
		"scoped to this project",
		unresumedInterrupted(here, "/repo-a").map((m) => m.runId),
		["a"],
	);
	check(
		"another project sees only its own",
		unresumedInterrupted(here, "/repo-b").map((m) => m.runId),
		["b"],
	);
	// No cwd means "do not scope" — the callers that have no session cwd to hand.
	check(
		"omitting the cwd keeps every project",
		unresumedInterrupted(here).map((m) => m.runId),
		["a", "b"],
	);
}

console.log("\n--- notice: runs owed from earlier sessions ---");
{
	const meta = (runId: string, name = runId): RunMeta => ({
		runId,
		name,
		status: "interrupted",
		cwd: "/p",
		pid: 1,
		startedAt: 0,
		endedAt: 1,
		agentCount: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 },
	});

	// The bug this closes: reconcile() skips already-settled runs, so a run not
	// resumed in the session immediately after the crash was never named again.
	const staleOnly = interruptedNotice([], [meta("wf-old", "audit")])!;
	check("a leftover alone still produces a notice", staleOnly.includes("wf-old"), true);
	check("named for what it was", staleOnly.includes("audit (wf-old)"), true);
	check("and still resumable", staleOnly.includes('resumeFromRunId: "wf-old"'), true);
	// It repeats every session until resolved, so it must not read as urgent or
	// demand the user's attention on a turn about something else.
	check("but does not demand to be raised", staleOnly.includes("only if it bears on what they are asking"), true);
	check("nothing owed and nothing dead -> no notice", interruptedNotice([], []), undefined);

	const both = interruptedNotice([meta("wf-new")], [meta("wf-old")])!;
	check("a fresh death leads", both.indexOf("wf-new") < both.indexOf("wf-old"), true);
	check("and the leftover follows it", both.includes("Also still unresumed"), true);

	// Capped, because this repeats every session; the overflow is counted rather
	// than dropped, since a truncated list that looks complete is worse.
	const many = interruptedNotice([], [meta("a"), meta("b"), meta("c"), meta("d"), meta("e")])!;
	check("the list is capped", many.includes('resumeFromRunId: "d"'), false);
	check("and says how many it left out", many.includes("and 2 older ones — see /workflows"), true);
}

console.log("\n--- tui: clipping keeps the tail ---");
{
	const marker = (hidden: number) => `[${hidden} hidden]`;
	const lines = ["a", "b", "c", "d", "e", "f", "ERROR"];
	check("nothing to clip", clipKeepingTail(lines, 7, marker), lines);
	check("a bigger budget is left alone", clipKeepingTail(lines, 20, marker), lines);
	// The error is the last line and the reason someone opened a failed run.
	const clipped = clipKeepingTail(lines, 4, marker);
	check("the clip fits the budget", clipped.length, 4);
	check("the tail survives", clipped.at(-1), "ERROR");
	check("and the cut is visible", clipped, ["a", "b", "[4 hidden]", "ERROR"]);
	check("two rows keep both ends", clipKeepingTail(lines, 2, marker), ["a", "ERROR"]);
	check("one row keeps the tail, not the head", clipKeepingTail(lines, 1, marker), ["ERROR"]);
}

console.log("\n--- tui: a failed run's error survives the height budget ---");
{
	// The reason someone opens a failed run is the error, and runBody appends it
	// last — after the agent list and the log pane. Clipping from the tail drops
	// exactly that line, on exactly the terminal where the clip happens.
	const dir = mkdtempSync(join(tmpdir(), "wf-tui-err-"));
	try {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 };
		createRun(
			dir,
			{ runId: "wf-1", name: "big", status: "error", cwd: "/p", pid: 1, sessionId: SESSION, startedAt: 0, endedAt: 1, agentCount: 20, usage, error: "BOOM-SENTINEL" },
			"s",
		);
		// 20 agents over 10 phases: enough headings and rows that the list alone
		// outruns any budget a short terminal can offer.
		let seq = 0;
		for (let phase = 0; phase < 10; phase++) {
			appendJournalLine(dir, "wf-1", { kind: "phase", seq: ++seq, t: 0, title: `Phase ${phase}` });
			for (let i = 0; i < 2; i++) {
				appendJournalLine(dir, "wf-1", {
					kind: "agent",
					seq: ++seq,
					t: 0,
					index: seq,
					key: `k${seq}`,
					label: `agent ${phase}.${i}`,
					phase: `Phase ${phase}`,
					status: "done",
					startedAt: 0,
					endedAt: 1000,
				});
			}
		}
		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const missing: number[] = [];
		for (const rows of [16, 18, 20, 24]) {
			const p = new WorkflowsPanel(
				{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => rows },
				theme,
				() => {},
			);
			p.handleInput("\x1b[C"); // into the run
			p.handleInput("g"); // and open the log pane, which competes for the same rows
			if (!p.render(80).join("\n").includes("BOOM-SENTINEL")) missing.push(rows);
			p.dispose();
		}
		check("the error is on screen at every height", missing, []);

		// ...and so is the caret. The clip keeps the tail, but the selected row is
		// at the other end, and `x`/`e`/↑↓ all act on it — a hidden caret means
		// keys operating on an agent the user cannot see. 12-15 is the band the
		// first version of this clip broke; the original test started at 16.
		const caretless: number[] = [];
		for (const rows of [12, 13, 14, 15, 16, 18, 20, 24]) {
			const p = new WorkflowsPanel(
				{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => rows },
				theme,
				() => {},
			);
			p.handleInput("\x1b[C");
			for (let i = 0; i < 5; i++) p.handleInput("\x1b[B");
			const shown = p.render(80).join("\n");
			if (!shown.includes("▸")) caretless.push(rows);
			p.dispose();
		}
		check("the caret is visible at every height", caretless, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: the way out survives a short terminal ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-tui-short-"));
	try {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 };
		createRun(dir, { runId: "wf-1", name: "one", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, endedAt: 1, agentCount: 0, usage }, "s");
		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		// 12 rows: the panel is over its share and every budget below hits a floor.
		const p = new WorkflowsPanel(
			{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 12 },
			theme,
			() => {},
		);
		check("a short terminal still shows the exit", p.render(80).join("\n").includes("q close"), true);
		// `p` on a run this process does not own always sets a status line.
		p.handleInput("p");
		const withStatus = p.render(80).join("\n");
		// On 12 rows only one footer line fits, and it has to be the one naming
		// the way out: the panel holds the prompt's slot, so a screen with only a
		// status on it leaves no documented exit. The status is answerable by
		// pressing another key; a panel you cannot leave is not.
		// BOTH survive: `p`, `c` and `e` write only to this.status and never
		// notify, so losing the status line makes those keys look dead — `e`'s
		// entire product is the path it prints. And losing the hint leaves a panel
		// holding the prompt's slot with no visible way out. On one row they share.
		check("the exit survives", withStatus.includes("q close"), true);
		check("and so does the status it shares the row with", withStatus.includes("not running in this session"), true);
		// Narrow as well as short: packHints wraps, and only the FIRST hint line
		// survives the height clip, so the exit has to lead the list.
		check("and survives a narrow one too", p.render(30).join("\n").includes("q close"), true);
		check("every packed line still fits", packHints(["q close", "↑↓ select", "→ open"], 20).every((line) => visibleWidth(line) <= 20), true);
		p.dispose();

		// With room for both, the status is not sacrificed.
		const roomy = new WorkflowsPanel(
			{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		roomy.handleInput("p");
		const both = roomy.render(80).join("\n");
		check("a normal terminal shows the status", both.includes("not running in this session"), true);
		check("and the hints under it", both.includes("q close"), true);
		roomy.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: a panel that lost the editor slot closes itself ---");
{
	// pi clears the editor container from its own selectors and dialogs without
	// telling us, and never puts this panel back. Undetected, the promise never
	// settles: the footer stays stood down for the rest of the session and the
	// refresh timer reads the run store forever.
	const dir = mkdtempSync(join(tmpdir(), "wf-tui-orphan-"));
	try {
		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		let closed = false;
		let detached = 0;
		const p = new WorkflowsPanel(
			{
				agentDir: dir,
				registry: new RunRegistry(),
				notify: () => {},
				requestRender: () => {},
				rows: () => 40,
				sessionId: SESSION,
				onDetached: () => detached++,
			},
			theme,
			() => void (closed = true),
		);
		const tick = () => (p as unknown as { timer: { _onTimeout?: () => void } }).timer?._onTimeout?.();

		// Still mounted: something draws it after every tick.
		for (let i = 0; i < 6; i++) {
			tick();
			p.render(80);
		}
		check("a panel that is being drawn stays quiet", [closed, detached], [false, 0]);

		// Detached: ticks keep firing, nothing renders. One more than ORPHAN_TICKS,
		// because the first tick after a detach still sees the render that came
		// before it — the count only starts once a tick observes no progress.
		for (let i = 0; i < ORPHAN_TICKS; i++) tick();
		check("it does not react early", [closed, detached], [false, 0]);
		tick();
		check("a detached panel says so", detached, 1);

		// And, crucially, does NOT resolve. done() is pi's close(), which restores
		// the editor by clearing the container — evicting whatever component took
		// the slot (a permission dialog, say) and hanging the turn waiting on it.
		check("but never resolves, which would evict the new owner", closed, false);

		// It stops its own timer on the way out — whoever took the slot is not
		// going to call dispose() for it.
		check("and stops reading the store", (p as unknown as { timer: unknown }).timer === undefined, true);
		// Once only: a repeating announcement would fight the component that owns
		// the footer now.
		for (let i = 0; i < 5; i++) tick();
		check("and says it once", detached, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: hint packing ---");
{
	const parts = ["↑↓ select", "→ open", "p pause/resume", "c cancel", "R resume run", "q close"];
	check("a wide terminal keeps them on one line", packHints(parts, 120).length, 1);
	const narrow = packHints(parts, 30);
	check("a narrow one wraps rather than cutting", narrow.length > 1, true);
	check("and every line fits", narrow.every((line) => visibleWidth(line) <= 30), true);
	check("no hint is dropped", parts.every((part) => narrow.join(" ").includes(part)), true);
	check("nothing to say is one empty line", packHints([], 40), [""]);
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

// -------------------------------------------------- opt-in across a delivery

console.log("\n--- mode: a workflow result since the last real turn ---");
{
	const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
	const resultMsg = () => ({ type: "custom_message", customType: "workflow-result", content: "done", display: true });
	const assistantMsg = () => ({ type: "message", message: { role: "assistant", content: [] } });

	check("empty branch -> nothing to find", hasMessageSinceLastUserTurn([], "workflow-result"), false);
	check(
		"a result with no user turn since -> true",
		hasMessageSinceLastUserTurn([userMsg("go"), resultMsg(), assistantMsg()], "workflow-result"),
		true,
	);
	check(
		"a user turn after the result -> false (that turn already got its own reminder pass)",
		hasMessageSinceLastUserTurn([resultMsg(), userMsg("go")], "workflow-result"),
		false,
	);
	check(
		"a result with no messages at all after it still counts",
		hasMessageSinceLastUserTurn([userMsg("go"), resultMsg()], "workflow-result"),
		true,
	);
	check(
		"an older result, superseded by a later user turn, does not leak forward",
		hasMessageSinceLastUserTurn([resultMsg(), userMsg("first"), assistantMsg(), userMsg("second")], "workflow-result"),
		false,
	);
	// Reminders ride in as a "custom_message" of a DIFFERENT customType (never a
	// "message" entry) — the scan must see past one to find the result, rather
	// than mistaking it for a user-turn boundary.
	check(
		"an unrelated custom_message in between does not block the scan",
		hasMessageSinceLastUserTurn(
			[resultMsg(), { type: "custom_message", customType: "ultracode", content: "x", display: false }],
			"workflow-result",
		),
		true,
	);
	check("the customType must match", hasMessageSinceLastUserTurn([resultMsg()], "some-other-type"), false);
}

// ------------------------------------------------------------ streak: state

console.log("\n--- streak: EditStreak counting and cadence ---");
{
	const streak = new EditStreak();
	check("starts at zero", streak.current(), 0);
	for (let i = 0; i < 19; i++) check(`call ${i + 1} of 19 is quiet`, streak.recordEdit(20, 2), null);
	check("the 20th call reports the streak", streak.recordEdit(20, 2), 20);
	check("current() reflects it", streak.current(), 20);
	for (let i = 0; i < 19; i++) streak.recordEdit(20, 2);
	check("the 40th call reports again, still within the per-turn cap", streak.recordEdit(20, 2), 40);
	for (let i = 0; i < 19; i++) streak.recordEdit(20, 2);
	check("a third nudge in the same turn is capped away", streak.recordEdit(20, 2), null);
	check("but the count keeps climbing underneath the cap", streak.current(), 60);
	streak.newTurn();
	for (let i = 0; i < 19; i++) streak.recordEdit(20, 2);
	check("a new turn resets the per-turn cap, not the streak", streak.recordEdit(20, 2), 80);
}
{
	const streak = new EditStreak();
	for (let i = 0; i < 20; i++) streak.recordEdit(20, 2);
	check("a streak in progress", streak.current(), 20);
	streak.reset();
	check("a Workflow call ends it", streak.current(), 0);
	check("and the cadence restarts from scratch", (() => {
		for (let i = 0; i < 19; i++) streak.recordEdit(20, 2);
		return streak.recordEdit(20, 2);
	})(), 20);
}
{
	const streak = new EditStreak();
	streak.restore(19);
	check("restore seeds the count", streak.current(), 19);
	check("the next call completes the streak from where it left off", streak.recordEdit(20, 2), 20);
}

console.log("\n--- streak: restoreEditStreak from a branch ---");
{
	const toolResult = (toolName: string) => ({ type: "message", message: { role: "toolResult", toolName } });
	const other = () => ({ type: "message", message: { role: "assistant" } });

	check("empty branch -> nothing ran, nothing counted", restoreEditStreak([], "workflow"), { count: 0, workflowRan: false });
	check(
		"edit/write results extend the count",
		restoreEditStreak([toolResult("edit"), toolResult("write"), toolResult("edit")], "workflow"),
		{ count: 3, workflowRan: false },
	);
	check(
		"a workflow result resets the count and is remembered",
		restoreEditStreak([toolResult("edit"), toolResult("edit"), toolResult("workflow"), toolResult("edit")], "workflow"),
		{ count: 1, workflowRan: true },
	);
	check(
		"reads/greps/bash between edits do not reset or extend it",
		restoreEditStreak([toolResult("edit"), toolResult("read"), toolResult("bash"), toolResult("edit")], "workflow"),
		{ count: 2, workflowRan: false },
	);
	check("everything unrelated to a toolResult message is ignored", restoreEditStreak([other(), { type: "custom" }], "workflow"), {
		count: 0,
		workflowRan: false,
	});
	check("EDIT_STREAK_TOOLS names exactly edit and write", [...EDIT_STREAK_TOOLS].sort(), ["edit", "write"]);
	check("the workflow tool's own registered name is what restoreEditStreak is called with in index.ts", WORKFLOW_TOOL_NAME, "workflow");
}

console.log("\n--- reminders: the edit-streak nudge names the streak and cites the doctrine ---");
{
	const text = editStreakReminder(20);
	check("names the count", text.includes("made 20 consecutive hand-edits"), true);
	// The reminder exists so the model applies its OWN fan-out rule to itself;
	// asserting the phrase is present is what would catch a future edit that
	// softened "that includes you" back into generic advice.
	check("cites the model's own doctrine back at it", text.includes("that includes you"), true);
	check("names the concrete remedy", text.includes("one agent per deliverable, shell()-gated"), true);
}

// ------------------------------------- panel budget: headings vs agent rows

console.log("\n--- a many-phase run still shows its agents ---");
{
	// The regression this guards: listBudget pre-paid one line for EVERY phase in
	// the run, not just the phases the window draws. A 10-phase run on a 24-row
	// terminal reserved 10 lines for headings, leaving room for a single agent
	// with "↓ 39 more" under ten blank rows.
	const dir = mkdtempSync(join(tmpdir(), "wf-budget-"));
	createRun(dir, { runId: "wf-b", name: "many-phase", status: "running", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, agentCount: 40 } as never, "s");
	for (let phase = 0; phase < 10; phase++) {
		appendJournalLine(dir, "wf-b", { kind: "phase", seq: phase * 5, t: 0, title: `Phase ${phase}` });
		for (let n = 0; n < 4; n++) {
			appendJournalLine(dir, "wf-b", {
				kind: "agent", seq: phase * 5 + n + 1, t: 0, index: phase * 4 + n,
				key: `k${phase}-${n}`, label: `agent-${phase}-${n}`, phase: `Phase ${phase}`,
				model: "m", status: "running", startedAt: 0,
			});
		}
	}

	const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
	const panel = new WorkflowsPanel(
		{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 24 },
		theme,
		() => {},
	);
	// No keypress needed: this is the only run and it is "running", so the
	// panel opens straight into its run detail (see the constructor's
	// single-active-run jump).

	const lines = panel.render(80);
	const agentRows = lines.filter((line) => /agent-\d+-\d+/.test(line)).length;
	// Before the fix this was 1. The exact number depends on how many headings the
	// window spans, so assert the property that matters rather than a magic count.
	check("more than one agent is visible", agentRows > 1, true);
	check("and the panel is not mostly blank", lines.filter((l) => l.trim() === "").length < agentRows, true);
	check("still within its height budget", lines.length <= 24, true);
	check("and nothing overflows the width", lines.filter((l) => visibleWidth(l) > 80).length, 0);

	rmSync(dir, { recursive: true, force: true });
}

console.log("\n--- a rendered line never contains a newline ---");
{
	// pi-tui appends each element to its buffer without clearing extra rows, so an
	// embedded newline desynchronises the display — and the width clamp cannot see
	// it. Agent errors carry Error.message verbatim, which is often multi-line.
	const dir = mkdtempSync(join(tmpdir(), "wf-nl-"));
	createRun(dir, { runId: "wf-n", name: "boom", status: "error", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, endedAt: 1, agentCount: 1, error: "spawn failed\n  at boot\n  at run" } as never, "s");
	const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
	const panel = new WorkflowsPanel(
		{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 24 },
		theme,
		() => {},
	);
	panel.handleInput("\r");
	const lines = panel.render(80);
	check("no element carries a newline", lines.filter((l) => l.includes("\n")).length, 0);
	check("nor overflows the width", lines.filter((l) => visibleWidth(l) > 80).length, 0);
	rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------- two-pane TUI

console.log("\n--- tui: agentStatusIcon picks one icon per status ---");
{
	const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
	check("done -> ✓", agentStatusIcon("done", theme), "✓");
	check("failed -> ✗", agentStatusIcon("failed", theme), "✗");
	check("replayed -> ⟲", agentStatusIcon("replayed", theme), "⟲");
	check("queued -> ⧖ (slot wait, not just \"not started yet\")", agentStatusIcon("queued", theme), "⧖");
	check("running -> ●", agentStatusIcon("running", theme), "●");
}

console.log("\n--- tui: isAgentSettled treats queued like running, not like done ---");
{
	// The regression this guards: before "queued" existed as its own status, a
	// phase heading's "N/total" fraction counted anything that was not
	// literally "running" as settled — which, once agents could be queued
	// behind the scheduler's ceiling, counted a slot-starved agent that had not
	// done anything yet as finished.
	check("running is not settled", isAgentSettled("running"), false);
	check("queued is not settled", isAgentSettled("queued"), false);
	check("done is settled", isAgentSettled("done"), true);
	check("failed is settled", isAgentSettled("failed"), true);
	check("replayed is settled", isAgentSettled("replayed"), true);
}

console.log("\n--- tui: zipColumns joins two columns exactly, never over budget ---");
{
	// A themed fragment, the shape theme.fg produces — zipColumns has to stay
	// exact with ANSI codes in the mix, not just on plain strings.
	const ansi = (text: string) => `\x1b[32m${text}\x1b[0m`;
	const leftWidth = 20;
	const gutter = " │ ";
	// Pre-padded to leftWidth, as truncateToWidth(…, pad: true) guarantees on
	// the way in — zipColumns itself does not pad the left side.
	const left = [truncateToWidth(ansi("▸ ✓ agent-one"), leftWidth, "", true), truncateToWidth("  ✗ agent-two", leftWidth, "", true)];
	// Right rows of varying width, as wrapTextWithAnsi guarantees <= its own
	// budget but never pads — the right is always the last column.
	const right = [ansi("status  done"), "elapsed 3s"];

	const zipped = zipColumns(left, right, leftWidth, gutter);
	check("one joined line per row", zipped.length, 2);
	check(
		"every line is exactly left + gutter + right wide, ANSI codes stripped from the measurement",
		zipped.every((line, i) => visibleWidth(line) === leftWidth + visibleWidth(gutter) + visibleWidth(right[i]!)),
		true,
	);
	check("the left half is untouched", zipped[0]!.startsWith(left[0]!), true);
	check("the gutter sits between the two halves", zipped[0]!.includes(gutter), true);

	// A taller left column: the extra rows get a BLANK right half (nothing sits
	// past the last column), and the left half stays exactly leftWidth wide.
	const tallLeft = [...left, truncateToWidth("  ⧖ agent-three", leftWidth, "", true)];
	const leftTaller = zipColumns(tallLeft, right.slice(0, 1), leftWidth, gutter);
	check("a taller left pads the missing right rows", leftTaller.length, 3);
	check("the padded row is still exactly left + gutter wide", visibleWidth(leftTaller[2]!), leftWidth + visibleWidth(gutter));
	check("with nothing after the gutter", leftTaller[2]!.endsWith(gutter), true);

	// A taller right column: the extra rows get a BLANK, exactly-leftWidth-wide
	// left half (not the previous row's content), so the gutter still lines up
	// vertically down the whole pane.
	const tallRight = [...right, "still going"];
	const rightTaller = zipColumns(left, tallRight, leftWidth, gutter);
	check("a taller right pads the missing left rows with blank space", rightTaller.length, 3);
	check("the padded row's left half is blank but still leftWidth wide", visibleWidth(rightTaller[2]!.split(gutter)[0]!), leftWidth);

	check("two empty columns zip to nothing, not a crash", zipColumns([], [], leftWidth, gutter), []);
}

console.log("\n--- store: readAgentPrompt strips the preamble ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-prompt-"));
	try {
		const withPreamble = join(dir, "a.jsonl");
		writeFileSync(
			withPreamble,
			[
				JSON.stringify({ type: "session", id: "a" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}review the diff for bugs` }] },
				}),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
			].join("\n") + "\n",
			"utf8",
		);
		check("the preamble is stripped, the task text survives", readAgentPrompt(withPreamble)?.text, "review the diff for bugs");
		check("and it is not reported as a chain-ordinal miss", readAgentPrompt(withPreamble)?.isChainOpenerFallback, false);

		const stringShaped = join(dir, "b.jsonl");
		writeFileSync(stringShaped, `${JSON.stringify({ type: "message", message: { role: "user", content: "plain string content" } })}\n`, "utf8");
		check("string-shaped content (no preamble) works too", readAgentPrompt(stringShaped)?.text, "plain string content");

		check("a session file that does not exist", readAgentPrompt(join(dir, "missing.jsonl")), undefined);

		const garbage = join(dir, "c.jsonl");
		writeFileSync(garbage, "not json at all\n{{{ broken\n", "utf8");
		check("non-JSONL garbage is not a crash, just nothing found", readAgentPrompt(garbage), undefined);

		// A torn line and an unrelated message ahead of the real one are both
		// skipped rather than aborting the search.
		const mixed = join(dir, "d.jsonl");
		writeFileSync(
			mixed,
			[
				"not json",
				JSON.stringify({ type: "message", message: { role: "assistant", content: "not the one we want" } }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}second try` }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);
		check("garbage and a non-user message do not block finding the real one", readAgentPrompt(mixed)?.text, "second try");

		// FINDING 1: a context-seeded agent's FIRST user message is the forked
		// context bundle context.ts's seedAgentSession writes (no preamble) — the
		// real task follows as a LATER message, always preamble-prefixed. Scanning
		// for the preamble rather than trusting "first user message" is what keeps
		// the panel from caching thousands of lines of forked context as "the
		// prompt".
		const seeded = join(dir, "e.jsonl");
		const hugeBundle = "## Context\n\n" + "background line\n".repeat(500);
		writeFileSync(
			seeded,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: hugeBundle }] } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Context received. Send the task." }] } }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}fix the off-by-one in parser.ts` }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);
		const seededLookup = readAgentPrompt(seeded);
		check("the real task is returned, not the context bundle", seededLookup?.text, "fix the off-by-one in parser.ts");
		check("the bundle's own text never leaks through", seededLookup?.text?.includes("background line"), false);

		// A context-seeded agent whose task turn has not landed yet (only the
		// bundle exists so far) has nothing preamble-bearing to find at all; the
		// bundle is the best available answer rather than "no prompt".
		const bundleOnly = join(dir, "f.jsonl");
		writeFileSync(
			bundleOnly,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "## Context\n\nnot a task yet" }] } })}\n`,
			"utf8",
		);
		check("with no task turn yet, the bundle is the fallback", readAgentPrompt(bundleOnly)?.text, "## Context\n\nnot a task yet");
		check("that fallback is not flagged as a chain-ordinal miss", readAgentPrompt(bundleOnly)?.isChainOpenerFallback, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- store: readAgentPrompt's ordinal picks the k-th chained agent's task ---");
{
	// FINDING 3: a shared session's file carries one preamble-bearing task
	// message per agent that ran in it, in the order they ran. `ordinal` is how
	// a later agent in the chain finds ITS OWN task rather than the first one
	// written to the file.
	const dir = mkdtempSync(join(tmpdir(), "wf-prompt-ordinal-"));
	try {
		const chain = join(dir, "shared.jsonl");
		writeFileSync(
			chain,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}inspect auth.ts` }] } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "inspected" }] } }),
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}now fix the bug` }] } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "fixed" }] } }),
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}now verify it` }] } }),
			].join("\n") + "\n",
			"utf8",
		);
		check("ordinal 0 is the first agent's own task", readAgentPrompt(chain, 0)?.text, "inspect auth.ts");
		check("ordinal 1 is the second agent's own task, not the first's", readAgentPrompt(chain, 1)?.text, "now fix the bug");
		check("ordinal 2 is the third agent's own task", readAgentPrompt(chain, 2)?.text, "now verify it");
		check("none of these are reported as a chain-ordinal miss", [0, 1, 2].map((o) => readAgentPrompt(chain, o)?.isChainOpenerFallback), [
			false,
			false,
			false,
		]);

		// An ordinal past what the head-bound scan found (three chained agents
		// asked for, only one task message actually written — e.g. the earlier
		// agents' own long conversations pushed the rest out of PROMPT_HEAD_BYTES)
		// falls back to the LAST one found rather than lying about which agent's
		// task it is.
		const truncated = join(dir, "truncated.jsonl");
		writeFileSync(
			truncated,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}only this one was reachable` }] } })}\n`,
			"utf8",
		);
		const fallback = readAgentPrompt(truncated, 2);
		check("the fallback shows the last (only) task actually found", fallback?.text, "only this one was reachable");
		check("and says so, rather than lying silently", fallback?.isChainOpenerFallback, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- store: countToolCalls resumes from where it left off ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-toolcount-"));
	try {
		const file = join(dir, "a.jsonl");
		const toolLine = () => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } })}\n`;
		writeFileSync(file, toolLine(), "utf8");
		const first = countToolCalls(file);
		check("the first read counts what is already there", first.count, 1);
		check("and remembers the file's size as the offset", first.offset, statSync(file).size);

		appendFileSync(file, toolLine() + toolLine(), "utf8");
		const second = countToolCalls(file, first);
		check("an append is counted on top of the previous tally, not from 0", second.count, 3);

		// Nothing appended: a size check, and the SAME tally back.
		check("no growth -> the identical tally", countToolCalls(file, second), second);

		// A schema retry starts a fresh attempt under a NEW session id rather
		// than truncating this one, so a shrink is defensive rather than
		// expected — but it must reset rather than go negative or wrong.
		writeFileSync(file, toolLine(), "utf8");
		const shrunk = countToolCalls(file, second);
		check("a smaller file is treated as a different one and restarts from 0", shrunk.count, 1);

		// One assistant turn can carry several tool calls at once (the preamble
		// itself asks agents to batch independent calls) — each counts.
		const multi = join(dir, "b.jsonl");
		writeFileSync(
			multi,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "read" },
						{ type: "toolCall", name: "grep" },
					],
				},
			})}\n`,
			"utf8",
		);
		check("multiple tool calls in one line are all counted", countToolCalls(multi).count, 2);

		check("a missing file counts nothing rather than throwing", countToolCalls(join(dir, "missing.jsonl")).count, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: the two-pane run view ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-tui-split-"));
	try {
		const sessionFile = join(dir, "agent-a.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}find every TODO in src/` }] },
				}),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "TODO" } }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.02, totalTokens: 4000, turns: 2 };
		// The panel's run LIST is read from run.json on disk (listRuns); the
		// live registry only overrides the PROGRESS of a run already in that
		// list (see currentProgress) — a run known only to the registry is
		// invisible to it, same as every other live-run fixture in this file.
		createRun(dir, { runId: "wf-split", name: "sweep", status: "running", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, agentCount: 2, usage }, "s");
		const progress = newProgress("wf-split", "sweep");
		progress.phases.push({
			title: "Find",
			agents: [
				{ index: 0, label: "runner", status: "running", phase: "Find", startedAt: 0, sessionFile, usage, model: "openai/gpt-5" },
				{ index: 1, label: "waiter", status: "queued", phase: "Find", startedAt: 0 },
			],
		});
		const run: WorkflowRun = { progress, controller: new AbortController(), gate: new PauseGate(), startedAt: 0, settled: Promise.resolve() };
		const registry = new RunRegistry();
		registry.add(run);

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: dir, registry, sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		// No keypress needed: this is the only run and it is "running", so the
		// panel already opened straight into it (see the constructor).

		const wideLines = panel.render(120);
		const wide = wideLines.join("\n");
		check("no rendered line exceeds the width it was given", wideLines.filter((l) => visibleWidth(l) > 120).length, 0);
		check("the tree and the detail pane sit side by side", wide.includes("│"), true);
		check("the running agent's prompt shows the stripped task, not the preamble", wide.includes("find every TODO in src/"), true);
		check("the preamble boilerplate itself is not shown", wide.includes("You are a subagent"), false);
		check("activity names a real tool call", /last \d+ of \d+ tool call/.test(wide), true);

		check("just under SPLIT_MIN_WIDTH stays single-pane", panel.render(SPLIT_MIN_WIDTH - 1).join("\n").includes("│"), false);
		check("at SPLIT_MIN_WIDTH it splits", panel.render(SPLIT_MIN_WIDTH).join("\n").includes("│"), true);

		// ↓ selects the queued agent.
		panel.handleInput("\x1b[B");
		const queuedLines = panel.render(120);
		const queued = queuedLines.join("\n");
		check("a queued agent renders the wait icon", queued.includes("⧖"), true);
		check("and explains itself in the header", queued.includes("queued (slot wait)"), true);
		check("an agent with no session file yet says so, not \"missing\"", queued.includes("prompt pending first turn"), true);
		check("still nothing overflows the width", queuedLines.filter((l) => visibleWidth(l) > 120).length, 0);

		// Escape from the two-pane view goes straight to the runs list — not
		// through an intermediate "agent" screen, unlike the narrow fallback.
		panel.handleInput("\x1b"); // escape
		check("escape from two-pane goes directly to the runs list", panel.render(120).join("\n").includes("✦ Workflows"), true);

		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: below SPLIT_MIN_WIDTH the drill-down still works, with a prompt section ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-tui-narrow-prompt-"));
	try {
		const sessionFile = join(dir, "agent-a.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}summarise the auth module` }] },
			})}\n`,
			"utf8",
		);
		createRun(
			dir,
			{ runId: "wf-narrow", name: "solo", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, endedAt: 1000, agentCount: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 1 } },
			"s",
		);
		appendJournalLine(dir, "wf-narrow", { kind: "phase", seq: 1, t: 0, title: "Work" });
		appendJournalLine(dir, "wf-narrow", {
			kind: "agent", seq: 2, t: 0, index: 1, key: "k", label: "summariser", phase: "Work",
			status: "done", startedAt: 0, endedAt: 500, sessionFile,
		});

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		panel.handleInput("\x1b[C"); // -> run
		panel.handleInput("\r"); // -> agent, narrow fallback only (width 80 below SPLIT_MIN_WIDTH)
		const text = panel.render(80).join("\n");
		check("the fallback drill-down still reaches a single agent's detail", text.includes("summariser") || text.includes("done"), true);
		check("and it now shows the agent's prompt too", text.includes("summarise the auth module"), true);
		check("under the section heading agentBody shares with the two-pane view", text.includes("Prompt ·"), true);
		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ------------------------------------------ shared-session chains (Finding 3)

console.log("\n--- tui: shared-session chains pick each agent's OWN prompt by ordinal ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-chain-"));
	try {
		const shared = join(dir, "shared.jsonl");
		writeFileSync(
			shared,
			[
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}first: inspect the module` }] },
				}),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "inspected" }] } }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}second: apply the fix` }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 1 };
		createRun(dir, { runId: "wf-chain", name: "chained", status: "running", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, agentCount: 2, usage }, "s");
		appendJournalLine(dir, "wf-chain", { kind: "phase", seq: 1, t: 0, title: "Work" });
		// The two rows share ONE sessionFile — the shape of a shared session
		// (`agent(p, { session: "..." })`) — ordered by startedAt, second later.
		appendJournalLine(dir, "wf-chain", { kind: "agent", seq: 2, t: 0, index: 1, key: "k1", label: "inspector", phase: "Work", status: "done", startedAt: 0, endedAt: 10, sessionFile: shared });
		appendJournalLine(dir, "wf-chain", { kind: "agent", seq: 3, t: 0, index: 2, key: "k2", label: "fixer", phase: "Work", status: "done", startedAt: 100, endedAt: 200, sessionFile: shared });

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		// The only run and it is "running", so the constructor already opened it
		// (see the single-active-run jump) with the first chained agent selected.
		const first = panel.render(120).join("\n");
		check("the first agent (ordinal 0) shows its OWN task", first.includes("first: inspect the module"), true);
		check("not the second agent's — the bug this closes showed the chain's FIRST prompt for every agent in it", first.includes("second: apply the fix"), false);

		panel.handleInput("\x1b[B"); // select the second chained agent
		const second = panel.render(120).join("\n");
		check("the second agent (ordinal 1) shows ITS OWN task", second.includes("second: apply the fix"), true);
		check("not the chain's opener", second.includes("first: inspect the module"), false);
		check("no chain-opener suffix — this agent's own task WAS found within the head bound", second.includes("(chain opener)"), false);

		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: a chain past the head-bound scan falls back to the opener, labelled ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-chain-truncated-"));
	try {
		const shared = join(dir, "shared.jsonl");
		// Only ONE task message reachable — standing in for an earlier agent's own
		// long conversation pushing the rest of the chain's task turns past
		// PROMPT_HEAD_BYTES.
		writeFileSync(
			shared,
			`${JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}only the opener is reachable` }] } },
			)}\n`,
			"utf8",
		);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 1 };
		createRun(dir, { runId: "wf-chain2", name: "chained2", status: "running", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, agentCount: 2, usage }, "s");
		appendJournalLine(dir, "wf-chain2", { kind: "phase", seq: 1, t: 0, title: "Work" });
		appendJournalLine(dir, "wf-chain2", { kind: "agent", seq: 2, t: 0, index: 1, key: "k1", label: "opener", phase: "Work", status: "done", startedAt: 0, endedAt: 10, sessionFile: shared });
		appendJournalLine(dir, "wf-chain2", { kind: "agent", seq: 3, t: 0, index: 2, key: "k2", label: "later", phase: "Work", status: "done", startedAt: 100, endedAt: 200, sessionFile: shared });

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		panel.handleInput("\x1b[B"); // select the second ("later") chained agent — ordinal 1
		const wide = panel.render(120).join("\n");
		check("the fallback shows the only task actually found", wide.includes("only the opener is reachable"), true);
		check("and labels it as the chain opener rather than lying silently", wide.includes("(chain opener)"), true);
		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// -------------------------------------------- detail-pane budgeting (Finding 2)

console.log("\n--- tui: layoutDetail shrinks the prompt before the activity tail goes under its floor ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-detailbudget-"));
	const storeDir = mkdtempSync(join(tmpdir(), "wf-detailbudget-store-"));
	try {
		const sessionFile = join(dir, "agent.jsonl");
		const taskLines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
		const fileLines: string[] = [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}${taskLines}` }] } }),
		];
		for (let i = 0; i < 10; i++) {
			fileLines.push(
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: `call${i}`, arguments: { command: `step-${i}` } }] } }),
			);
		}
		writeFileSync(sessionFile, `${fileLines.join("\n")}\n`, "utf8");

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: storeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		const agent: AgentRow = { index: 0, label: "solo", status: "running", startedAt: 0, sessionFile };

		// Identity "measure" — the narrow fallback's own convention (render()'s
		// row() truncates each raw line to one terminal row rather than wrapping
		// it), which lets this test predict exact row counts without depending on
		// wrapTextWithAnsi's own line-breaking.
		const identity = (ls: string[]) => ls;
		const out: string[] = (panel as unknown as { layoutDetail(a: AgentRow, b: number, m: (ls: string[]) => string[]): string[] }).layoutDetail(
			agent,
			13,
			identity,
		);

		check("stays within the 13-row budget", out.length <= 13, true);
		check("the 12-line prompt shrank rather than swallowing the pane", out.filter((l) => /^line \d+$/.test(l)).length < 12, true);
		check("the activity heading survives", out.some((l) => l.includes("Activity")), true);
		const activityRows = out.filter((l) => /^ {2}call\d+ /.test(l));
		check("the activity tail gets at least ACTIVITY_MIN_ROWS(4) rows worth of room (heading + events)", activityRows.length + 1 >= 4, true);
		check("the newest tool call survives the squeeze", out.some((l) => l.includes("step-9")), true);
		check("the oldest does not — never-shrinking room went to the tail, not the head", out.some((l) => l.includes("step-0")), false);

		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(storeDir, { recursive: true, force: true });
	}
}

console.log("\n--- tui: layoutDetail's activity trim keeps the tail when wrapping outgrows its room ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-detailtrim-"));
	const storeDir = mkdtempSync(join(tmpdir(), "wf-detailtrim-store-"));
	try {
		const sessionFile = join(dir, "agent.jsonl");
		const fileLines: string[] = [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}short task` }] } }),
		];
		for (let i = 0; i < 6; i++) {
			fileLines.push(
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "toolCall", name: `call${i}`, arguments: { command: `oldest-to-newest-${i}` } }] },
				}),
			);
		}
		writeFileSync(sessionFile, `${fileLines.join("\n")}\n`, "utf8");

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: storeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		const agent: AgentRow = { index: 0, label: "solo", status: "running", startedAt: 0, sessionFile };

		// A synthetic "measure" standing in for wrapping: every ACTIVITY line (the
		// only ones with a leading two-space indent — see activitySection) turns
		// into three rows instead of one, the way a long tool-call detail
		// wrapping at a narrow pane width would. Header and prompt lines pass
		// through untouched (neither starts with two spaces), so the numbers stay
		// predictable without depending on wrapTextWithAnsi's own rules — the same
		// reasoning countToolCalls' injectable chunk size below uses to exercise a
		// real code path deterministically instead of hoping the OS cooperates.
		const explode = (ls: string[]) => ls.flatMap((l) => (l.startsWith("  ") ? [l, `${l} (cont 1)`, `${l} (cont 2)`] : [l]));

		const out: string[] = (panel as unknown as { layoutDetail(a: AgentRow, b: number, m: (ls: string[]) => string[]): string[] }).layoutDetail(
			agent,
			10,
			explode,
		);
		check("stays within budget even though activity exploded 3x", out.length <= 10, true);
		check("the newest fetched call survives the clip", out.some((l) => l.includes("oldest-to-newest-5")), true);
		check("the second-newest, fetched but not fit after exploding, is trimmed — the tail wins, not the head", out.some((l) => l.includes("oldest-to-newest-4")), false);

		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(storeDir, { recursive: true, force: true });
	}
}

// --------------------------------------------------- key gating (Finding 5)

console.log("\n--- tui: g and PgUp/PgDn are gated to the view where their effect is visible ---");
{
	const activeDir = mkdtempSync(join(tmpdir(), "wf-keygate-active-"));
	const doneDir = mkdtempSync(join(tmpdir(), "wf-keygate-done-"));
	try {
		const sessionFile = join(activeDir, "agent.jsonl");
		const longTask = Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}${longTask}` }] } })}\n`,
			"utf8",
		);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 1 };
		createRun(activeDir, { runId: "wf-1", name: "one", status: "running", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, agentCount: 1, usage }, "s");
		appendJournalLine(activeDir, "wf-1", { kind: "phase", seq: 1, t: 0, title: "Work" });
		appendJournalLine(activeDir, "wf-1", { kind: "agent", seq: 2, t: 0, index: 1, key: "k", label: "solo", phase: "Work", status: "done", startedAt: 0, endedAt: 1, sessionFile });
		createRun(doneDir, { runId: "wf-done", name: "finished", status: "done", cwd: "/p", pid: process.pid, sessionId: SESSION, startedAt: 0, endedAt: 1, agentCount: 0, usage }, "s");

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		type View = "runs" | "run" | "agent";
		const priv = (p: WorkflowsPanel) => p as unknown as { view: View; showLogs: boolean; promptScroll: number };

		// The narrow "runs" list: no run is open, so neither key has anything to affect.
		{
			const p = new WorkflowsPanel({ agentDir: doneDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 }, theme, () => {});
			p.render(80); // "done" is not active, so the constructor left it on the list
			check("starts on the runs list", priv(p).view, "runs");
			p.handleInput("g");
			check("g does nothing on the runs list", priv(p).showLogs, false);
			p.handleInput("\x1b[6~"); // PageDown
			check("PgDn does nothing on the runs list either", priv(p).promptScroll, 0);
			p.dispose();
		}

		// The narrow "run" view (the agent LIST — not yet drilled into one): this
		// is exactly where the log pane lives (see runBody()), so "g" works; the
		// detail pane with the prompt does not exist yet, so PgDn must not.
		{
			const p = new WorkflowsPanel({ agentDir: activeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 }, theme, () => {});
			p.render(80); // narrow; "running" is active, so the constructor already opened the run
			check("starts in narrow run view", priv(p).view, "run");
			p.handleInput("g");
			check("g DOES toggle the log pane in narrow run view", priv(p).showLogs, true);
			p.handleInput("\x1b[6~"); // PageDown
			check("PgDn does nothing here — the detail pane it would scroll is not on screen yet", priv(p).promptScroll, 0);
			p.dispose();
		}

		// The narrow "agent" view (drilled into one agent): the reverse — the
		// prompt is now visible, so PgDn works; the log pane belongs to the LIST
		// view, so "g" no longer does anything.
		{
			const p = new WorkflowsPanel({ agentDir: activeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 }, theme, () => {});
			p.render(80);
			p.handleInput("\r"); // -> agent
			check("now in agent view", priv(p).view, "agent");
			p.handleInput("g");
			check("g does nothing in agent view", priv(p).showLogs, false);
			p.handleInput("\x1b[6~"); // PageDown
			check("PgDn DOES move the prompt scroll now that the detail pane is on screen", priv(p).promptScroll > 0, true);
			p.dispose();
		}

		// Split mode: "run" and "agent" collapse into one screen that already
		// shows the detail pane (see forward()/back()), but there is no row
		// budgeted for a log pane there at all (see SPLIT_HINTS) — so PgDn works
		// and "g" still must not.
		{
			const p = new WorkflowsPanel({ agentDir: activeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 }, theme, () => {});
			p.render(120); // split
			p.handleInput("g");
			check("g does nothing in split mode", priv(p).showLogs, false);
			p.handleInput("\x1b[6~"); // PageDown
			check("PgDn DOES move the prompt scroll in split mode's run view", priv(p).promptScroll > 0, true);
			p.dispose();
		}
	} finally {
		rmSync(activeDir, { recursive: true, force: true });
		rmSync(doneDir, { recursive: true, force: true });
	}
}

// ----------------------------------------------- journal size gate (Finding 6)

console.log("\n--- tui: the viewed-progress cache re-parses only when the journal grows ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-viewed-cache-"));
	try {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 };
		createRun(dir, { runId: "wf-v", name: "watched", status: "done", cwd: "/p", pid: 999999, sessionId: SESSION, startedAt: 0, endedAt: 1, agentCount: 1, usage }, "s");
		appendJournalLine(dir, "wf-v", { kind: "phase", seq: 1, t: 0, title: "Work" });

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: dir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		const priv = panel as unknown as { viewed?: { path: string; size: number; progress: unknown }; refresh(): void };
		panel.handleInput("\x1b[C"); // -> run: forces the journal to be read at all
		panel.render(80);
		const first = priv.viewed?.progress;
		check("the journal is parsed on the first look", !!first, true);

		// Several simulated 1-second ticks (refresh() is exactly what the
		// constructor's timer calls every second) with NOTHING appended to the
		// journal in between.
		for (let i = 0; i < 5; i++) {
			priv.refresh();
			panel.render(80);
		}
		check(
			"an unchanged journal reuses the SAME parsed object across every tick, not a fresh parse each time",
			priv.viewed?.progress === first,
			true,
		);

		// A real change must still be picked up.
		appendJournalLine(dir, "wf-v", { kind: "log", seq: 2, t: 0, message: "hello" });
		priv.refresh();
		panel.render(80);
		const grown = priv.viewed?.progress as { logs: string[] } | undefined;
		check("a grown journal is re-parsed into a NEW object", grown !== first, true);
		check("...and the new content is actually there", grown?.logs?.includes("hello"), true);

		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ------------------------------------------------ prompt miss cache (Finding 7)

console.log("\n--- tui: a prompt miss is cached by the file's size, re-attempted only once it changes ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-prompt-miss-"));
	const storeDir = mkdtempSync(join(tmpdir(), "wf-prompt-miss-store-"));
	try {
		const file = join(dir, "agent.jsonl");
		// The REAL task, computed first so the miss fixture below can be padded
		// out to at least this length — SUBAGENT_PREAMBLE alone is longer than a
		// short miss fixture would otherwise be.
		const realCore = `${JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: `${SUBAGENT_PREAMBLE}do the thing` }] } },
		)}\n`;
		const realLen = Buffer.byteLength(realCore, "utf8");
		const missSize = realLen + 500;

		// No user message at all — readAgentPrompt genuinely has nothing to find,
		// so this is a MISS (undefined), the case that used to be re-read at
		// PROMPT_HEAD_BYTES on every tick forever. Padded (as a harmless trailing
		// non-JSON line) to `missSize` so the real content below can later be
		// padded to that exact same size.
		const noUserCore = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "no user message here" } })}\n`;
		const missPad = "y".repeat(Math.max(0, missSize - Buffer.byteLength(noUserCore, "utf8")));
		writeFileSync(file, noUserCore + missPad, "utf8");
		check("the miss fixture reaches its intended size", statSync(file).size, missSize);

		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const panel = new WorkflowsPanel(
			{ agentDir: storeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
			theme,
			() => {},
		);
		const agent: AgentRow = { index: 0, label: "solo", status: "running", startedAt: 0, sessionFile: file };
		const priv = panel as unknown as { promptEntryFor(a: AgentRow): { text: string; isChainOpenerFallback: boolean } };

		const miss1 = priv.promptEntryFor(agent);
		check("no user message at all -> unavailable", miss1.text, "prompt unavailable (session file missing)");

		// Overwrite with the REAL task, padded to the exact same byte size as the
		// miss — proving the re-attempt is gated on the size actually changing,
		// not merely on being asked again.
		const pad = "x".repeat(Math.max(0, missSize - realLen));
		writeFileSync(file, realCore + pad, "utf8");
		check("padded to the exact same size as the miss (sanity check on the fixture itself)", statSync(file).size, missSize);

		const stillMissed = priv.promptEntryFor(agent);
		check("same size -> the cached miss is reused, NOT re-read", stillMissed.text, "prompt unavailable (session file missing)");

		// Now the file genuinely grows — the miss is invalidated.
		writeFileSync(file, `${realCore}${pad}Z`, "utf8");
		const grown = priv.promptEntryFor(agent);
		check("a size change re-attempts and finds the real prompt", grown.text, "do the thing");

		panel.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(storeDir, { recursive: true, force: true });
	}
}

// --------------------------------------------- countToolCalls chunking (Finding 4)

console.log("\n--- store: countToolCalls loops in chunks, honoring a short/partial read ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-toolcount-chunk-"));
	try {
		const file = join(dir, "a.jsonl");
		const toolLine = () => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } })}\n`;
		// Ten calls, scanned with a deliberately tiny chunk size well under the
		// file's own size — the read loop then has to make several readSync
		// calls to fill its buffer, the same shape a genuine short read forces,
		// but deterministic rather than depending on the OS actually handing one
		// back (see the doc comment on countToolCalls' readChunkBytes parameter).
		writeFileSync(file, toolLine().repeat(10), "utf8");
		const chunked = countToolCalls(file, undefined, 7);
		check("every call is still counted across many small reads", chunked.count, 10);
		check("the whole file is marked scanned", chunked.offset, statSync(file).size);
		check("small enough for a single first look — not capped", chunked.capped, false);

		// The incremental (resume-from-offset) path also honors a tiny chunk size
		// across an appended span.
		appendFileSync(file, toolLine().repeat(3), "utf8");
		const resumed = countToolCalls(file, chunked, 7);
		check("an appended span is fully consumed in small chunks too", resumed.count, 13);
		check("capped-ness carries forward from the previous tally", resumed.capped, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\n--- store: countToolCalls caps a large foreign file's first tally, and the panel shows '>= M' ---");
{
	const dir = mkdtempSync(join(tmpdir(), "wf-toolcount-cap-"));
	try {
		const file = join(dir, "a.jsonl");
		const toolLine = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } })}\n`;
		// A file already well past the 32MB first-tally cap (store.ts's
		// FIRST_TALLY_CAP_BYTES) the first time this process ever looks at it —
		// standing in for a foreign, already-large transcript from another
		// session. The five calls sit at the very END, comfortably inside the
		// scanned tail regardless of exactly where the cap lands.
		const capBytes = 32 * 1024 * 1024;
		const prefix = Buffer.alloc(capBytes + 1024 * 1024, "x");
		writeFileSync(file, Buffer.concat([prefix, Buffer.from(toolLine.repeat(5), "utf8")]));

		const capped = countToolCalls(file);
		check("a first tally over the cap does not start at byte 0", capped.capped, true);
		check("the calls within the scanned tail are still counted", capped.count, 5);
		check("the offset reaches the true end of the file", capped.offset, statSync(file).size);

		// The panel renders that as a floor ("at least M"), not a bare number.
		const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text } as any;
		const storeDir = mkdtempSync(join(tmpdir(), "wf-toolcount-cap-store-"));
		try {
			const panel = new WorkflowsPanel(
				{ agentDir: storeDir, registry: new RunRegistry(), sessionId: SESSION, notify: () => {}, requestRender: () => {}, rows: () => 40 },
				theme,
				() => {},
			);
			const agent: AgentRow = { index: 0, label: "solo", status: "done", startedAt: 0, endedAt: 1, sessionFile: file };
			const section = (
				panel as unknown as { activitySection(a: AgentRow, room: number): string[] }
			).activitySection(agent, 20);
			check("the activity heading shows a floor, not an exact count", section.some((l) => l.includes(">= 5")), true);
			panel.dispose();
		} finally {
			rmSync(storeDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
