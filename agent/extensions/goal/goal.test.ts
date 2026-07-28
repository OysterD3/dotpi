/**
 * Unit coverage for the /goal pure logic: verdict parsing, the too-long
 * detector, evaluator model selection, transcript budgeting, goal state and its
 * persistence round-trip, the settings loader, and the render helpers whose
 * wording is load-bearing.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/goal/goal.test.ts
 *
 * pi only auto-loads `index.ts` from an extension folder, so this file sits here
 * harmlessly next to the thing it tests. The network path (a real evaluator
 * call) is not exercised offline; `evaluate()` is covered through its pure
 * parts — selectModel, isTooLong, toVerdict, extractJson.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { extractJson, selectModel, toVerdict } from "./judge.ts";
import { resolveModel } from "./model.ts";
import { formatDuration, formatTokens, oneLine, plural, statsLine, summaryLine } from "./render.ts";
import { loadSettings } from "./settings.ts";
import { goalElapsed, GoalState, restoreGoal, tokensSpent, type GoalEntryData } from "./state.ts";
import { buildSections, buildTranscript, fitSections } from "./transcript.ts";
import { TRUNCATION_NOTICE } from "./prompts.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------ judge.ts

console.log("--- pulling JSON out of a model response ---");
check("bare object", extractJson('{"ok":true,"reason":"tests pass"}'), { ok: true, reason: "tests pass" });
check("fenced", extractJson('```json\n{"ok":false,"reason":"no"}\n```'), { ok: false, reason: "no" });
check("prose around it", extractJson('Sure thing:\n{"ok":true,"reason":"done"}\nHope that helps'), {
	ok: true,
	reason: "done",
});
// A brace inside a quoted reason must not end the scan early.
check("brace inside a string", extractJson('{"ok":false,"reason":"missing } in file"}'), {
	ok: false,
	reason: "missing } in file",
});
check("nested object", extractJson('{"ok":true,"reason":"x","meta":{"a":1}}'), { ok: true, reason: "x", meta: { a: 1 } });
check("no JSON at all", extractJson("I could not decide."), undefined);
check("unterminated", extractJson('{"ok":true'), undefined);

console.log("\n--- verdicts ---");
check("ok:true is met", toVerdict({ ok: true, reason: "all green" }), { kind: "met", reason: "all green" });
check("ok:false is not met", toVerdict({ ok: false, reason: "3 failing" }), { kind: "not_met", reason: "3 failing" });
check("impossible needs ok:false", toVerdict({ ok: false, impossible: true, reason: "no such repo" }), {
	kind: "impossible",
	reason: "no such repo",
});
// `impossible` is only meaningful when ok is false, and a judge that says met
// never blocks — so a stray impossible on a met verdict must not turn success
// into failure.
check("impossible is ignored when ok:true", toVerdict({ ok: true, impossible: true, reason: "x" }), {
	kind: "met",
	reason: "x",
});
check("missing reason still parses", toVerdict({ ok: false }), { kind: "not_met", reason: "no reason given" });
check("blank reason still parses", toVerdict({ ok: true, reason: "   " }), { kind: "met", reason: "no reason given" });
// Anything unreadable is an error, never a silent pass: an unparseable judge
// must not be able to end a goal.
check("no boolean ok is an error", toVerdict({ reason: "hmm" }).kind, "error");
check("not an object is an error", toVerdict("nope").kind, "error");
check("null is an error", toVerdict(null).kind, "error");
check("string ok is an error", toVerdict({ ok: "true", reason: "x" }).kind, "error");

console.log("\n--- picking the evaluator model ---");
const M = (provider: string, id: string, name = id) => ({ provider, id, name, contextWindow: 200_000 });
const MODELS = [
	M("anthropic", "claude-haiku-4-5"),
	M("anthropic", "claude-haiku-4-5-20251001"),
	M("anthropic", "claude-sonnet-5", "Sonnet 5"),
	M("openai-codex", "gpt-5.6-sol"),
	M("openrouter", "claude-haiku-4-5"), // same id, different provider — bare id is ambiguous
];
const SESSION = M("openai-codex", "gpt-5.6-sol");
const fakeCtx = (model: unknown) =>
	({ model, modelRegistry: { getAll: () => MODELS } }) as unknown as Parameters<typeof selectModel>[0];

const pick = (reference: string | undefined, model: unknown = SESSION) => {
	const result = selectModel(fakeCtx(model), reference);
	return "error" in result ? `ERR: ${result.error}` : `${result.model.provider}/${result.model.id}`;
};
/** Same, but with no session model at all — a default parameter would hide it. */
const pickWithoutSession = (reference: string | undefined) => pick(reference, null);

