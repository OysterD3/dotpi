/**
 * Tests for the ask-user extension: param normalization, the interaction state
 * machine (selection, the free-text row, Tab notes, ← / → navigation, review),
 * the overlay's key handling, outcome rendering, settings, and the wiring
 * against a fake pi.
 *
 * The overlay is driven with real terminal byte sequences ("\x1b[C" and so on)
 * rather than synthetic key names, so pi-tui's own key parsing is under test too
 * — a binding that decodes differently in a real terminal would pass a fake.
 *
 * Everything runs offline: no TUI, no network.
 *
 * Run: jiti agent/extensions/ask-user/ask-user.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "ask-user-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { AskSession, CUSTOM_KEY, renderOutcomeText } = await import("./interaction.ts");
const { AskOverlay, isPrintable, wrap } = await import("./overlay.ts");
const { normalizeOptions, normalizeQuestions, registerAskUserTool } = await import("./tool.ts");
const { CONFIG } = await import("./config.ts");
const { loadSettings } = await import("./index.ts");
const extension = (await import("./index.ts")).default;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

// Real terminal sequences, so pi-tui's parser is exercised.
const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	tab: "\t",
	enter: "\r",
	esc: "\x1b",
	backspace: "\x7f",
	space: " ",
};

const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text } as never;

/** Build an overlay over a session and return both plus the captured outcome. */
function drive(questions: any[], allowNotes = true) {
	const session = new AskSession(questions, allowNotes);
	let outcome: any;
	const overlay = new AskOverlay(session, theme, (value) => (outcome = value), () => {});
	const send = (...keys: string[]) => {
		for (const key of keys) overlay.handleInput(key);
	};
	const type = (text: string) => {
		for (const char of text) overlay.handleInput(char);
	};
	return { session, overlay, send, type, result: () => outcome };
}

const OPTS = [
	{ label: "Looks good", description: "The selector, notes, and free text all work" },
	{ label: "Needs tweaks", description: "Something feels off" },
];
const Q = (over: Record<string, unknown> = {}) => ({
	question: "How does it look?",
	options: OPTS,
	multiSelect: false,
	...over,
});

// ------------------------------------------------------------------ normalize

console.log("--- normalizeOptions ---");
check("undefined -> empty", normalizeOptions(undefined), []);
check("non-array -> empty", normalizeOptions("nope"), []);
check(
	"trims, dedupes, drops blanks",
	normalizeOptions([{ label: " A " }, { label: "A" }, { label: "" }, { label: "B", description: "  " }, { label: "C", description: " see " }]),
	[{ label: "A", description: undefined }, { label: "B", description: undefined }, { label: "C", description: "see" }],
);
check("capped at maxOptions", normalizeOptions(Array.from({ length: 12 }, (_, n) => ({ label: `opt${n}` }))).length, CONFIG.maxOptions);
// The old flow truncated descriptions to 72 chars for the selector row. The
// overlay wraps instead, so the full text must survive normalization.
check("long descriptions are NOT truncated", normalizeOptions([{ label: "L", description: "x".repeat(200) }])[0]!.description!.length, 200);

console.log("\n--- normalizeQuestions ---");
check("empty -> none", normalizeQuestions({}), []);
check("blank question dropped", normalizeQuestions({ questions: [{ question: "  " }] }), []);
check("count", normalizeQuestions({ questions: [Q(), Q({ question: "Second?" })] }).length, 2);
check("capped at maxQuestions", normalizeQuestions({ questions: Array.from({ length: 9 }, (_, n) => Q({ question: `q${n}?` })) }).length, CONFIG.maxQuestions);
check("tolerates a single top-level question", normalizeQuestions({ question: "Alone?" })[0]!.question, "Alone?");

// -------------------------------------------------------------- state machine

