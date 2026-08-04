/**
 * Unit coverage for the /goal pure logic: verdict parsing, the too-long
 * detector, evaluator model selection, transcript budgeting, goal state and its
 * persistence round-trip, the settings loader, and the render helpers whose
 * wording is load-bearing. Also covers the autoCapture and compaction/resume
 * reassertion additions: extraction-response parsing, the capture trigger
 * gate, the pending-reassertion flag's transitions, and both features' wiring.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/goal/goal.test.ts
 *
 * pi only auto-loads `index.ts` from an extension folder, so this file sits here
 * harmlessly next to the thing it tests. The network path (a real evaluator or
 * extractor call) is not exercised offline; `evaluate()` and `extractCriteria()`
 * are covered through their pure parts — selectModel, isTooLong, toVerdict,
 * toExtraction, extractJson — and their wiring is exercised with no model
 * selected, so the network call fails fast on "no model selected" rather than
 * ever leaving the process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCaptureCandidate } from "./capture.ts";
import { CONFIG } from "./config.ts";
import { extractJson, selectModel, toExtraction, toVerdict } from "./judge.ts";
import { resolveModel } from "./model.ts";
import { formatDuration, formatTokens, oneLine, plural, statsLine, summaryLine } from "./render.ts";
import { loadSettings } from "./settings.ts";
import { goalElapsed, GoalState, restoreGoal, tokensSpent, type GoalEntryData } from "./state.ts";
import { buildSections, buildTranscript, fitSections } from "./transcript.ts";
import { reassertInstruction, systemReminder, TRUNCATION_NOTICE } from "./prompts.ts";

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

console.log("\n--- goal.autoCapture: extraction-response parsing ---");
check("a stated condition is criteria", toExtraction({ criteria: "tests pass" }), {
	kind: "criteria",
	criteria: "tests pass",
});
check("null criteria means nothing to capture", toExtraction({ criteria: null }), { kind: "none" });
check("surrounding whitespace is trimmed", toExtraction({ criteria: "  tests pass  " }), {
	kind: "criteria",
	criteria: "tests pass",
});
// A blank string means the same thing null does — err toward null must not
// become "set a goal with an empty condition" by accident.
check("a blank string is treated as null", toExtraction({ criteria: "   " }), { kind: "none" });
// Anything unreadable is an error, same stance as toVerdict: an extractor
// response we cannot understand must not be able to set a goal, silently or
// otherwise.
check("no 'criteria' field is an error", toExtraction({ reason: "hmm" }).kind, "error");
check("not an object is an error", toExtraction("nope").kind, "error");
check("null itself is an error, not none", toExtraction(null).kind, "error");
check("a number is an error", toExtraction({ criteria: 3 }).kind, "error");
check("a boolean is an error", toExtraction({ criteria: true }).kind, "error");

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

console.log("\n--- reassertion wording ---");
// Pinned exactly: this rides in hidden, with no chance to be asked about, so
// the wording is the whole of what tells the model the condition is still active.
check(
	"names the condition and the mechanism",
	reassertInstruction("all tests pass"),
	"Active goal (survives compaction): all tests pass. The stop check will evaluate it — keep working toward it.",
);
check("wrapped the way pi's own hidden reminders are", systemReminder("x"), "<system-reminder>\nx\n</system-reminder>");

// -------------------------------------------------------------------- capture.ts

console.log("\n--- goal.autoCapture: which input events are worth the one shot ---");
const inp = (text: string, over: Record<string, unknown> = {}) => ({ text, source: "interactive" as const, ...over });
check("a real request is a candidate", isCaptureCandidate(inp("build me a dashboard with a dark mode toggle")), true);
check("empty text is not", isCaptureCandidate(inp("")), false);
check("whitespace-only text is not", isCaptureCandidate(inp("   ")), false);
check("a slash command is not", isCaptureCandidate(inp("/goal all tests pass")), false);
check("a bang bash line is not", isCaptureCandidate(inp("!ls -la")), false);
// Too short to plausibly carry an acceptance criterion — the extraction call
// is the real classifier of "quick question vs. real request"; this only
// screens out messages that could not possibly qualify.
check("a greeting below the word floor is not", isCaptureCandidate(inp("hi")), false);
check("right at the floor qualifies", isCaptureCandidate(inp("a".repeat(CONFIG.minCaptureWords).split("").join(" "))), true);
check(
	"one word short of the floor does not",
	isCaptureCandidate(inp("a".repeat(CONFIG.minCaptureWords - 1).split("").join(" "))),
	false,
);
check("mid-turn steering is not a fresh prompt", isCaptureCandidate(inp("build the whole thing now", { streamingBehavior: "steer" })), false);
check("a follow-up is not a fresh prompt either", isCaptureCandidate(inp("build the whole thing now", { streamingBehavior: "followUp" })), false);
check("non-interactive input is not", isCaptureCandidate(inp("build the whole thing now", { source: "rpc" })), false);

// -------------------------------------------------------------------- transcript.ts

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

console.log("\n--- the pending-reassertion flag ---");
{
	const state = new GoalState({ appendEntry: () => {} } as never);

	check("nothing to consume before a goal exists", state.consumePendingReassertion(), false);
	// Arming with no active goal is a no-op: there is nothing to reassert.
	state.markPendingReassertion();
	check("marking without a goal stays unarmed", state.consumePendingReassertion(), false);

	state.set("ship it");
	state.markPendingReassertion();
	check("marking with an active goal arms it", state.consumePendingReassertion(), true);
	check("consuming clears it", state.consumePendingReassertion(), false);

	// Compaction and a restored /resume goal both call this; either should be
	// able to arm it once, and one before_agent_start should only ever pay once.
	state.markPendingReassertion();
	state.markPendingReassertion();
	check("marking twice is still one reassertion", state.consumePendingReassertion(), true);
	check("and it does not repeat", state.consumePendingReassertion(), false);

	// Clearing the goal must not leave a stale flag armed for a condition that
	// no longer exists.
	state.markPendingReassertion();
	state.clear();
	check("clear() drops a pending reassertion", state.consumePendingReassertion(), false);

	// adopt() swaps in a different session's state wholesale; a flag armed for
	// whatever was active before must not leak into what replaces it.
	state.set("goal A");
	state.markPendingReassertion();
	state.adopt(undefined);
	check("adopt() drops a stale pending reassertion", state.consumePendingReassertion(), false);

	// adopt() restoring an ACTIVE goal does not arm the flag itself — index.ts
	// calls markPendingReassertion() right after adopt(), which is what actually
	// arms it (see the session_start wiring test below).
	state.adopt({ condition: "goal B", iterations: 0, setAt: Date.now(), elapsedMs: 0 });
	check("adopt() alone does not arm it", state.consumePendingReassertion(), false);
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
		autoCapture: false,
	});

	write(userPath, { goal: { model: "anthropic/claude-haiku-4-5", maxIterations: 5 } });
	check("the user block is read", loadSettings(dir, project, true).settings, {
		model: "anthropic/claude-haiku-4-5",
		maxIterations: 5,
		autoCapture: false,
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

	console.log("\n--- autoCapture ---");
	check("off by default", loadSettings(dir, project, false).settings.autoCapture, false);
	write(userPath, { goal: { autoCapture: true } });
	check("a boolean is read", loadSettings(dir, project, true).settings.autoCapture, true);
	write(userPath, { goal: { autoCapture: "true" } });
	check("a non-boolean is rejected", loadSettings(dir, project, false).settings.autoCapture, false);
	check("and reported", loadSettings(dir, project, false).warnings.some((w) => w.includes("goal.autoCapture")), true);

	// A project turning autoCapture on is exactly the risk the whole block is
	// trust-gated against: an unattended judge call plus a stop-gate the user
	// never asked for. It must be dropped, and named, like model and maxIterations.
	writeFileSync(userPath, JSON.stringify({}));
	write(projectPath, { goal: { autoCapture: true } });
	check("an untrusted project cannot turn autoCapture on", loadSettings(dir, project, false).settings.autoCapture, false);
	check(
		"and the drop is named",
		loadSettings(dir, project, false).warnings.some((w) => w.includes("goal.autoCapture")),
		true,
	);
	check("but a trusted one can", loadSettings(dir, project, true).settings.autoCapture, true);
	rmSync(projectPath);

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

console.log("\n--- goal.autoCapture wiring ---");
{
	// A trusted project turns autoCapture on — see settings.ts's trust-gating
	// tests above for why it has to be trusted to do that at all.
	const projectDir = mkdtempSync(join(tmpdir(), "goal-capture-"));
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ goal: { autoCapture: true } }));

	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const entries: { customType: string; data?: unknown }[] = [];
	const notices: [string, string][] = [];
	const pi = {
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendMessage: () => {},
		on: (event: string, handler: never) => events.set(event, handler),
	};
	const ctx = {
		cwd: projectDir,
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: { notify: (text: string, level: string) => notices.push([text, level]) },
		// No model selected anywhere: extractCriteria must fail on
		// "no model selected" before it ever reaches modelRegistry or the
		// network, which is what keeps this test offline.
		model: undefined,
	};

	const extension = (await import("./index.ts")).default;
	extension(pi as never);
	await events.get("session_start")!({}, ctx);

	const input = events.get("input")!;
	const start = events.get("before_agent_start")!;
	const turn = async (text: string) => {
		await input({ type: "input", text, source: "interactive" }, ctx);
		return start({ type: "before_agent_start", prompt: text, systemPrompt: "" }, ctx);
	};

	check("a slash command spends nothing", await turn("/goal all tests pass"), undefined);
	check("and sets no goal", entries.length, 0);

	check("a greeting below the word floor spends nothing", await turn("hi there"), undefined);
	check("still no goal", entries.length, 0);

	// The first real work-opening prompt: the one shot fires. With no model
	// selected the extraction call fails fast, and that failure is reported —
	// not silently swallowed — and does not set a goal.
	notices.length = 0;
	await turn("build a login form that validates email and password and submits to the api");
	check("extraction failure is reported, not silent", notices.at(-1)?.[1], "warning");
	check("naming autoCapture", notices.at(-1)?.[0]?.includes("goal.autoCapture"), true);
	check("no goal is set on failure", entries.length, 0);

	// The one shot is spent, whether or not it produced a goal: a second
	// qualifying message must not try again.
	notices.length = 0;
	await turn("build something else entirely, a perfectly good long request");
	check("the one shot cannot fire twice", notices.length, 0);

	rmSync(projectDir, { recursive: true, force: true });
}

console.log("\n--- compaction and /resume reassertion wiring ---");
{
	type Sent = { customType: string; content: string; details?: unknown; options?: unknown };
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sent: Sent[] = [];
	const pi = {
		registerCommand: (name: string, options: never) => commands.set(name, options),
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		sendMessage: (message: Sent, options: unknown) => sent.push({ ...message, options }),
		on: (event: string, handler: never) => events.set(event, handler),
	};
	const ctx = {
		cwd: "/nowhere-that-exists",
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: { notify: () => {} },
	};

	const extension = (await import("./index.ts")).default;
	extension(pi as never);
	await events.get("session_start")!({}, ctx);
	await commands.get("goal")!.handler("ship the thing", ctx);

	const start = events.get("before_agent_start")!;
	const turn = () => start({ type: "before_agent_start", prompt: "continue", systemPrompt: "" }, ctx) as Promise<
		{ message?: { customType: string; content: string; display: boolean } } | undefined
	>;

	check("no reassertion without a compaction", await turn(), undefined);

	await events.get("session_compact")!({ type: "session_compact" }, ctx);
	const reasserted = await turn();
	check("compaction arms exactly one hidden reminder", reasserted?.message?.display, false);
	check("it names the active condition", reasserted?.message?.content.includes("ship the thing"), true);
	check("wrapped as a system-reminder", reasserted?.message?.content.startsWith("<system-reminder>"), true);
	check("using the reassert customType", reasserted?.message?.customType, "goal_reassert");

	check("consumed exactly once", await turn(), undefined);

	// Clearing the goal after a compaction must not leave a reassertion armed
	// for a condition that no longer exists.
	await events.get("session_compact")!({ type: "session_compact" }, ctx);
	await commands.get("goal")!.handler("clear", ctx);
	check("clearing the goal drops a pending reassertion too", await turn(), undefined);
}

console.log("\n--- reassertion after a /resume restore ---");
{
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		on: (event: string, handler: never) => events.set(event, handler),
	};
	const branch = [
		{
			type: "custom",
			customType: "goal_state",
			data: { active: true, condition: "ship it", iterations: 0, elapsedMs: 0 },
		},
	];
	const ctx = {
		cwd: "/nowhere-that-exists",
		isProjectTrusted: () => false,
		getContextUsage: () => ({ tokens: 500, contextWindow: 200_000, percent: 1 }),
		sessionManager: { getBranch: () => branch },
		ui: { notify: () => {} },
	};

	const extension = (await import("./index.ts")).default;
	extension(pi as never);
	await events.get("session_start")!({ reason: "resume" }, ctx);

	const start = events.get("before_agent_start")!;
	const turn = () => start({ type: "before_agent_start", prompt: "continue", systemPrompt: "" }, ctx) as Promise<
		{ message?: { customType: string; content: string } } | undefined
	>;

	const reasserted = await turn();
	check("a restored goal is reasserted on the very next turn", reasserted?.message?.customType, "goal_reassert");
	check("naming the restored condition", reasserted?.message?.content.includes("ship it"), true);
	check("and only once", await turn(), undefined);
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
