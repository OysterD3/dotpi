/**
 * Unit coverage for /simplify and /code-review: argument parsing, fan-out
 * detection, finder budgeting, angle selection per level, and the assembled
 * prompts.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/review/review.test.ts
 *
 * The prompts are the product here, so they are asserted on directly: a level
 * that silently stopped naming its cap, or an inline variant that stopped
 * admitting it ran inline, is a real regression with no other symptom.
 */
import { parseArgs, tokenize } from "./args.ts";
import { SIMPLIFY_ANGLES } from "./angles.ts";
import { anglesFor, cleanupAngles, CONFIG, correctnessAngles, LEVELS, LEVEL_SPECS } from "./config.ts";
import { detectFanOut } from "./index.ts";
import { allowsUncertainty, finderBudget } from "./phases.ts";
import { codeReviewPrompt, simplifyPrompt } from "./prompt.ts";

/** The phase numbers a prompt actually emits, in order. */
function phaseNumbers(prompt: string): number[] {
	return [...prompt.matchAll(/^## Phase (\d+) —/gm)].map((m) => Number(m[1]));
}

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// -------------------------------------------------------------------- args

console.log("--- parsing [level] [--fix] [<target>] ---");
check("bare defaults to medium", parseArgs(""), { level: "medium", target: "", fix: false, unrecognizedLevel: undefined, unknownFlags: [] });
check("a level is taken", parseArgs("max").level, "max");
check("case-insensitive", parseArgs("MAX").level, "max");
check("level plus target", parseArgs("high src/parser.ts"), { level: "high", target: "src/parser.ts", fix: false, unknownFlags: [] });
check("--fix anywhere", parseArgs("max --fix").fix, true);
check("--fix before the level", parseArgs("--fix low").level, "low");
check("--fix is not a target", parseArgs("--fix").target, "");

// The failure that matters: a path must never be eaten as a level, or the
// review silently widens to the whole diff.
console.log("\n--- a target is not a level ---");
check("a path stays a target", parseArgs("src/parser.ts").target, "src/parser.ts");
check("and keeps the default level", parseArgs("src/parser.ts").level, "medium");
check("a ref range stays a target", parseArgs("main...HEAD").target, "main...HEAD");
check("a multi-word instruction survives", parseArgs("focus on the parser").target, "focus on the parser");
check("a level plus instruction", parseArgs("max focus on the parser"), { level: "max", target: "focus on the parser", fix: false, unknownFlags: [] });

// A near-miss level is a typo, not a target: reviewing everything at the
// default level would hide it.
console.log("\n--- a mistyped level is reported, not silently reinterpreted ---");
check("a near-miss is flagged", parseArgs("hi").unrecognizedLevel, "hi");
check("and does not become the target", parseArgs("hi").target, "");
check("a path is never flagged", parseArgs("src/a.ts").unrecognizedLevel, undefined);
check("nor is a multi-word target", parseArgs("check the parser").unrecognizedLevel, undefined);

// ---------------------------------------------------------------- fan-out

console.log("\n--- picking a fan-out tool ---");
check("workflow wins when both are active", detectFanOut(["task", "workflow", "read"]), "workflow");
check("task when it is alone", detectFanOut(["task", "read"]), "task");
check("neither means inline", detectFanOut(["read", "bash"]), "none");
check("an empty tool list means inline", detectFanOut([]), "none");

// ------------------------------------------------------------ budgeting

console.log("\n--- sizing the finder fleet to the diff ---");
check("a tiny diff still gets the floor", finderBudget(1), CONFIG.minFinders);
check("zero lines gets the floor", finderBudget(0), CONFIG.minFinders);
check("one finder per 150 lines", finderBudget(600), 4);
check("rounded up", finderBudget(601), 5);
check("a huge diff is capped", finderBudget(100_000), CONFIG.maxFinders);
check("the cap is not exceeded", finderBudget(Number.MAX_SAFE_INTEGER) <= CONFIG.maxFinders, true);

// ------------------------------------------------------------ angles

console.log("\n--- angles scale with level ---");
for (const level of LEVELS) {
	const total = correctnessAngles(level).length + cleanupAngles(level).length;
	check(`${level} has angles`, total > 0, true);
}
check("low is the narrowest", correctnessAngles("low").length, 1);
check("max is the widest", correctnessAngles("max").length, 5);
check("angle count never shrinks as level rises", LEVELS.every((l, i) => i === 0 || correctnessAngles(l).length >= correctnessAngles(LEVELS[i - 1]!).length), true);
// Quick reviews stay on correctness: a style nit is not what someone running
// /code-review low is asking for.
check("low and medium carry no cleanup angles", [cleanupAngles("low").length, cleanupAngles("medium").length], [0, 0]);
check("max carries all of them", cleanupAngles("max").length, 5);

console.log("\n--- uncertainty is earned by level ---");
check("low reports only what it can confirm", allowsUncertainty("low"), false);
check("medium too", allowsUncertainty("medium"), false);
check("high may hedge", allowsUncertainty("high"), true);
check("and max", allowsUncertainty("max"), true);

// ------------------------------------------------------------- prompts

console.log("\n--- /simplify ---");
{
	const parallel = simplifyPrompt("task", "");
	check("names the tool it will use", parallel.includes("`task` tool"), true);
	check("runs four agents", parallel.includes(`${CONFIG.simplifyAngles} cleanup agents in parallel`), true);
	check("carries all four angles", ["### Reuse", "### Simplification", "### Efficiency", "### Altitude"].every((a) => parallel.includes(a)), true);
	check("gathers the diff first", parallel.includes("## Phase 0 — Gather the diff"), true);
	check("includes the working tree", parallel.includes("git diff HEAD"), true);
	check("says it is not a bug hunt", parallel.includes("not hunting for bugs"), true);
	check("points at the other command", parallel.includes("/code-review"), true);

	const workflow = simplifyPrompt("workflow", "");
	check("workflow variant names workflow", workflow.includes("`workflow` tool"), true);
	// The async contract: a workflow fleet must not hold the turn hostage —
	// the agent ends its turn and resumes on the result message.
	check("workflow variant runs in the background", workflow.includes("END YOUR TURN"), true);
	check("workflow variant resumes on the result message", workflow.includes('"workflow-result" message'), true);
	check("task variant still waits inline", simplifyPrompt("task", "").includes(`Wait for all ${CONFIG.simplifyAngles} agents`), true);
	check("workflow variant does not wait inline", workflow.includes("Wait for all"), false);

	const inline = simplifyPrompt("none", "");
	check("inline still carries every angle", ["### Reuse", "### Simplification", "### Efficiency", "### Altitude"].every((a) => inline.includes(a)), true);
	check("inline does not claim a fan-out", inline.includes("agents in parallel"), false);
	// The honesty clause: an inline pass must not be reported as the fleet.
	check("inline is told to admit what ran", inline.includes("isn't misled about what actually ran"), true);

	const targeted = simplifyPrompt("task", "src/parser.ts");
	check("a target is stated", targeted.includes("Review target: `src/parser.ts`"), true);
	check("and omitted when absent", parallel.includes("Review target"), false);
}

console.log("\n--- /code-review ---");
{
	const max = codeReviewPrompt("max", "workflow", "", 6, false);
	check("names the level and fleet", max.includes("`/code-review max → 6 finders + verify → ≤15 findings`"), true);
	check("carries all five correctness angles", ["Angle A", "Angle B", "Angle C", "Angle D", "Angle E"].every((a) => max.includes(a)), true);
	check("has a verify phase", max.includes("## Phase 2 — Verify"), true);
	check("tells verifiers to refute", max.includes("told to\nREFUTE"), true);
	check("carries the plausible-by-default bias", max.includes("**PLAUSIBLE by default**"), true);
	check("states the cap twice over", max.includes("at most 15 objects") && max.includes("keep the 15 most"), true);
	check("allows uncertainty", max.includes("Include PLAUSIBLE findings"), true);
	check("explains how cleanup ranks against bugs", max.includes("Correctness bugs always outrank"), true);
	// The async contract, same as /simplify's workflow shape.
	check("workflow shape runs in the background", max.includes("END YOUR TURN"), true);
	check("workflow shape resumes on the result message", max.includes('"workflow-result" message'), true);
	check("task shape carries no background contract", codeReviewPrompt("low", "task", "", 2, false).includes("END YOUR TURN"), false);

	const low = codeReviewPrompt("low", "task", "", 2, false);
	check("low caps lower", low.includes("at most 5 objects"), true);
	check("low refuses to hedge", low.includes("Report only CONFIRMED findings"), true);
	check("low is precision-framed", low.includes("**precision**"), true);
	check("low carries no cleanup shape", low.includes("Correctness bugs always outrank"), false);

	const inline = codeReviewPrompt("high", "none", "", 2, false);
	check("inline has no verify phase", inline.includes("## Phase 2 — Verify"), false);
	check("inline self-checks instead", inline.includes("## Phase 2 — Dedup and self-check"), true);
	// Same honesty rule as /simplify: no independent verify pass ran, so say so.
	check("inline admits there was no verify pass", inline.includes("independent verify pass"), true);
	check("inline still carries the rubric", inline.includes("**CONFIRMED**"), true);

	const fixing = codeReviewPrompt("max", "workflow", "", 4, true);
	// Phases are numbered as emitted: max sweeps, so apply lands at 5 here.
	check("--fix adds an apply phase", /## Phase \d+ — Apply/.test(fixing), true);
	check("and is absent without it", /## Phase \d+ — Apply/.test(max), false);
	check("phase numbers are contiguous from 0", phaseNumbers(fixing), [0, 1, 2, 3, 4, 5]);
	check("and contiguous without --fix", phaseNumbers(max), [0, 1, 2, 3, 4]);

	// Every level must produce a usable prompt: a missing cap or empty angle
	// list would only show up as a vague review at runtime.
	for (const level of LEVELS) {
		const text = codeReviewPrompt(level, "task", "", 3, false);
		check(`${level} states its cap`, text.includes(`at most ${LEVEL_SPECS[level].cap} objects`), true);
		check(`${level} gathers the diff`, text.includes("## Phase 0 — Gather the diff"), true);
		check(`${level} has at least one angle`, text.includes("### Angle A"), true);
	}
}

// ------------------------------------------------------------------ wiring

console.log("\n--- wiring against a fake pi ---");
{
	type Sent = { customType: string; content: string; display?: boolean };
	const commands = new Map<string, { description: string; handler: (a: string, c: unknown) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }>();
	const sent: Sent[] = [];
	const notices: [string, string][] = [];
	let active: string[] = ["read", "bash"];

	const pi = {
		registerCommand: (name: string, options: never) => commands.set(name, options),
		sendMessage: (message: Sent) => sent.push(message),
		getActiveTools: () => active,
	};
	const ctx = { cwd: "/nowhere-that-exists", ui: { notify: (t: string, l: string) => notices.push([t, l]) } };

	const extension = (await import("./index.ts")).default;
	extension(pi as never);

	check("registers /simplify", commands.has("simplify"), true);
	check("registers /code-review", commands.has("code-review"), true);
	check("the code-review description lists the levels", commands.get("code-review")!.description.includes("low|medium|high|xhigh|max"), true);
	check("completes levels", (commands.get("code-review")!.getArgumentCompletions!("m") as {value: string}[]).map((o) => o.value), ["medium", "max"]);
	check("completes --fix", (commands.get("code-review")!.getArgumentCompletions!("--") as {value: string}[]).map((o) => o.value), ["--fix"]);
	check("offers nothing for a path", commands.get("code-review")!.getArgumentCompletions!("src/"), null);

	// The injected turn is the deliverable, and it must stay out of the
	// transcript UI: the prompt is machinery, not something to read.
	await commands.get("simplify")!.handler("", ctx);
	check("simplify injects one turn", sent.length, 1);
	check("and does not display it", sent[0]!.display, false);
	check("with no fan-out tool active, it says so", sent[0]!.content.includes("no subagent tool"), true);

	active = ["read", "task"];
	await commands.get("simplify")!.handler("", ctx);
	check("with task active, it fans out", sent.at(-1)!.content.includes("`task` tool"), true);

	active = ["read", "task", "workflow"];
	await commands.get("simplify")!.handler("", ctx);
	check("workflow is preferred", sent.at(-1)!.content.includes("`workflow` tool"), true);

	await commands.get("code-review")!.handler("max", ctx);
	check("code-review injects a turn", sent.at(-1)!.content.startsWith("`/code-review max"), true);
	// cwd does not exist, so the diff cannot be measured; the fleet must fall
	// back to the floor rather than to zero finders.
	// An unmeasurable diff is not a small one, so it must not get the floor.
	check("an unmeasurable diff does not get the floor", sent.at(-1)!.content.includes(`→ ${CONFIG.minFinders} finders`), false);
	check("it gets the unmeasurable default", sent.at(-1)!.content.includes(`→ ${CONFIG.unmeasurableFinders} finders`), true);

	await commands.get("code-review")!.handler("hi", ctx);
	check("a mistyped level warns", notices.at(-1)?.[1], "warning");
	check("and still runs at the default", sent.at(-1)!.content.startsWith(`\`/code-review ${CONFIG.defaultLevel}`), true);
}

// ------------------------------------------------------- regression coverage

console.log("\n--- a single-word target is not a mistyped level ---");
// The heuristic used to be "one short word, no slash or dot", which ate every
// one of these and silently widened the review to the whole diff.
for (const target of ["HEAD~1", "main", "src", "packages", "Makefile", "4821", "#4821", "v2", "HEAD"]) {
	check(`\`${target}\` survives as a target`, parseArgs(target).target, target);
	check(`and is not flagged`, parseArgs(target).unrecognizedLevel, undefined);
}
// Only genuine near-misses are typos: prefix in either direction.
for (const typo of ["hi", "med", "lo", "maximum", "xh"]) {
	check(`\`${typo}\` is a mistyped level`, parseArgs(typo).unrecognizedLevel, typo);
}
check("a level name is never a near-miss", parseArgs("max").unrecognizedLevel, undefined);
// With more words after it, the first word starts a target however level-ish.
check("only a lone word can be a typo", parseArgs("hi there").target, "hi there");

console.log("\n--- tokenizing ---");
check("splits on runs of whitespace", tokenize("  max   src/a.ts  "), ["max", "src/a.ts"]);
check("empty is empty", tokenize("   "), []);

console.log("\n--- flags are recognised, not turned into targets ---");
check("--fix is case-insensitive", parseArgs("max --FIX").fix, true);
check("and does not become a target", parseArgs("max --FIX").target, "");
check("an unknown flag is reported", parseArgs("max --wat").unknownFlags, ["--wat"]);
check("and does not become a target either", parseArgs("max --wat").target, "");
check("several are collected", parseArgs("--wat --nope").unknownFlags, ["--wat", "--nope"]);

console.log("\n--- every angle is assigned, in both directions ---");
{
	// The failure: max carries 10 angles but a small diff budgets 2 finders, and
	// the prompt used to say "one per angle" — leaving 8 angles unreviewed.
	const short = codeReviewPrompt("max", "workflow", "", 2, false);
	check("a short fleet is told to split the list", short.includes("every angle is assigned to exactly one finder"), true);
	check("and never claims one-per-angle", short.includes("one per\nangle"), false);
	const long = codeReviewPrompt("low", "workflow", "", 4, false);
	check("a long fleet doubles up instead of dropping", long.includes("put the spare finders back on"), true);
	check("counts are pluralised", codeReviewPrompt("low", "task", "", 1, false).includes("**1 finder agent**"), true);
	check("and plural when it should be", codeReviewPrompt("max", "task", "", 3, false).includes("**3 finder agents**"), true);
}

console.log("\n--- the level table is the only source of truth ---");
// The five-places-to-edit problem: caps, uncertainty, scaling, sweeping and the
// angle lists all used to live apart and agree only by luck.
check("angles come from the table", correctnessAngles("max"), LEVEL_SPECS.max.correctness);
check("cleanup too", cleanupAngles("high"), LEVEL_SPECS.high.cleanup);
check("anglesFor concatenates them", anglesFor("high").length, LEVEL_SPECS.high.correctness.length + LEVEL_SPECS.high.cleanup.length);
check("uncertainty reads the table", LEVELS.map(allowsUncertainty), LEVELS.map((l) => LEVEL_SPECS[l].uncertain));
// xhigh and max now differ by exactly one field, and it is the sweep.
check("xhigh and max differ only in sweep", Object.entries(LEVEL_SPECS.max).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(LEVEL_SPECS.xhigh[k as keyof typeof LEVEL_SPECS.xhigh])).map(([k]) => k), ["sweep"]);
// The narrated angle count must be the list's length, not a hand-typed number.
check("simplifyAngles is derived", CONFIG.simplifyAngles, SIMPLIFY_ANGLES.length);

console.log("\n--- max is not xhigh ---");
{
	const xhigh = codeReviewPrompt("xhigh", "workflow", "", 6, false);
	const max = codeReviewPrompt("max", "workflow", "", 6, false);
	check("the two levels differ", xhigh === max, false);
	check("only max sweeps", [xhigh.includes("Sweep for gaps"), max.includes("Sweep for gaps")], [false, true]);
	check("the sweep looks for what angles miss", max.includes("defects nothing\nabove would have named"), true);
	check("xhigh phases stay contiguous", phaseNumbers(xhigh), [0, 1, 2, 3]);
}

console.log("\n--- inline phases are contiguous too ---");
{
	// The bug: a hardcoded "Phase 4 — Apply" in a shape whose last phase was 2.
	check("inline, no fix", phaseNumbers(codeReviewPrompt("low", "none", "", 1, false)), [0, 1, 2]);
	check("inline with --fix", phaseNumbers(codeReviewPrompt("low", "none", "", 1, true)), [0, 1, 2, 3]);
	check("inline at max sweeps too", phaseNumbers(codeReviewPrompt("max", "none", "", 1, true)), [0, 1, 2, 3, 4]);
	check("one angle reads as singular", codeReviewPrompt("low", "none", "", 1, false).includes("(1 angle, single pass)"), true);
	check("and several as plural", codeReviewPrompt("max", "none", "", 1, false).includes("(10 angles, single pass)"), true);
}

console.log("\n--- untracked files are gathered ---");
{
	// git diff never shows them, so a branch of all-new files reads as empty.
	const anyPrompt = codeReviewPrompt("medium", "task", "", 2, false);
	check("Phase 0 lists untracked files", anyPrompt.includes("git ls-files --others --exclude-standard"), true);
	check("and says why", anyPrompt.includes("Untracked files appear in NO diff"), true);
	check("/simplify gathers them too", simplifyPrompt("task", "").includes("git ls-files --others"), true);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
