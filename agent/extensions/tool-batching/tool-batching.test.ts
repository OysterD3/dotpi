/**
 * Tests for tool-batching: the guideline says the two things it has to say, and
 * the hook appends rather than replacing.
 *
 * The chaining assertion is the one that matters. Four extensions return a
 * systemPrompt from before_agent_start (memory, visual-reference, add-dir and
 * this one) and pi threads the result of each into the next, so a handler that
 * returned a bare guideline would silently delete whatever memory had loaded.
 * That failure is invisible at runtime — the session just quietly forgets.
 *
 * Run: jiti agent/extensions/tool-batching/tool-batching.test.ts
 */
import { SUBAGENT_BATCHING_LINE, TOOL_BATCHING_GUIDELINE } from "./guideline.ts";
import register from "./index.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

console.log("--- the guideline ---");
check("says independent calls share one message", TOOL_BATCHING_GUIDELINE.includes("ONE message"), true);
// Without the exception the rule reads as "always batch", which would have an
// agent editing a file it has not read yet.
check("and names the real exception", TOOL_BATCHING_GUIDELINE.includes("Serialise only on a real dependency"), true);
check("explains why a turn is the unit of cost", TOOL_BATCHING_GUIDELINE.includes("re-sends the entire conversation"), true);
check("is a prompt section, not a sentence", TOOL_BATCHING_GUIDELINE.startsWith("## Tool calls"), true);

console.log("\n--- the subagent line ---");
// It rides in --append-system-prompt, competing with the task itself for the
// model's attention, so it has to stay short.
check("stays short enough to append to a task", SUBAGENT_BATCHING_LINE.length < 320, true);
check("carries the same rule", SUBAGENT_BATCHING_LINE.includes("same message"), true);
check("and the same exception", SUBAGENT_BATCHING_LINE.includes("genuinely depends"), true);
check("is one line, not a section", SUBAGENT_BATCHING_LINE.includes("\n"), false);

console.log("\n--- wiring ---");
{
	type Handler = (event: unknown) => unknown;
	const handlers = new Map<string, Handler>();
	register({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
	check("hooks before_agent_start", [...handlers.keys()], ["before_agent_start"]);

	const result = handlers.get("before_agent_start")!({ systemPrompt: "BASE" }) as { systemPrompt: string };
	check("the guideline is appended", result.systemPrompt.endsWith(TOOL_BATCHING_GUIDELINE), true);
	// The whole point of appending: another extension's contribution survives.
	check("and what was already there survives", result.systemPrompt.startsWith("BASE"), true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