console.log("\n--- rows and selection ---");
{
	const { session } = drive([Q()]);
	check("a free-text row follows the presets", session.rows().length, OPTS.length + 1);
	check("last row is the free-text row", session.rows().at(-1), { kind: "custom" });
}
{
	// Single-select replaces rather than accumulating.
	const { session, send } = drive([Q()]);
	send(KEY.space);
	check("selects the focused option", session.state.selected, ["Looks good"]);
	send(KEY.down, KEY.space);
	check("single-select replaces", session.state.selected, ["Needs tweaks"]);
	send(KEY.space);
	check("pressing again clears it", session.state.selected, []);
}
{
	const { session, send } = drive([Q({ multiSelect: true })]);
	send(KEY.space, KEY.down, KEY.space);
	check("multi-select accumulates", session.state.selected, ["Looks good", "Needs tweaks"]);
	send(KEY.space);
	check("and toggles off", session.state.selected, ["Looks good"]);
}

console.log("\n--- the free-text row ---");
{
	// Typing on the row starts the answer: no "Other" to select first.
	const { session, send, type } = drive([Q()]);
	send(KEY.down, KEY.down);
	check("cursor reaches the free-text row", session.focusedRow, { kind: "custom" });
	type("my own thing");
	check("typing fills it directly", session.state.custom, "my own thing");
	checkTrue("and counts as selected", session.isSelected({ kind: "custom" }));
	send(KEY.backspace);
	check("backspace edits it", session.state.custom, "my own thin");
	send(KEY.enter);
	check("enter leaves edit mode", session.editing, null);
}

console.log("\n--- Tab notes ---");
{
	const { session, send, type } = drive([Q()]);
	send(KEY.tab);
	checkTrue("Tab starts a note on the focused answer", session.editing?.target === "note");
	checkTrue("Tab also selects that answer", session.state.selected.includes("Looks good"));
	type("but only on macOS");
	check("the note captures typing", session.state.notes["Looks good"], "but only on macOS");
	send(KEY.enter);
	check("enter commits and exits", session.editing, null);
	check("note survives", session.state.notes["Looks good"], "but only on macOS");
}
{
	// An empty note is discarded rather than left as a blank annotation.
	const { session, send } = drive([Q()]);
	send(KEY.tab, KEY.enter);
	check("empty note is dropped", session.state.notes["Looks good"], undefined);
}
{
	const { session, send, type } = drive([Q()], false);
	send(KEY.tab);
	check("allowNotes:false makes Tab inert", session.editing, null);
	type("x");
	check("and nothing is recorded", session.state.notes, {});
}
{
	// Arrow keys must not navigate away mid-note, or a stray key loses the text.
	const { session, send, type } = drive([Q(), Q({ question: "Second?" })]);
	send(KEY.tab);
	type("careful");
	send(KEY.right, KEY.left, KEY.up, KEY.down);
	check("navigation is suppressed while editing", session.index, 0);
	check("the note is intact", session.state.notes["Looks good"], "careful");
}

console.log("\n--- navigation and review ---");
{
	const { session, send } = drive([Q(), Q({ question: "Second?" }), Q({ question: "Third?" })]);
	send(KEY.right);
	check("right advances", session.index, 1);
	send(KEY.left);
	check("left goes back", session.index, 0);
	send(KEY.left);
	check("left stops at the first", session.index, 0);
	send(KEY.right, KEY.right, KEY.right);
	check("past the last question is review", session.phase, "review");
	send(KEY.left);
	check("left returns from review", session.phase, "answering");
	check("to the last question", session.index, 2);
}
{
	const { session, send, result } = drive([Q()]);
	send(KEY.space, KEY.right);
	check("single question still reviews", session.phase, "review");
	send(KEY.enter);
	check("enter on review submits", result().kind, "answered");
	check("with the answer", result().answers[0].labels, ["Looks good"]);
}
{
	const { send, result } = drive([Q()]);
	send(KEY.esc);
	check("esc dismisses", result().kind, "dismissed");
}