// Judging belongs on a small, fast model; pi has no such concept, so goal.model
// names one and an unset value falls back to the session model.
check("unset falls back to the session model", pick(undefined), "openai-codex/gpt-5.6-sol");
check("canonical reference wins", pick("anthropic/claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
check("partial reference resolves", pick("sonnet"), "anthropic/claude-sonnet-5");
check("an ambiguous bare id is an error, not a guess", pick("claude-haiku-4-5").startsWith("ERR:"), true);
check("an unknown reference is an error", pick("gpt-9").startsWith("ERR:"), true);
check("no model at all is an error", pickWithoutSession(undefined), "ERR: no model selected");
// A bad goal.model must not silently fall back — that would send the transcript
// somewhere the user did not choose.
check("a bad reference does not fall back", pick("gpt-9").includes("gpt-5.6-sol"), false);

console.log("\n--- resolveModel error wording names its own key ---");
check("error mentions goal.model", resolveModel("nope", MODELS), {
	ok: false,
	error: 'goal.model "nope" matched no available model',
});

// -------------------------------------------------------------- transcript.ts

console.log("\n--- flattening the transcript ---");
const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
const SESSION_ENTRIES = [
	msg("user", "fix the parser"),
	msg("assistant", "on it"),
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "pnpm test" } }],
		},
	},
	{ type: "custom", customType: "goal_state" },
	msg("system", "ignored"),
	msg("user", "thanks"),
];

check("only user and assistant messages survive", buildSections(SESSION_ENTRIES), [
	"User: fix the parser",
	"Assistant: on it",
	'Tool bash was called with args {"command":"pnpm test"}',
	"User: thanks",
]);
check("empty branch is empty", buildSections([]), []);

console.log("\n--- budgeting the transcript ---");
{
	const wide = buildTranscript(SESSION_ENTRIES, 200_000);
	check("nothing dropped when it fits", wide.dropped, 0);
	check("no truncation notice when it fits", wide.text.includes("truncated"), false);

	// contextWindow 10 -> 10 * 0.5 * 4 = 20 chars, so only the last section fits.
	const tight = buildTranscript(SESSION_ENTRIES, 10);
	check("oldest sections are dropped first", tight.text.endsWith("User: thanks"), true);
	check("dropped count is reported", tight.dropped, 3);
	check("a truncation notice is prepended", tight.text.startsWith("[Earlier conversation truncated"), true);
	// The newest section is kept even when it alone exceeds the budget — an empty
	// transcript would make every check "insufficient evidence" forever.
	check("the newest section is never dropped", buildTranscript(SESSION_ENTRIES, 1).dropped, 3);

	// The retry runs at half the budget, so a smaller fraction must drop strictly
	// more, or the retry would resend the same oversized request.
	const half = buildTranscript(SESSION_ENTRIES, 60, CONFIG.retryBudgetFraction);
	const full = buildTranscript(SESSION_ENTRIES, 60, CONFIG.transcriptBudgetFraction);
	check("the retry budget is half the first", CONFIG.retryBudgetFraction * 2, CONFIG.transcriptBudgetFraction);
	check("the retry keeps less", half.dropped > full.dropped, true);

	// The judge flattens once and re-slices per attempt. Asserting fitSections
	// against buildTranscript would be circular — buildTranscript IS
	// fitSections(buildSections(...)) — so these pin the output itself.
	const sections = buildSections(SESSION_ENTRIES);
	check("fitSections keeps everything when it fits", fitSections(sections, 200_000), {
		text: sections.join("\n\n"),
		dropped: 0,
	});
	check("fitSections drops the oldest to fit", fitSections(sections, 10), {
		text: `${TRUNCATION_NOTICE(3)}\n\nUser: thanks`,
		dropped: 3,
	});
	// Re-slicing the same sections must not mutate them: the judge fits twice.
	fitSections(sections, 10);
	check("slicing does not consume the sections", sections.length, 4);

	// The retry only helps when the smaller budget actually yields a smaller
	// prompt. fitSections always keeps the newest section, so one oversized
	// message makes both budgets identical — the judge must not pay twice for it.
	const oversized = ["User: a", "User: b", `User: ${"x".repeat(5000)}`];
	const wideFit = fitSections(oversized, 200, CONFIG.transcriptBudgetFraction);
	const narrowFit = fitSections(oversized, 200, CONFIG.retryBudgetFraction);
	check("a single oversized message survives any budget", wideFit.text, narrowFit.text);
}

