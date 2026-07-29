/**
 * Tests for the ask-user extension: param normalization, the interaction state
 * machine (selection, the free-text row, Tab notes, ← / → navigation, review),
 * the prompt component's key handling and layout, outcome rendering, settings,
 * and the wiring against a fake pi.
 *
 * The component is driven with real terminal byte sequences ("\x1b[C" and so on)
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
const { AskPrompt, extractPaste, flattenPaste, isPrintable, showAsk, windowBlocks, wrap } = await import("./prompt.ts");
const { normalizeOptions, normalizeQuestions, registerAskUserTool } = await import("./tool.ts");
const { ASK_CHANNEL, CONFIG } = await import("./config.ts");
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

/** Build the prompt over a session and return both plus the captured outcome. */
function drive(questions: any[], allowNotes = true, rows = 40) {
	const session = new AskSession(questions, allowNotes);
	let outcome: any;
	const prompt = new AskPrompt(session, theme, (value) => (outcome = value), () => {}, () => rows);
	const send = (...keys: string[]) => {
		for (const key of keys) prompt.handleInput(key);
	};
	const type = (text: string) => {
		for (const char of text) prompt.handleInput(char);
	};
	return { session, prompt, send, type, result: () => outcome };
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
check(
	"the model's recommendation is carried through",
	normalizeOptions([{ label: "A" }, { label: "B", recommended: true }]).map((option) => option.recommended === true),
	[false, true],
);
check(
	"a \"(Recommended)\" label is lifted into the flag",
	normalizeOptions([{ label: "date-fns (Recommended)" }]),
	[{ label: "date-fns", description: undefined, recommended: true }],
);
check(
	"only the first recommendation stands",
	normalizeOptions([{ label: "A", recommended: true }, { label: "B", recommended: true }]).map((option) => option.recommended === true),
	[true, false],
);
// Stripping a bare trailing word would badge the opposite of what it says.
check("a label that merely ends in the word is left alone", normalizeOptions([{ label: "Not recommended" }])[0], {
	label: "Not recommended",
	description: undefined,
	recommended: undefined,
});
// The old flow truncated descriptions to 72 chars for the selector row. The
// prompt wraps instead, so the full text must survive normalization.
check("long descriptions are NOT truncated", normalizeOptions([{ label: "L", description: "x".repeat(200) }])[0]!.description!.length, 200);

console.log("\n--- normalizeQuestions ---");
check("empty -> none", normalizeQuestions({}), []);
check("blank question dropped", normalizeQuestions({ questions: [{ question: "  " }] }), []);
check("count", normalizeQuestions({ questions: [Q(), Q({ question: "Second?" })] }).length, 2);
// The schema rejects both of these before execute() runs, so neither is a path
// production can take; the cap stays as a backstop against schema/CONFIG drift,
// and the old bare-`question` shim is gone rather than left looking load-bearing.
check("capped at maxQuestions as a backstop", normalizeQuestions({ questions: Array.from({ length: 9 }, (_, n) => Q({ question: `q${n}?` })) }).length, CONFIG.maxQuestions);
check("a bare top-level question is not a call shape", normalizeQuestions({ question: "Alone?" }), []);

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

console.log("\n--- Enter commits a single-select answer ---");
{
	// One answer settles the question, so Enter picks it and moves straight on.
	const { session, send } = drive([Q(), Q({ question: "Second?" })]);
	send(KEY.enter);
	check("enter selects the focused option", session.states[0]!.selected, ["Looks good"]);
	check("and advances to the next question", session.index, 1);
	send(KEY.down, KEY.enter);
	check("the next question is answered the same way", session.states[1]!.selected, ["Needs tweaks"]);
	check("and the last question hands over to review", session.phase, "review");
}
{
	// Enter is a commit, not a toggle: pressing it on the current pick keeps it.
	const { session, send } = drive([Q(), Q({ question: "Second?" })]);
	send(KEY.space, KEY.enter);
	check("enter re-affirms rather than clearing", session.states[0]!.selected, ["Looks good"]);
	check("and still advances", session.index, 1);
}
{
	// Multi-select is not over until the user says so, so Enter keeps toggling.
	const { session, send } = drive([Q({ multiSelect: true }), Q({ question: "Second?" })]);
	send(KEY.enter);
	check("enter toggles on a multi-select question", session.state.selected, ["Looks good"]);
	check("and stays put", session.index, 0);
	send(KEY.enter);
	check("so a second enter clears it", session.state.selected, []);
}
{
	// Finishing free text answers a single-select question, so it moves on too.
	const { session, send, type } = drive([Q(), Q({ question: "Second?" })]);
	send(KEY.down, KEY.down);
	type("my own thing");
	send(KEY.enter);
	check("committing free text advances", session.index, 1);
	check("with the text kept", session.states[0]!.custom, "my own thing");
}
{
	const { session, send } = drive([Q(), Q({ question: "Second?" })]);
	send(KEY.down, KEY.down, KEY.enter, KEY.enter);
	check("an empty free-text row does not advance", session.index, 0);
}
{
	// A note annotates an answer rather than being one, so committing it only
	// closes the note — the user still decides when the question is done.
	const { session, send, type } = drive([Q(), Q({ question: "Second?" })]);
	send(KEY.tab);
	type("but only on macOS");
	send(KEY.enter);
	check("committing a note stays on the question", session.index, 0);
	check("and leaves edit mode", session.editing, null);
}

console.log("\n--- the model's recommendation ---");
const R = (over: Record<string, unknown> = {}) =>
	Q({
		options: [
			{ label: "Looks good", description: "The selector, notes, and free text all work" },
			{ label: "Needs tweaks", description: "Something feels off", recommended: true },
		],
		...over,
	});
{
	// Enter commits what is focused, so starting on the advice makes taking it
	// a single keystroke — without selecting anything on the user's behalf.
	const { session, send } = drive([R(), R({ question: "Second?" })]);
	check("the cursor starts on the recommended answer", session.cursor, 1);
	check("but nothing is chosen for the user", session.state.selected, []);
	send(KEY.enter);
	check("so one key accepts the recommendation", session.states[0]!.selected, ["Needs tweaks"]);
	check("the next question starts on its own recommendation", session.cursor, 1);
}
{
	const { session } = drive([Q()]);
	check("no recommendation means the first row, as before", session.cursor, 0);
}
{
	// Walking back must land on what the user chose, not on advice they passed on.
	const { session, send } = drive([R(), R({ question: "Second?" })]);
	send(KEY.up, KEY.space, KEY.right, KEY.left);
	check("returning lands on the user's own answer", session.cursor, 0);
	check("which is still theirs", session.state.selected, ["Looks good"]);
}
{
	const { session, send, type } = drive([R(), R({ question: "Second?" })]);
	send(KEY.down, KEY.down);
	type("mine");
	send(KEY.enter, KEY.left);
	check("returning to free text lands on the free-text row", session.cursor, session.question.options.length);
}
{
	const { prompt } = drive([R()]);
	const rendered = prompt.render(60).join("\n");
	checkTrue("the recommendation is badged", rendered.includes(CONFIG.recommendedBadge));
	check("and only once", rendered.split(CONFIG.recommendedBadge).length - 1, 1);
	checkTrue("the badge rides on its answer's line", rendered.split("\n").some((line) => line.includes("Needs tweaks") && line.includes(CONFIG.recommendedBadge)));
}
{
	// Too narrow to share a line: the badge drops below rather than being cut.
	const { prompt } = drive([Q({ options: [{ label: "A rather wordy answer indeed", recommended: true }] })]);
	const lines = prompt.render(30).join("\n");
	checkTrue("a narrow row still shows the badge", lines.includes(CONFIG.recommendedBadge));
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

// -------------------------------------------------------------------- prompt

console.log("\n--- prompt helpers ---");
check("wrap splits on width", wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
check("wrap hard-splits an overlong word", wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
check("wrap of empty text", wrap("", 10), [""]);
checkTrue("printable text is printable", isPrintable("a"));
checkTrue("escape sequences are not", !isPrintable("\x1b[A"));
checkTrue("control bytes are not", !isPrintable("\r"));
checkTrue("tab is not printable", !isPrintable("\t"));

console.log("\n--- pasting into an answer or a note ---");
// The terminal wraps a paste in bracketed-paste markers. Because that wrapper
// starts with ESC, the input handler used to read a paste as an escape
// sequence: isPrintable said no and nothing was inserted at all.
const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;
checkTrue("a paste is not printable input", !isPrintable(PASTE("hello")));
check("but its text is recovered", extractPaste(PASTE("hello world")), "hello world");
check("ordinary typing is not a paste", extractPaste("a"), undefined);
check("nor is an arrow key", extractPaste("\x1b[A"), undefined);
// A paste bigger than the read buffer arrives in chunks; only the last carries
// the end marker, so an unterminated chunk must still yield its text.
check("an unterminated chunk still yields text", extractPaste("\x1b[200~partial"), "partial");
check("text after the end marker is ignored", extractPaste(`\x1b[200~body\x1b[201~trailing`), "body");

// Answers and notes are single-line, so a multi-line paste is flattened rather
// than dropped — and the whitespace is kept as a space so words don't merge.
check("newlines become spaces", flattenPaste("line one\nline two"), "line one line two");
check("CRLF does not double the space", flattenPaste("a\r\nb"), "a b");
check("a run of blank lines collapses", flattenPaste("a\n\n\nb"), "a b");
check("tabs become spaces", flattenPaste("a\tb"), "a b");
check("other control bytes are dropped", flattenPaste("a\x07b"), "ab");
check("ordinary text is untouched", flattenPaste("hello world"), "hello world");
check("unicode survives", flattenPaste("café — 日本語"), "café — 日本語");

console.log("\n--- a paste reaches the answer and the note ---");
{
	// The reported bug end to end: paste did nothing on the free-text row.
	const q = [{ question: "Which?", header: "H", options: OPTS, multiSelect: false }];
	const d = drive(q);
	d.send(KEY.down, KEY.down); // onto the free-text row
	check("free-text row is focused", d.session.focusedRow.kind, "custom");
	d.prompt.handleInput(PASTE("pasted answer"));
	check("the paste lands in the answer", d.session.states[0]!.custom, "pasted answer");
	// ...and starts the edit, exactly as typing on that row does.
	check("and it is now being edited", d.session.editing?.target, "custom");
	d.prompt.handleInput(PASTE(" plus more"));
	check("a second paste appends", d.session.states[0]!.custom, "pasted answer plus more");
}
{
	const q = [{ question: "Which?", header: "H", options: OPTS, multiSelect: false }];
	const d = drive(q);
	d.send(KEY.tab); // Tab opens a note on the focused option
	check("a note is open", d.session.editing?.target, "note");
	d.prompt.handleInput(PASTE("see line one\nand two"));
	check("the paste lands in the note, flattened", Object.values(d.session.states[0]!.notes)[0], "see line one and two");
}
{
	// The wrapper starts with ESC, and losing a half-written note to a paste is
	// far worse than a paste that does nothing — so pin the behaviour rather
	// than trusting that key matching stays precise.
	const q = [{ question: "Which?", header: "H", options: OPTS, multiSelect: false }];
	const d = drive(q);
	d.send(KEY.tab);
	d.prompt.handleInput(PASTE("kept"));
	check("pasting does not cancel the edit", d.session.editing?.target, "note");
	check("nor dismiss the prompt", d.result(), undefined);
}

console.log("\n--- windowBlocks ---");
{
	const blocks = [["a"], ["b1", "b2"], ["c"], ["d"], ["e"]];
	check("everything fits", windowBlocks(blocks, 0, 20).lines, ["a", "b1", "b2", "c", "d", "e"]);

	const tail = windowBlocks(blocks, 4, 4);
	checkTrue("the focused block is visible", tail.lines.includes("e"));
	checkTrue("and what scrolled off is counted", tail.hiddenBefore > 0);
	check("nothing is hidden past the focus", tail.hiddenAfter, 0);

	const head = windowBlocks(blocks, 0, 4);
	check("windowing from the top hides nothing before", head.hiddenBefore, 0);
	checkTrue("and reports the rest below", head.hiddenAfter > 0);

	// An option and its description are one block: a window must never split them.
	const grouped = windowBlocks([["a"], ["b1", "b2", "b3"], ["c"], ["d"]], 1, 5);
	check("a focused block is kept whole", grouped.lines, ["b1", "b2", "b3"]);
	check("with both sides counted", [grouped.hiddenBefore, grouped.hiddenAfter], [1, 2]);

	// The focused block still wins when it alone is taller than the screen.
	const huge = windowBlocks([["a"], ["x1", "x2", "x3", "x4", "x5"]], 1, 3);
	checkTrue("an oversized focused block is clipped, not dropped", huge.lines.length > 0 && huge.lines.length <= 3);
	check("showing its start", huge.lines[0], "x1");

	check("no blocks, no lines", windowBlocks([], 0, 5).lines, []);
}

console.log("\n--- prompt render ---");
{
	const { prompt, session, send, type } = drive([Q(), Q({ question: "Second?" })]);
	const first = prompt.render(60).join("\n");
	checkTrue("renders the question", first.includes("How does it look?"));
	checkTrue("shows the placeholder on the empty free-text row", first.includes(CONFIG.customPlaceholder));
	checkTrue("shows progress across questions", first.includes("Question 1 of 2"));
	checkTrue("descriptions are rendered, not truncated", first.includes("The selector, notes, and free text all work"));

	send(KEY.tab);
	type("note text");
	const editing = prompt.render(60).join("\n");
	checkTrue("note is shown while editing", editing.includes("note text"));
	// The cursor marker is what puts the real terminal caret at the end of the
	// answer being annotated.
	checkTrue("a cursor marker is emitted while editing", editing.includes("\x1b_pi:c\x07"));

	send(KEY.enter, KEY.right, KEY.right);
	check("reached review", session.phase, "review");
	const review = prompt.render(60).join("\n");
	checkTrue("review lists the answers", review.includes("Review your answers"));
	checkTrue("review shows the note", review.includes("note text"));
	checkTrue("review flags an unanswered question", review.includes("(not answered)"));
}
{
	// A long option must wrap rather than vanish.
	const long = "y".repeat(150);
	const { prompt } = drive([Q({ options: [{ label: "L", description: long }] })]);
	const rendered = prompt.render(40).join("\n");
	checkTrue("long description is not truncated", !rendered.includes("…"));
	checkTrue("and all of it is present", rendered.replace(/\s+/g, "").includes(long));
}
{
	// It sits where the editor was, so it is framed the way pi frames its own
	// in-editor selector, and the key hints land under the lower rule — the row
	// the footer has vacated.
	const { prompt } = drive([Q()]);
	const lines = prompt.render(60);
	const rule = "─".repeat(60);
	check("opens with a rule", lines[0], rule);
	const lower = lines.lastIndexOf(rule);
	checkTrue("and closes with one", lower > 0 && lower < lines.length - 1);
	checkTrue("hints sit below the closing rule", lines.slice(lower + 1).join(" ").includes("Esc cancel"));
	checkTrue("Enter is advertised as a commit", lines.join("\n").includes("Enter pick"));
}
{
	const { prompt } = drive([Q({ multiSelect: true })]);
	checkTrue("multi-select advertises Enter as a toggle", prompt.render(60).join("\n").includes("Space/Enter toggle"));
}
{
	// A tall question on a short terminal scrolls its options instead of pushing
	// the whole conversation off the screen.
	const many = Array.from({ length: 8 }, (_, n) => ({ label: `Option ${n}`, description: "why you might pick it" }));
	const { prompt, send } = drive([Q({ options: many })], true, 20);
	const top = prompt.render(60);
	checkTrue("the prompt stays within the terminal", top.length <= 20);
	checkTrue("and says what is out of view", top.join("\n").includes("more"));
	checkTrue("the focused row is on screen", top.join("\n").includes("Option 0"));

	send(...Array(8).fill(KEY.down));
	const bottom = prompt.render(60).join("\n");
	checkTrue("scrolling follows the cursor down", bottom.includes(CONFIG.customPlaceholder));
	checkTrue("and reports what is now above", bottom.includes("↑"));
}
{
	// A wordy question on a tiny terminal still leaves room to answer it, and
	// says how much of itself it had to cut.
	const wordy = Q({ question: `${"how does this look ".repeat(20)}?` });
	const { prompt } = drive([wordy], true, 12);
	const lines = prompt.render(40);
	checkTrue("the prompt still fits the terminal", lines.length <= 12);
	checkTrue("the options survive the squeeze", lines.join("\n").includes("Looks good"));
	checkTrue("and the cut is announced", lines.join("\n").includes("more lines"));
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
	const emitted: { channel: string; data: any }[] = [];
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
			events: {
				emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
				on: () => () => {},
			},
		},
		tools,
		handlers,
		commands,
		emitted,
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

	// The batch is the whole shape of this tool, and prose alone did not carry
	// it: the bound is structural so pi's own validator enforces it, and the
	// one-line snippet says so because it is the only part of the guidance the
	// model reads before it has framed a question.
	const questions = tool.parameters.properties.questions;
	check("the question array is bounded, not just described", [questions.minItems, questions.maxItems], [1, CONFIG.maxQuestions]);
	checkTrue("the always-on snippet advertises the batch", /\b(4|four)\b/.test(tool.promptSnippet));
	checkTrue("so do the guidelines", tool.promptGuidelines.some((line: string) => /one ask_user call/.test(line)));

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

	// Interactive: build the real component through a fake ui.custom and drive it.
	let customOptions: any;
	const scriptedUI = {
		...uiStub,
		async custom(factory: any, options: any) {
			customOptions = options;
			let done: any;
			const component = factory({ requestRender: () => {} }, theme, undefined, (value: unknown) => (done = value));
			// Enter picks and hands over to review, then Enter sends.
			for (const key of [KEY.enter, KEY.enter]) component.handleInput(key);
			return done;
		},
	};
	const answered = await tool.execute("t2", { questions: [Q()] }, undefined, undefined, { hasUI: true, ui: scriptedUI });
	check("interactive kind", answered.details.kind, "answered");
	check("interactive answer", answered.details.answers[0].labels, ["Looks good"]);
	checkTrue("answer text reaches the model", answered.content[0].text.includes('"Looks good"'));

	// The placement: it replaces the editor rather than floating over the chat,
	// and the footer is told to stand down for exactly as long as it is up.
	check("shown in the prompt's place, not as an overlay", customOptions?.overlay, false);
	check(
		"the footer is told when the question opens and closes",
		h.emitted.filter((entry) => entry.channel === ASK_CHANNEL).map((entry) => entry.data.active),
		[true, false],
	);
	// A subscriber that has to interrupt someone (cmux-notify) needs to be able
	// to say what for, so the opening announcement carries the question.
	check("the announcement says what is being asked", h.emitted[0]!.data.question, Q().question);
	check("and how many questions came with it", h.emitted[0]!.data.count, 1);

	// A component torn down without calling done must not crash the tool.
	const abandoned = await tool.execute("t3", { questions: [Q()] }, undefined, undefined, { hasUI: true, ui: uiStub });
	check("undefined outcome degrades to dismissed", abandoned.details.kind, "dismissed");

	// A host that tears the prompt down by throwing must still hand the footer
	// back, or the statusline would stay blank for the rest of the session.
	{
		const failing = makePi();
		const ui = { ...uiStub, custom: async () => { throw new Error("boom"); } };
		let broke = false;
		try {
			await showAsk(failing.pi as never, { hasUI: true, ui } as never, new AskSession([Q()] as never));
		} catch {
			broke = true;
		}
		checkTrue("a failed prompt propagates", broke);
		check("and the footer is handed back anyway", failing.emitted.map((entry) => entry.data.active), [true, false]);
	}

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