console.log("\n--- collect ---");
{
	const { session, send, type } = drive([Q({ multiSelect: true }), Q({ question: "Second?" })]);
	send(KEY.tab);
	type("with a caveat");
	send(KEY.enter, KEY.down, KEY.space, KEY.down);
	type("custom too");
	send(KEY.enter);
	const [first] = session.collect();
	check("labels collected", first!.labels, ["Looks good", "Needs tweaks"]);
	check("free text collected", first!.custom, "custom too");
	check("note attached to its answer", first!.notes, [{ answer: "Looks good", note: "with a caveat" }]);
}

console.log("\n--- renderOutcomeText ---");
{
	const dismissed = renderOutcomeText({ kind: "dismissed" });
	checkTrue("dismissal tells the model to proceed", dismissed.includes("best judgment"));
}
{
	const text = renderOutcomeText({
		kind: "answered",
		answers: [
			{ question: "How does it look?", header: "Test", labels: ["Looks good"], custom: undefined, notes: [{ answer: "Looks good", note: "ship it" }] },
			{ question: "Anything else?", header: undefined, labels: [], custom: "my own", notes: [] },
		],
	});
	checkTrue("question shown with its header", text.includes("[Test] How does it look?"));
	checkTrue("answer shown", text.includes('"Looks good"'));
	// The whole point of the Tab affordance: the model must not read the note as
	// part of the chosen answer.
	checkTrue("note is labelled as a note", text.includes("Note on \"Looks good\""));
	checkTrue("note explains it is an annotation", text.includes("not part of the answer"));
	checkTrue("free text marked as typed by the user", text.includes("typed by the user"));
}

// ------------------------------------------------------------------- overlay

console.log("\n--- overlay helpers ---");
check("wrap splits on width", wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
check("wrap hard-splits an overlong word", wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
check("wrap of empty text", wrap("", 10), [""]);
checkTrue("printable text is printable", isPrintable("a"));
checkTrue("escape sequences are not", !isPrintable("\x1b[A"));
checkTrue("control bytes are not", !isPrintable("\r"));
checkTrue("tab is not printable", !isPrintable("\t"));

console.log("\n--- overlay render ---");
{
	const { overlay, session, send, type } = drive([Q(), Q({ question: "Second?" })]);
	const first = overlay.render(60).join("\n");
	checkTrue("renders the question", first.includes("How does it look?"));
	checkTrue("shows the placeholder on the empty free-text row", first.includes(CONFIG.customPlaceholder));
	checkTrue("shows progress across questions", first.includes("Question 1 of 2"));
	checkTrue("descriptions are rendered, not truncated", first.includes("The selector, notes, and free text all work"));

	send(KEY.tab);
	type("note text");
	const editing = overlay.render(60).join("\n");
	checkTrue("note is shown while editing", editing.includes("note text"));
	// The cursor marker is what puts the real terminal caret at the end of the
	// answer being annotated.
	checkTrue("a cursor marker is emitted while editing", editing.includes("\x1b_pi:c\x07"));

	send(KEY.enter, KEY.right, KEY.right);
	check("reached review", session.phase, "review");
	const review = overlay.render(60).join("\n");
	checkTrue("review lists the answers", review.includes("Review your answers"));
	checkTrue("review shows the note", review.includes("note text"));
	checkTrue("review flags an unanswered question", review.includes("(not answered)"));
}
{
	// A long option must wrap rather than vanish.
	const long = "y".repeat(150);
	const { overlay } = drive([Q({ options: [{ label: "L", description: long }] })]);
	const rendered = overlay.render(40).join("\n");
	checkTrue("long description is not truncated", !rendered.includes("…"));
	checkTrue("and all of it is present", rendered.replace(/\s+/g, "").includes(long));
}

// -------------------------------------------------------------------- settings

console.log("\n--- settings ---");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ askUser: block }));
writeSettings({});
check("defaults", loadSettings(AGENT), { enabled: true, allowNotes: true });
writeSettings({ enabled: false, allowNotes: false });
check("overrides", loadSettings(AGENT), { enabled: false, allowNotes: false });
writeSettings({ enabled: "yes", allowNotes: 1 });
check("bad types fall back to defaults", loadSettings(AGENT), { enabled: true, allowNotes: true });

