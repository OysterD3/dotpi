/**
 * Tests for test-streak: what counts as a suite run, what clears the streak,
 * and that the nudge is delivered where a looping turn can actually see it.
 *
 * The delivery assertion is the one that matters. `followUp` only drains when
 * the model stops calling tools by itself, so a nudge sent that way would be
 * invisible to precisely the runaway turn this extension exists for. The mode
 * is asserted rather than trusted, because nothing at runtime would say.
 *
 * Run: jiti agent/extensions/test-streak/test-streak.test.ts
 */
import register from "./index.ts";
import { rerunReminder } from "./reminder.ts";
import { CheckStreak, CONFIG, isCheckCommand } from "./streak.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

console.log("--- what is a suite run ---");
for (const command of [
	"pnpm test",
	"pnpm run test",
	"pnpm typecheck",
	"pnpm check --filter web",
	"npx vitest run",
	"vitest --run",
	"pytest -q",
	"cargo test",
	"go test ./...",
	"make check",
	"jiti agent/extensions/test-streak/test-streak.test.ts",
]) {
	check(command, isCheckCommand(command), true);
}

console.log("\n--- read through the shell, not just the first word ---");
// A suite run is still one when it is behind a cd, or in front of a pipe.
check("after a cd", isCheckCommand("cd packages/web && pnpm test"), true);
check("in front of a pipe", isCheckCommand("pnpm test 2>&1 | tail -20"), true);
check("inside a subshell", isCheckCommand("(pnpm test)"), true);

console.log("\n--- and what is not ---");
// The bias is toward missing a suite run: a false match nags a session that is
// working properly, a miss only means the streak does not count.
for (const command of ["git status", "rg -n 'pnpm test' README.md", "cat package.json", "pnpm install", "echo pnpm test"]) {
	check(command, isCheckCommand(command), false);
}

console.log("\n--- the streak ---");
{
	const streak = new CheckStreak();
	const runs = (n: number) => Array.from({ length: n }, () => streak.record(CONFIG.nudgeEvery, CONFIG.maxNudgesPerTurn));

	check("says nothing before the threshold", runs(CONFIG.nudgeEvery - 1), [null, null, null]);
	check("and names the count on it", streak.record(CONFIG.nudgeEvery, CONFIG.maxNudgesPerTurn), CONFIG.nudgeEvery);
	// An edit makes the next run a new question, so the count starts over.
	streak.reset();
	check("an edit clears it", streak.current(), 0);
	check("and the next runs are quiet again", runs(CONFIG.nudgeEvery - 1), [null, null, null]);
}

console.log("\n--- the per-turn cap ---");
{
	const streak = new CheckStreak();
	const nudges = Array.from({ length: CONFIG.nudgeEvery * (CONFIG.maxNudgesPerTurn + 2) }, () =>
		streak.record(CONFIG.nudgeEvery, CONFIG.maxNudgesPerTurn),
	).filter((count) => count !== null);

	// It keeps speaking inside one turn — the trap is a single turn that never
	// stops — but a bounded number of times.
	check("speaks more than once in a turn", nudges.length > 1, true);
	check("and no more than the cap", nudges.length, CONFIG.maxNudgesPerTurn);

	// The cap lifts with the turn, so the next run that lands on a multiple
	// speaks again — not the very next call, which is one only every nth.
	streak.newTurn();
	const afterTurn = Array.from({ length: CONFIG.nudgeEvery }, () => streak.record(CONFIG.nudgeEvery, CONFIG.maxNudgesPerTurn));
	check("a new turn may speak again", afterTurn.filter((count) => count !== null).length, 1);
}

console.log("\n--- the reminder ---");
{
	const text = rerunReminder(4, "pnpm test");
	check("names the count and the command", text.includes("`pnpm test` 4 times"), true);
	// "Stop" alone reads as "abandon the task", and the model will pick the
	// suite over abandoning every time. Both ways out have to be there.
	check("offers changing something", text.includes("change something"), true);
	check("and saying what was seen", text.includes("what you observed"), true);
}

console.log("\n--- wiring ---");
{
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const handlers = new Map<string, Handler>();
	const sent: { content: string; delivery: unknown }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendMessage: (message: { content: string }, delivery: unknown) => sent.push({ content: message.content, delivery }),
	};
	register(pi as never);
	check("hooks the turn and the tool call", [...handlers.keys()].sort(), ["agent_start", "tool_call"]);

	const call = handlers.get("tool_call")!;
	const ctx = { isIdle: () => false, hasUI: false };
	const bash = (command: string) => call({ toolName: "bash", input: { command } }, ctx);

	for (let i = 0; i < CONFIG.nudgeEvery - 1; i++) bash("pnpm test");
	check("silent while the streak builds", sent.length, 0);

	bash("pnpm test");
	check("then says one thing", sent.length, 1);
	// The whole point: a turn that never stops calling tools never drains a
	// followUp, so this has to be a steer.
	check("as a steer, so a looping turn sees it", sent[0]?.delivery, { deliverAs: "steer" });
	check("wrapped as a system reminder", sent[0]?.content.startsWith("<system-reminder>"), true);

	// An edit between runs is the thing that makes the next one worth doing.
	call({ toolName: "edit", input: {} }, ctx);
	for (let i = 0; i < CONFIG.nudgeEvery - 1; i++) bash("pnpm test");
	check("an edit buys the next runs silence", sent.length, 1);

	// Nothing else it sees should count against the streak.
	call({ toolName: "read", input: {} }, ctx);
	bash("git status");
	check("reading and looking around are neither", sent.length, 1);
	bash("pnpm test");
	check("and the run after them still lands on the count", sent.length, 2);
}

console.log("\n--- an idle session ---");
{
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const handlers = new Map<string, Handler>();
	const sent: { delivery: unknown }[] = [];
	register({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendMessage: (_message: unknown, delivery: unknown) => sent.push({ delivery }),
	} as never);

	const ctx = { isIdle: () => true, hasUI: false };
	for (let i = 0; i < CONFIG.nudgeEvery; i++) handlers.get("tool_call")!({ toolName: "bash", input: { command: "pnpm test" } }, ctx);
	// With no turn running there is nothing to steer, so it starts one.
	check("triggers a turn instead of steering one", sent[0]?.delivery, { triggerTurn: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