// ------------------------------------------------------------------ state.ts

console.log("\n--- goal state ---");
{
	const entries: { type: string; customType?: string; data?: unknown }[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as never;

	const state = new GoalState(pi);
	check("nothing active to begin with", state.get(), undefined);

	const goal = state.set("all tests pass", 1000);
	check("set records the condition", goal.condition, "all tests pass");
	check("set starts at zero iterations", goal.iterations, 0);
	check("set captures the token baseline", goal.tokensAtStart, 1000);

	check("a miss increments", state.recordMiss("2 failing"), 1);
	check("and remembers why", state.get()?.lastReason, "2 failing");
	check("misses accumulate", state.recordMiss("1 failing"), 2);

	// One evaluation at a time: agent_end can fire again mid-call.
	check("the first evaluation claims the lock", state.beginEvaluation(), true);
	check("a second is refused", state.beginEvaluation(), false);
	state.endEvaluation();
	check("and the lock is reusable", state.beginEvaluation(), true);
	state.endEvaluation();

	const cleared = state.clear();
	check("clear returns what was active", cleared?.condition, "all tests pass");
	check("and nothing is active after", state.get(), undefined);
	check("clearing twice is harmless", state.clear(), undefined);

	console.log("\n--- persistence round-trip ---");
	check("every state change was written", entries.length, 4); // set + 2 misses + clear
	const restored = restoreGoal(entries);
	// The newest entry wins and it recorded a clear, so a resume must not revive it.
	check("a cleared goal does not come back", restored, undefined);

	const midway = restoreGoal(entries.slice(0, 3));
	check("an active goal is restored", midway?.condition, "all tests pass");
	check("with its iteration count", midway?.iterations, 2);
	check("and its token baseline", midway?.tokensAtStart, 1000);

	check("no goal entries means no goal", restoreGoal([{ type: "message" }]), undefined);
	const malformed: { type: string; customType?: string; data?: unknown }[] = [
		{ type: "custom", customType: "goal_state", data: { active: true } as unknown as GoalEntryData },
	];
	check("a malformed entry is not a goal", restoreGoal(malformed), undefined);
}

// --------------------------------------------------------------- settings.ts

console.log("\n--- settings ---");
{
	const dir = mkdtempSync(join(tmpdir(), "goal-settings-"));
	const project = join(dir, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });

	const write = (path: string, body: unknown) => writeFileSync(path, JSON.stringify(body));
	const userPath = join(dir, "settings.json");
	const projectPath = join(project, ".pi", "settings.json");

	check("defaults with no files", loadSettings(dir, project, true).settings, {
		model: undefined,
		maxIterations: CONFIG.maxIterations,
	});

	write(userPath, { goal: { model: "anthropic/claude-haiku-4-5", maxIterations: 5 } });
	check("the user block is read", loadSettings(dir, project, true).settings, {
		model: "anthropic/claude-haiku-4-5",
		maxIterations: 5,
	});

	write(projectPath, { goal: { model: "openrouter/claude-haiku-4-5" } });
	check("a trusted project overrides", loadSettings(dir, project, true).settings.model, "openrouter/claude-haiku-4-5");
	// An untrusted clone must not redirect where the transcript is sent.
	check("an untrusted project does not", loadSettings(dir, project, false).settings.model, "anthropic/claude-haiku-4-5");
	check("and says so", loadSettings(dir, project, false).warnings.length, 1);

	// From here on, only the user file is in play — an untrusted project file
	// would add a warning of its own and muddle the counts below.
	rmSync(projectPath);

	write(userPath, { goal: { model: "  ", maxIterations: -1 } });
	const bad = loadSettings(dir, project, false);
	check("a blank model is rejected", bad.settings.model, undefined);
	check("a negative cap is rejected", bad.settings.maxIterations, CONFIG.maxIterations);
	check("both are reported", bad.warnings.length, 2);

	// 0 is the documented way to ask for no cap at all.
	write(userPath, { goal: { maxIterations: 0 } });
	check("zero disables the cap", loadSettings(dir, project, false).settings.maxIterations, 0);

	writeFileSync(userPath, "{ not json");
	check("unparseable settings are ignored, not fatal", loadSettings(dir, project, false).settings.maxIterations, CONFIG.maxIterations);
	check("and reported", loadSettings(dir, project, false).warnings.length, 1);

	rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------------- render.ts

console.log("\n--- duration, most significant unit only ---");
check("seconds", formatDuration(8_000), "8s");
check("just under a minute", formatDuration(59_400), "59s");
check("minutes drop the seconds", formatDuration(270_000), "4m");
check("hours drop the minutes", formatDuration(3_900_000), "1h");
check("negative clamps to zero", formatDuration(-5), "0s");

console.log("\n--- compact token counts ---");
check("small counts are plain", formatTokens(940), "940");
check("thousands", formatTokens(12_400), "12.4k");
check("a round thousand loses the .0", formatTokens(12_000), "12k");
check("millions", formatTokens(1_240_000), "1.2M");
// Rounding must not be allowed to print a value in the unit below it.
check("a value that rounds up crosses the unit", formatTokens(999_950), "1M");
check("and again at the next boundary", formatTokens(999_999_999), "1B");
check("billions have their own unit", formatTokens(2_500_000_000), "2.5B");
check("just under a boundary stays put", formatTokens(999_000), "999k");

console.log("\n--- plurals and one-lining ---");
check("one turn", plural(1, "turn"), "turn");
check("two turns", plural(2, "turn"), "turns");
check("zero turns", plural(0, "turn"), "turns");
check("newlines collapse", oneLine("a\n\n  b\tc "), "a b c");
check("long reasons are capped", oneLine("x".repeat(200), 10), "xxxxxxxxx…");

console.log("\n--- the /goal summary ---");
check("no goal points at the usage", summaryLine(undefined), "No goal set. Usage: `/goal <condition>`");
check(
	"an unevaluated goal says so",
	summaryLine({ condition: "all tests pass", iterations: 0, setAt: 0 }),
	"Goal active: all tests pass (not yet evaluated)",
);
check(
	"one turn is singular",
	summaryLine({ condition: "c", iterations: 1, setAt: 0 }),
	"Goal active: c (1 turn)",
);
check(
	"the last check is quoted back on its own line",
	summaryLine({ condition: "c", iterations: 3, setAt: 0, lastReason: "still 2 failing\n" }),
	"Goal active: c (3 turns)\nLast check: still 2 failing",
);

console.log("\n--- the outcome stat line ---");
check("duration, turns and tokens", statsLine({ durationMs: 64_000, iterations: 3, tokens: 12_400 }), "1m · 3 turns · 12.4k tokens");
check("one turn is singular here too", statsLine({ durationMs: 8_000, iterations: 1, tokens: 900 }), "8s · 1 turn · 900 tokens");
// pi cannot always estimate context tokens; the line drops the segment rather
// than printing a zero that would read as "this cost nothing".
check("unknown tokens are omitted", statsLine({ durationMs: 8_000, iterations: 2 }), "8s · 2 turns");

// ------------------------------------------------------------------ wiring

console.log("\n--- wiring against a fake pi ---");
{
	type Sent = { customType: string; content: string; details?: unknown; options?: unknown };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown; getArgumentCompletions?: (p: string) => unknown }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const renderers = new Set<string>();
	const entries: { customType: string; data?: unknown }[] = [];
	const sent: Sent[] = [];
	const notices: [string, string][] = [];

	const pi = {
		registerCommand: (name: string, options: never) => commands.set(name, options),
		registerMessageRenderer: (type: string) => renderers.add(`message:${type}`),
		registerEntryRenderer: (type: string) => renderers.add(`entry:${type}`),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendMessage: (message: Sent, options: unknown) => sent.push({ ...message, options }),
		on: (event: string, handler: never) => events.set(event, handler),
	};

	const ctx = {
		cwd: "/nowhere-that-exists",
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: { notify: (text: string, level: string) => notices.push([text, level]) },
	};

	const extension = (await import("./index.ts")).default;
	extension(pi as never);

	check("registers the command", commands.has("goal"), true);
	check("registers both renderers", [renderers.has("message:goal"), renderers.has("entry:goal_result")], [true, true]);
	check("hooks session_start", events.has("session_start"), true);
	check("hooks agent_end", events.has("agent_end"), true);
	check("completes 'clear'", commands.get("goal")!.getArgumentCompletions!("cl"), [
		{ value: "clear", label: "clear", description: "Clear the active goal" },
	]);
	check("offers nothing for a real condition", commands.get("goal")!.getArgumentCompletions!("all tests"), null);

	const run = async (args: string) => await commands.get("goal")!.handler(args, ctx);

	await events.get("session_start")!({}, ctx);
	await run("");
	check("no goal yet", notices.at(-1)?.[0], "No goal set. Usage: `/goal <condition>`");

	await run("clear");
	check("clearing nothing says so", notices.at(-1)?.[0], "No goal set");

	await run("x".repeat(CONFIG.maxConditionChars + 1));
	check("an over-long condition is rejected", notices.at(-1)?.[0], `Goal condition is limited to ${CONFIG.maxConditionChars} characters (got ${CONFIG.maxConditionChars + 1})`);
	check("and nothing was sent to the model", sent.length, 0);

	await run("all tests pass");
	check("setting a goal triggers a turn", sent.length, 1);
	check("the model is told to start work", sent[0]!.content.startsWith("A session-scoped goal check is now active"), true);
	check("and it is shown as a goal panel", sent[0]!.details, { kind: "set", condition: "all tests pass" });
	// setAt is deliberately NOT persisted: it is this session's clock, and the
	// entry banks elapsed work instead so a resume does not count time away.
	check("the goal is persisted", entries.at(-1), {
		customType: "goal_state",
		data: { active: true, condition: "all tests pass", iterations: 0, elapsedMs: 0, tokensAtStart: 500 },
	});

	await run("");
	check("the summary reports it", notices.at(-1)?.[0], "Goal active: all tests pass (not yet evaluated)");

	await run("CANCEL");
	check("a clear word is case-insensitive", notices.at(-1)?.[0], "Goal cleared: all tests pass");
	check("the clear is persisted too", (entries.at(-1)!.data as { active: boolean }).active, false);

	// With no goal active, ending a run must not reach the evaluator at all —
	// otherwise every ordinary turn would cost an extra LLM call.
	const before = sent.length;
	await events.get("agent_end")!({ type: "agent_end", messages: [] }, ctx);
	check("no goal means no evaluation", sent.length, before);
}

