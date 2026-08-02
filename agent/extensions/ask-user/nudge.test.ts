/**
 * Tests for the opening nudge: what counts as a request that opens new work,
 * and the wiring that turns that into one hidden reminder on that turn.
 *
 * The detector cases are deliberately drawn from real prompts — the ones that
 * should have been asked about and were not, and the mid-task follow-ups that
 * must stay silent. A detector that fires on "fix it for me" would reintroduce
 * asking-instead-of-doing, which is the failure the tool guidance was written
 * against in the first place.
 *
 * Run: jiti agent/extensions/ask-user/nudge.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "ask-nudge-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { OPENING_NUDGE, opensWork, systemReminder } = await import("./nudge.ts");
const { CONFIG, NUDGE_ENTRY_TYPE } = await import("./config.ts");
const { default: register } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------- what fires

console.log("--- requests that open work ---");
for (const text of [
	"build me a settings page with a dark mode toggle",
	"Implement retry with exponential backoff for the upload queue",
	"add a caching layer in front of the model registry",
	"Create a CLI that reads the journal and prints a summary",
	"refactor the permission classifier so the rules live in one place",
	"migrate the store from JSON files to sqlite please",
	"write a parser for the run journal format",
	// No work verb at all. This is how a substantial task is most often phrased,
	// and it is the shape of the request that started this whole thread.
	"I want the pi coding agent to achieve token efficiency and proper compaction",
	"we need something that shows which agents failed and why",
	"can you build a dashboard for the workflow runs",
	// Every one of these returned FALSE under the five-word informational scan,
	// each killed by one incidental common word: "do" at index 4, "find" at 4,
	// "look" at 3, "check" at 4. They are exactly the schema/layout-deciding
	// requests the nudge exists for.
	"I need you to do a full rewrite of the sync layer",
	"write a script to find and remove the dead runs",
	"make the dashboard look like the mockup in docs",
	"build the exporter, then check it against the fixture",
	"would you please rewrite the auth module properly",
]) {
	check(JSON.stringify(text.slice(0, 46)), opensWork(text), true);
}

console.log("\n--- turns that must stay silent ---");
for (const text of [
	// Short follow-ups. A request with decisions in it says more than this.
	"Fix it for me",
	"Fix for me",
	"both read fix and guideline",
	"",
	"   ",
	// Continuations: the decisions belong to the turn that opened the work.
	"also make the footer show the elapsed time",
	"now do the same thing for the advisor extension",
	"continue where you left off and finish the remaining files",
	"actually make it a table instead of a list of lines",
	"revert that change and write the guard a different way",
	// Questions about the code. The answer is to go and look.
	"why pi using qoder always end when task is not complete",
	"Can the workflow run parallely?",
	"why does the workflow keep asking permission. Is the behaviour same as Claude Code?",
	"what is the difference between the two spawn implementations",
	"check whether the compaction threshold is actually being read",
	"can you explain how the routing vocabulary is built",
	"look at the panel code and tell me why it renders twice",
	"I want to know why the workflow picked the wrong model",
	// An intent opener governing a lookup verb is still a question. This is the
	// case that stops the head-only rule from over-firing.
	"we need to understand how the seeding path actually works",
	"could you show me where the routing vocabulary is built",
	// Reports, not requests: the work verb is a noun here.
	"the build failed with a type error in the tool file",
	"my design for the store turned out to be wrong",
	// Not addressed to the model at all.
	"/ultracode on for the rest of this session",
	"!ls -la agent/extensions/ask-user",
]) {
	check(JSON.stringify(text.slice(0, 46)), opensWork(text), false);
}

console.log("\n--- the reminder itself ---");
// Both halves have to be there. "Ask now" alone reads as "ask", and that is the
// opposite bug: the tool description spends four lines warning against it.
check("says to ask now", OPENING_NUDGE.includes("ask_user now"), true);
check("and says when not to", OPENING_NUDGE.includes("do not ask"), true);
check("names the common case as not asking", OPENING_NUDGE.includes("the common case"), true);
check("wrapped as a system reminder", systemReminder("x"), "<system-reminder>\nx\n</system-reminder>");

// -------------------------------------------------------------------- wiring

console.log("\n--- wiring ---");
type Handler = (event: unknown, ctx?: unknown) => unknown;

function install(hasUI = true) {
	const handlers = new Map<string, Handler>();
	let tools: string[] = [];
	const ctx = { hasUI, ui: { setStatus: () => {}, notify: () => {} } };
	register({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		getActiveTools: () => tools,
		setActiveTools: (next: string[]) => {
			tools = next;
		},
	} as never);
	handlers.get("session_start")?.({ type: "session_start" }, ctx);

	/** One human turn: type `text`, then start the agent. Returns the injected message, if any. */
	const turn = (text: string, source = "interactive", streamingBehavior?: string) => {
		handlers.get("input")?.({ type: "input", text, source, streamingBehavior });
		const result = handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: text }, ctx) as
			| { message?: { customType?: string; content?: string; display?: boolean } }
			| undefined;
		return result?.message;
	};
	return { handlers, turn, tools: () => tools };
}