// --------------------------------------------------------------------- wiring

console.log("\n--- wiring against a fake pi ---");
function makePi(active: string[] = []) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	let activeTools = [...active];
	return {
		pi: {
			registerTool: (def: any) => tools.set(def.name, def),
			on: (event: string, h: Function) => handlers.set(event, h),
			registerCommand: (name: string, def: any) => commands.set(name, def),
			getActiveTools: () => activeTools,
			setActiveTools: (list: string[]) => {
				activeTools = list;
			},
		},
		tools,
		handlers,
		commands,
		active: () => activeTools,
	};
}
const uiStub = { setStatus: () => {}, notify: () => {}, custom: async () => undefined };

{
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	checkTrue("registers the ask_user tool", h.tools.has("ask_user"));
	checkTrue("registers /ask-user", h.commands.has("ask-user"));

	const tool = h.tools.get("ask_user");
	check("tool runs sequentially", tool.executionMode, "sequential");
	checkTrue("ships guideline bullets", Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);

	h.handlers.get("session_start")!({}, { hasUI: true, ui: uiStub });
	checkTrue("active when enabled and interactive", h.active().includes("ask_user"));
}
{
	writeSettings({});
	const h = makePi(["ask_user"]);
	extension(h.pi as never);
	h.handlers.get("session_start")!({}, { hasUI: false, ui: uiStub });
	checkTrue("inactive in a headless session", !h.active().includes("ask_user"));
}
{
	writeSettings({ enabled: false });
	const h = makePi(["ask_user"]);
	extension(h.pi as never);
	h.handlers.get("session_start")!({}, { hasUI: true, ui: uiStub });
	checkTrue("inactive when disabled", !h.active().includes("ask_user"));
}
{
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	const ctx = { hasUI: true, ui: uiStub };
	h.handlers.get("session_start")!({}, ctx);
	const cmd = h.commands.get("ask-user");
	await cmd.handler("off", ctx);
	checkTrue("/ask-user off deactivates", !h.active().includes("ask_user"));
	await cmd.handler("on", ctx);
	checkTrue("/ask-user on reactivates", h.active().includes("ask_user"));
}

// ---------------------------------------------------------------- tool.execute

console.log("\n--- tool.execute ---");
{
	const h = makePi();
	registerAskUserTool(h.pi as never, { settings: () => ({ enabled: true, allowNotes: true }) });
	const tool = h.tools.get("ask_user");

	const headless = await tool.execute("t1", { questions: [Q()] }, undefined, undefined, { hasUI: false, ui: uiStub });
	checkTrue("headless returns a graceful message", headless.content[0].text.includes("headless"));
	check("headless details record the mode", headless.details.mode, "headless");

	// Interactive: build the real overlay through a fake ui.custom and drive it.
	const scriptedUI = {
		...uiStub,
		async custom(factory: any) {
			let done: any;
			const component = factory({ requestRender: () => {} }, theme, undefined, (value: unknown) => (done = value));
			for (const key of [KEY.space, KEY.right, KEY.enter]) component.handleInput(key);
			return done;
		},
	};
	const answered = await tool.execute("t2", { questions: [Q()] }, undefined, undefined, { hasUI: true, ui: scriptedUI });
	check("interactive kind", answered.details.kind, "answered");
	check("interactive answer", answered.details.answers[0].labels, ["Looks good"]);
	checkTrue("answer text reaches the model", answered.content[0].text.includes('"Looks good"'));

	// An overlay torn down without calling done must not crash the tool.
	const abandoned = await tool.execute("t3", { questions: [Q()] }, undefined, undefined, { hasUI: true, ui: uiStub });
	check("undefined outcome degrades to dismissed", abandoned.details.kind, "dismissed");

	let threw = false;
	try {
		await tool.execute("t4", { questions: [{ question: "   " }] }, undefined, undefined, { hasUI: true, ui: scriptedUI });
	} catch {
		threw = true;
	}
	checkTrue("no usable question throws", threw);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