// ------------------------------------------------------- regression coverage

console.log("\n--- elapsed time is work time, not wall-clock across /resume ---");
{
	const entries: { type: string; customType?: string; data?: unknown }[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as never;

	const state = new GoalState(pi);
	const goal = state.set("ship it");
	// Pretend the goal was set 5s ago within this session.
	goal.setAt = Date.now() - 5_000;
	check("elapsed counts this session", Math.round(goalElapsed(goal, Date.now()) / 1000), 5);

	state.recordMiss("not yet"); // banks the 5s into the persisted entry
	const banked = (entries.at(-1)!.data as { elapsedMs: number }).elapsedMs;
	check("the persisted entry banks it", Math.round(banked / 1000), 5);

	// A resume hours later must not count the hours the session was closed.
	const restored = restoreGoal(entries)!;
	check("restore carries the banked time", Math.round(restored.elapsedMs / 1000), 5);
	check("and restarts this session's clock", restored.setAt <= Date.now() && restored.setAt > Date.now() - 1000, true);
	check("so elapsed is still ~5s, not the gap", Math.round(goalElapsed(restored, Date.now()) / 1000), 5);
	// The reason the judge last gave has to survive too, or /goal loses its "Last check:" line.
	check("lastReason survives a resume", restored.lastReason, "not yet");
}

console.log("\n--- clear() must not release an in-flight evaluation's lock ---");
{
	const state = new GoalState({ appendEntry: () => {} } as never);
	state.set("a");
	check("evaluation takes the lock", state.beginEvaluation(), true);
	state.clear();
	// Clearing used to reset `evaluating`, letting the next agent_end start a
	// second judge call alongside the first.
	check("clearing does not hand the lock away", state.beginEvaluation(), false);
	state.endEvaluation();
	check("only the owner releases it", state.beginEvaluation(), true);
}

console.log("\n--- token spend is omitted rather than reported as zero ---");
{
	const usage = (tokens: number | null | undefined) => ({
		getContextUsage: () => (tokens === undefined ? undefined : { tokens }),
	});
	check("normal growth is a delta", tokensSpent({ tokensAtStart: 1_000 }, usage(3_400)), 2_400);
	// A compaction leaves the current reading below the baseline. That is not
	// zero spend, it is unknowable — printing "0 tokens" would claim it was free.
	check("a compaction omits the segment", tokensSpent({ tokensAtStart: 80_000 }, usage(30_000)), undefined);
	check("no baseline, no figure", tokensSpent({}, usage(3_400)), undefined);
	check("no reading, no figure", tokensSpent({ tokensAtStart: 1_000 }, usage(null)), undefined);
	check("no usage at all, no figure", tokensSpent({ tokensAtStart: 1_000 }, usage(undefined)), undefined);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