{
	const { turn, tools } = install();
	check("the tool is offered", tools(), ["ask_user"]);
	const first = turn("build me a settings page with a dark mode toggle");
	check("a work-opening request is nudged", first?.content, systemReminder(OPENING_NUDGE));
	check("under its own type", first?.customType, NUDGE_ENTRY_TYPE);
	// Hidden: it is a reminder to the model, not a line of conversation.
	check("and not shown in the transcript", first?.display, false);

	check("a follow-up is not", turn("also add a reset button"), undefined);
	// The cooldown, not the follow-up guard: this one WOULD open work on its own.
	check("nor is a second task inside the cooldown", turn("build me an export dialog with csv and json"), undefined);
}

console.log("\n--- the cooldown expires ---");
{
	const { turn } = install();
	check("first task nudged", turn("build me a settings page with a dark mode toggle") !== undefined, true);
	// One turn short of the cooldown, so the reminder is still suppressed...
	for (let i = 0; i < CONFIG.nudgeCooldownTurns - 1; i++) {
		check(`suppressed ${i + 1} turn(s) later`, turn(`create page number ${i} for the export flow`), undefined);
	}
	// ...and the next one clears it.
	check("and then allowed again", turn("create one more page for the archive flow") !== undefined, true);
}

console.log("\n--- what never nudges ---");
{
	// Telling a headless agent to ask would spend the turn waiting on nobody, and
	// the tool it would reach for is not offered there either.
	const { turn, tools } = install(false);
	check("no interactive user", turn("build me a settings page with a dark mode toggle"), undefined);
	check("and the tool is not offered", tools(), []);
}
{
	const { turn } = install();
	check("a non-human prompt", turn("build me a settings page with a dark mode toggle", "extension"), undefined);
}
{
	const { turn } = install();
	// Steered text arrives mid-turn and never reaches before_agent_start; if it
	// set the flag it would fire on whatever turn came next instead.
	check("text steered into a running turn", turn("build me a settings page with a dark mode toggle", "interactive", "steer"), undefined);
	check("and it did not arm the next turn either", turn("also tidy up the imports"), undefined);
}

console.log("\n--- there is no off switch ---");
{
	// The point of the whole change: no settings block can suppress any of this.
	// A stray `askUser` block on disk must be inert, not honoured.
	writeFileSync(
		join(AGENT, "settings.json"),
		JSON.stringify({ askUser: { enabled: false, openingNudge: false, nudgeCooldownTurns: 9999 } }),
	);
	const { turn, tools } = install();
	check("a disabling settings block is ignored", tools(), ["ask_user"]);
	check("and the nudge still fires", turn("build me a settings page with a dark mode toggle") !== undefined, true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
