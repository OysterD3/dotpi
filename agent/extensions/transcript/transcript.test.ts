/**
 * Tests for the transcript extension: the pure gutter helpers, and the three
 * patched components rendered for real.
 *
 * The patches reach into pi's own component internals, so the checks that
 * matter are the ones that render a component and read the lines back: that a
 * block is exactly as wide as it was asked to be, that the mark lands on the
 * first line that shows something rather than on a spacer, that a wrapped
 * paragraph hangs under its own text, and that a tool call comes back without
 * its background tint.
 *
 * These type and run against whichever pi resolves here (0.82.1 in this
 * repo's node_modules); the TUI they patch at runtime is the globally
 * installed pi (0.84.1). The two agree on every shape used below.
 *
 * Run with jiti from a directory where pi's packages resolve (they are not
 * dependencies of this repo):
 *     node node_modules/jiti/lib/jiti-cli.mjs agent/extensions/transcript/transcript.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "transcript-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir, initTheme, getMarkdownTheme, generateDiffString, AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent } =
	await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { isBlank, prefix, trimBlank, withGutter } = await import("./render.ts");
const { applyPatches, beginTurn, endTurn, setPaint, withoutThinking } = await import("./patch.ts");
const { summarise } = await import("./summary.ts");
const { Container, visibleWidth } = await import("@earendil-works/pi-tui");
const { CONFIG } = await import("./config.ts");

initTheme("dark");
// Marks stay unpainted so the assertions below read as plain text. The blocks
// they mark still carry pi's own colour, which is the point of stripping ANSI
// rather than comparing raw strings.
setPaint((_color, text) => text);
applyPatches();

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}

const ANSI = new RegExp("\\u001b\\[[0-9;?]*[A-Za-z]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", "g");
const seen = (line: string) => line.replace(ANSI, "");
const trimmedRight = (line: string) => seen(line).replace(/\s+$/, "");

const WIDTH = 60;
const ESC = "\u001b";
const OSC133_START = `${ESC}]133;A\u0007`;

/* -------------------------------------------------------------------------- */
console.log("\n--- isBlank ---");

check("empty", isBlank(""), true);
check("spaces", isBlank("   "), true);
check("colour over spaces", isBlank(`${ESC}[31m   ${ESC}[39m`), true);
check("an OSC marker alone", isBlank(OSC133_START), true);
check("text", isBlank("  hi"), false);

/* -------------------------------------------------------------------------- */
console.log("\n--- prefix keeps a leading OSC at column 0 ---");

check("plain line", prefix("hi", "● "), "● hi");
check("OSC stays first", prefix(`${OSC133_START}hi`, "● "), `${OSC133_START}● hi`);
check("SGR does not move", prefix(`${ESC}[31mhi`, "● "), `● ${ESC}[31mhi`);

/* -------------------------------------------------------------------------- */
console.log("\n--- withGutter ---");

check("marks the first visible line only", withGutter(["", "one", "two"], "●"), ["", "●one", " two"]);
check("an empty spacer stays empty", withGutter(["", "one"], "  ∟ "), ["", "  ∟ one"]);
check("so does one that is only an OSC marker", withGutter([OSC133_START, "one"], "●"), [OSC133_START, "●one"]);
check("but a painted blank keeps its width", withGutter(["  ", "one"], "●"), ["   ", "●one"]);
check("a wide mark indents by its width", withGutter(["one", "two"], "  ∟ "), ["  ∟ one", "    two"]);
check("nothing to mark", withGutter([], "●"), []);

/* -------------------------------------------------------------------------- */
console.log("\n--- trimBlank ---");

check("both edges", trimBlank(["", " ", "one", "", "two", "  ", ""]), ["one", "", "two"]);
check("all blank", trimBlank(["", "  "]), []);

/* -------------------------------------------------------------------------- */
console.log("\n--- the assistant block ---");

const assistant = new AssistantMessageComponent(
	{
		role: "assistant",
		content: [{ type: "text", text: "one two three four five six seven eight nine ten eleven twelve" }],
		stopReason: "stop",
	} as never,
	true,
	getMarkdownTheme(),
	"Thinking...",
	1,
);
const assistantLines = assistant.render(WIDTH);
const assistantShown = assistantLines.filter((line) => !isBlank(line));

check(
	"every drawn line is exactly the width asked for",
	[...new Set(assistantLines.map((l) => seen(l).length).filter((n) => n > 0))],
	[WIDTH],
);
check("the mark opens the first line with text", trimmedRight(assistantShown[0] ?? "").startsWith(`${CONFIG.assistantMark} one`), true);
check("which is not line 0 — that is pi's spacer", isBlank(assistantLines[0] ?? ""), true);
check("the paragraph wrapped", assistantShown.length > 1, true);
check("and hangs under its own text, unmarked", trimmedRight(assistantShown[1] ?? ""), "  twelve");

/* -------------------------------------------------------------------------- */
console.log("\n--- the user block ---");

const user = new UserMessageComponent("Review my chat with Glendon", getMarkdownTheme(), 1);
const userLines = user.render(WIDTH);
const userShown = userLines.filter((line) => !isBlank(line));

check("every line is exactly the width asked for", [...new Set(userLines.map((l) => seen(l).length))], [WIDTH]);
check("the mark opens the text", trimmedRight(userShown[0] ?? ""), `${CONFIG.userMark} Review my chat with Glendon`);
check("the background bar survives", (userLines[0] ?? "").includes(`${ESC}[48;`), true);

/* -------------------------------------------------------------------------- */
console.log("\n--- a tool call ---");

const ui = { requestRender() {} };
function toolCall(name: string, args: unknown, output: string) {
	const component = new ToolExecutionComponent(name, `id-${name}`, args, {}, undefined, ui as never, ROOT);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);
	return component;
}

// A call and its result are two marked blocks, not one: the dot opens the call
// at column 0, the corner opens the result at column 2 with text at column 5.
const bash = toolCall("bash", { command: "pnpm test" }, "405 passed\nruff clean");
const bashLines = bash.render(WIDTH);
const bashShown = bashLines.filter((line) => !isBlank(line));

check("opens with a blank line, keeping pi's rhythm", isBlank(bashLines[0] ?? ""), true);
check("the dot opens the call at column 0", trimmedRight(bashShown[0] ?? ""), "● $ pnpm test");
check("the corner opens the result at column 2", trimmedRight(bashShown[1] ?? ""), "  ⎿  405 passed");
check("further result lines align under it, unmarked", trimmedRight(bashShown[2] ?? ""), "     ruff clean");
check("no line carries a background tint", bashLines.some((line) => line.includes(`${ESC}[48;`)), false);
check("no line is wider than the width asked for", bashLines.every((line) => seen(line).length <= WIDTH), true);

/* -------------------------------------------------------------------------- */
console.log("\n--- a collapsed result closes up; ctrl+r puts the spacing back ---");

// pi separates a command's output from its timing footer with a blank line,
// which is inside the result's own text and so survives edge-trimming.
const spaced = toolCall("bash", { command: "echo hi" }, "hi\n\nsecond paragraph");
check("collapsed, no blank line survives the result", spaced.render(WIDTH).slice(1).some(isBlank), false);
spaced.setExpanded(true);
check("expanded, pi's own spacing is back", spaced.render(WIDTH).slice(1).some(isBlank), true);
spaced.setExpanded(false);

/* -------------------------------------------------------------------------- */
console.log("\n--- the dot is the only thing left that says how a call went ---");

// Dropping the box drops the tint pi used to signal the outcome, so the dot
// has to carry it. Naming the colour rather than painting it keeps the check
// on the decision instead of on a theme's hex values.
setPaint((color, text) => `<${color}>${text}`);
const failed = new ToolExecutionComponent("bash", "id-failed", { command: "pnpm lint" }, {}, undefined, ui as never, ROOT);
failed.setArgsComplete();
failed.markExecutionStarted();

const dotOf = (component: { render(w: number): string[] }) =>
	component.render(WIDTH).find((line) => line.includes(CONFIG.callMark.trim()));
check("a call still running is muted", dotOf(failed)?.includes(`<${CONFIG.callPendingColor}>`), true);

failed.updateResult({ content: [{ type: "text", text: "1 error" }], details: {}, isError: true }, false);
check("a call that worked is green", dotOf(bash)?.includes(`<${CONFIG.callOkColor}>`), true);
check("a call that failed is not", dotOf(failed)?.includes(`<${CONFIG.callOkColor}>`), false);
check("it carries the error colour", dotOf(failed)?.includes(`<${CONFIG.callErrorColor}>`), true);
check("the result corner stays dim either way", dotOf(failed) !== undefined && failed.render(WIDTH).some((l) => l.includes(`<${CONFIG.resultColor}>`)), true);
setPaint((_color, text) => text);

/* -------------------------------------------------------------------------- */
console.log("\n--- who keeps pi's own framing ---");

// Only `renderShell: "self"` means "this author chose the framing". pi renders
// those outside the box already, so they are the one thing to defer to.
const selfDrawn = new ToolExecutionComponent(
	"self_drawn",
	"id-self",
	{},
	{},
	{
		name: "self_drawn",
		renderShell: "self",
		renderCall: () => ({ render: () => ["drawn by its author"] }),
	} as never,
	ui as never,
	ROOT,
);
check("a self-framing tool is left alone", selfDrawn.render(WIDTH).some((line) => seen(line).includes("drawn by its author")), true);
check("and gets no mark", selfDrawn.render(WIDTH).some((line) => seen(line).includes(CONFIG.resultMark.trim())), false);

// The regression this test exists for: background-shell replaces `bash` with a
// tool whose renderer delegates to pi's built-in donor. Bailing on "came from
// an extension" boxed almost every call in a real session.
const replaced = new ToolExecutionComponent(
	"bash",
	"id-replaced",
	{ command: "echo hi" },
	{},
	{ name: "bash", renderCall: () => ({ render: () => ["$ echo hi"] }) } as never,
	ui as never,
	ROOT,
);
const replacedLines = replaced.render(WIDTH);
check("an extension tool drawn in pi's box is de-boxed like any other", trimmedRight(replacedLines.find((l) => !isBlank(l)) ?? ""), "● $ echo hi");
check("and keeps no tint", replacedLines.some((line) => line.includes(`${ESC}[48;`)), false);

/* -------------------------------------------------------------------------- */
console.log("\n--- the render memo cannot go stale ---");

// The gutter transform is cached against the lines it was computed from,
// because pi re-renders every component every frame and doing regex work per
// line cost ~100ms a frame on a thousand-turn session. Everything that can
// change the output has to defeat the cache, so each is tried after a first
// render has already populated it.
const streaming = new AssistantMessageComponent(
	{ role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" } as never,
	true,
	getMarkdownTheme(),
	"Thinking...",
	1,
);
const firstPaint = streaming.render(WIDTH).map(trimmedRight);
check("the first render marks it", firstPaint.some((l) => l === `${CONFIG.assistantMark} first`), true);
check("rendering again is identical", streaming.render(WIDTH).map(trimmedRight), firstPaint);

streaming.updateContent({ role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop" } as never);
const second = streaming.render(WIDTH).map(trimmedRight);
check("new content is not served from the memo", second.some((l) => l === `${CONFIG.assistantMark} second`), true);
check("and the old content is gone", second.some((l) => l.includes("first")), false);

const narrow = streaming.render(40).map((l) => seen(l).length).filter((n) => n > 0);
check("a width change is not served from the memo", [...new Set(narrow)], [40]);

// A /theme switch repaints the marks without necessarily changing a single
// input line, which is the one thing the line compare cannot see.
setPaint((color, text) => `<${color}>${text}`);
check("a repaint is not served from the memo", streaming.render(40).some((l) => l.includes(`<${CONFIG.assistantColor}>`)), true);
setPaint((_color, text) => text);

/* -------------------------------------------------------------------------- */
console.log("\n--- applying twice cannot double-mark ---");

applyPatches();
check("the second call is a no-op", user.render(WIDTH).map(trimmedRight)[0], userLines.map(trimmedRight)[0]);

/* -------------------------------------------------------------------------- */
console.log("\n--- reasoning is retired when the turn is ---");

// The user has hideThinkingBlock on, so pi leaves one italic "Thinking..."
// label per run of reasoning — a line per assistant message, forever, saying
// only that something was thought. It earns its place while the thought is
// happening and not afterwards.
const THINKING = "Thinking...";
const reasoned = () =>
	({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "weighing the options" },
			{ type: "text", text: "the answer" },
		],
		stopReason: "stop",
	}) as never;

// Pure first: the filter that does the work, and the two ways it must not fire.
check("thinking blocks are filtered out", (withoutThinking(reasoned()) as any).content.map((c: any) => c.type).join(), "text");
check(
	"a message with no reasoning comes back by identity, so the common case allocates nothing",
	(() => {
		const plain = { role: "assistant", content: [{ type: "text", text: "hi" }] };
		return withoutThinking(plain) === plain;
	})(),
	true,
);
check("a shape this does not recognise passes through", withoutThinking(undefined), undefined);

{
	// A turn in flight: the live component shows what pi would show.
	beginTurn();
	const live = new AssistantMessageComponent(reasoned(), true, getMarkdownTheme(), THINKING, 1);
	const during = live.render(WIDTH).join("\n");
	check("while the turn runs, the label is there", during.includes(THINKING), true);
	check("along with the answer", during.includes("the answer"), true);

	// ...and is gone once it settles, WITHOUT the session being reloaded. This is
	// what a flag alone does not buy: updateContent built the children and a
	// later render only draws them, so endTurn has to rebuild.
	endTurn();
	const after = live.render(WIDTH).join("\n");
	check("once settled, the label is gone", after.includes(THINKING), false);
	check("and the answer is untouched", after.includes("the answer"), true);
}

{
	// Everything rebuilt from history — a resume, a branch replay — has no turn
	// around it and is stripped from the first frame.
	const replayed = new AssistantMessageComponent(reasoned(), true, getMarkdownTheme(), THINKING, 1);
	const text = replayed.render(WIDTH).join("\n");
	check("a message rebuilt outside a turn never shows it", text.includes(THINKING), false);
	check("but still shows what was said", text.includes("the answer"), true);
}

{
	// hideThinkingBlock OFF is the same complaint at a different volume: the
	// whole reasoning text stays instead of a label. Stripping the input rather
	// than the rendered lines answers both without knowing which is set.
	const shown = new AssistantMessageComponent(reasoned(), false, getMarkdownTheme(), THINKING, 1);
	const text = shown.render(WIDTH).join("\n");
	check("with thinking shown, the reasoning is retired too", text.includes("weighing the options"), false);
	check("and the answer survives", text.includes("the answer"), true);
}

/* -------------------------------------------------------------------------- */
console.log("\n--- a run collapses once the model has spoken after it ---");

/** An assistant message carrying text — the thing that ends a working phase. */
const answer = (text = "done") =>
	new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as never,
		true,
		getMarkdownTheme(),
		"Thinking...",
		1,
	);

// The wording first, on its own, with no components in the way.
check("one tool, one phrase", summarise(["bash"]), "Ran 1 shell command");
check("counted, not listed", summarise(["read", "read", "read"]), "Read 3 files");
check("singular and plural both read", summarise(["grep", "read", "read", "bash", "bash"]), "Searched for 1 pattern, read 2 files, ran 2 shell commands");
// First-appearance order, so the line reads in the order the work happened.
check("order follows the calls", summarise(["bash", "read"]), "Ran 1 shell command, read 1 file");
// A tool with no phrase names itself rather than being given a guessed verb —
// MCP servers and other extensions add tools this has never heard of.
check("an unknown tool names itself", summarise(["lsp_diagnostics", "lsp_diagnostics"]), "Called lsp_diagnostics 2 times");
check("and once, once", summarise(["mcp__thing__do"]), "Called mcp__thing__do once");
check("nothing to say is nothing", summarise([]), "");

{
	// The rule that matters: a result is not what folds a run — an ANSWER is.
	// Until the model has said something, the calls are the only account of what
	// is happening and they stay in full.
	const working = new Container();
	working.addChild(toolCall("grep", { pattern: "x" }, "3 matches"));
	working.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	const midTurn = working.render(WIDTH).join("\n");
	// `3 matches` is grep's result line and `a.ts` is read's call line — read
	// shows no result until expanded, so asserting on its content would pass for
	// the wrong reason.
	check("settled calls with no answer after them stay open", midTurn.includes("3 matches") && midTurn.includes("a.ts"), true);
	check("and are not summarised away mid-turn", midTurn.includes("Searched for 1 pattern"), false);
	// The moment an answer lands, everything that produced it becomes one line.
	working.addChild(answer("here is what I found"));
	const afterAnswer = working.render(WIDTH).join("\n");
	check("the answer folds the work behind it", afterAnswer.includes("Searched for 1 pattern, read 1 file"), true);
	check("and the answer itself is untouched", afterAnswer.includes("here is what I found"), true);
	check("the output it folded is gone", afterAnswer.includes("3 matches"), false);
}

{
	const chat = new Container();
	chat.addChild(toolCall("grep", { pattern: "x" }, "3 matches"));
	chat.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	chat.addChild(toolCall("read", { file_path: "b.ts" }, "bbb"));
	chat.addChild(answer());
	const collapsed = chat.render(WIDTH);
	const body = collapsed.join("\n");

	check("a run of three is one line", collapsed.filter((l) => !isBlank(l)).length, 2);
	check("and the line says what they did", body.includes("Searched for 1 pattern, read 2 files"), true);
	check("the output itself is gone", body.includes("3 matches") || body.includes("aaa"), false);
	check("with the answer still under it", body.includes("done"), true);
	check("no line outruns the width", collapsed.every((l) => visibleWidth(l) <= WIDTH), true);

	// Expanding is pi's own key: it sets `expanded` on every tool component, and
	// the group simply stops grouping. No second binding, no state of this
	// extension's to fall out of step.
	for (const child of chat.children) (child as any).setExpanded?.(true);
	const expanded = chat.render(WIDTH).join("\n");
	check("expanded, the calls are back", expanded.includes("3 matches") && expanded.includes("aaa"), true);
	check("and the summary is not", expanded.includes("Searched for 1 pattern"), false);
	for (const child of chat.children) (child as any).setExpanded?.(false);
	check("collapsing again is not one-way", chat.render(WIDTH).join("\n").includes("Searched for 1 pattern"), true);
}

{
	// A call still running is the thing you are watching. It must never be
	// swallowed, and it ends the run before it.
	const chat = new Container();
	chat.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	chat.addChild(toolCall("read", { file_path: "b.ts" }, "bbb"));
	const running = new ToolExecutionComponent("bash", "id-running", { command: "pnpm test" }, {}, undefined, ui as never, ROOT);
	running.setArgsComplete();
	running.markExecutionStarted();
	chat.addChild(running);
	// Something spoken later, so the settled pair is eligible to fold at all.
	chat.addChild(answer());

	const body = chat.render(WIDTH).join("\n");
	check("the settled pair collapses", body.includes("Read 2 files"), true);
	check("the running call is still drawn", body.includes("pnpm test"), true);
	check("and is not counted into the summary", body.includes("ran 1 shell command"), false);
}

{
	// One call on its own is not "several" — its output is usually the thing
	// being looked at, and hiding it costs more than the line it saves.
	const chat = new Container();
	chat.addChild(toolCall("bash", { command: "git status" }, "clean"));
	chat.addChild(answer());
	const body = chat.render(WIDTH).join("\n");
	check("a lone call is left alone", body.includes("clean"), true);
	check("with no summary over it", body.includes("Ran 1 shell command"), false);
}

{
	// Anything that is not a tool call breaks the run, so two groups either side
	// of an answer stay two groups.
	const chat = new Container();
	chat.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	chat.addChild(toolCall("read", { file_path: "b.ts" }, "bbb"));
	chat.addChild(new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text: "found it" }], stopReason: "stop" } as never,
		true,
		getMarkdownTheme(),
		"Thinking...",
		1,
	));
	chat.addChild(toolCall("bash", { command: "one" }, "1"));
	chat.addChild(toolCall("bash", { command: "two" }, "2"));
	chat.addChild(answer("and done"));
	const body = chat.render(WIDTH);
	const text = body.join("\n");
	check("the first run collapses", text.includes("Read 2 files"), true);
	check("the answer between them survives", text.includes("found it"), true);
	check("and the second run is its own line", text.includes("Ran 2 shell commands"), true);
}

{
	// Every other container in the tree holds text, and must come back byte for
	// byte — the guard against this patch reaching past the chat.
	const plain = new Container();
	plain.addChild(new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text: "just prose" }], stopReason: "stop" } as never,
		true,
		getMarkdownTheme(),
		"Thinking...",
		1,
	));
	check("a container with no tool calls is untouched", plain.render(WIDTH).join("\n").includes("just prose"), true);
}

/* -------------------------------------------------------------------------- */
console.log("\n--- a turn is a CHAIN of assistant messages, and all of them clear ---");

{
	// The bug the first version shipped with. A turn that calls tools is
	// reason → call → reason → call, one component per link, and only the last
	// was ever live at settle time. Rebuilding just that one left a "Thinking..."
	// on every message before it — which in a short exchange looks like it works.
	const THINKING = "Thinking...";
	const link = () =>
		new AssistantMessageComponent(
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "step" }, { type: "toolCall", id: "t", name: "read", arguments: {} }],
				stopReason: "toolUse",
			} as never,
			true,
			getMarkdownTheme(),
			THINKING,
			1,
		);

	let endTurnCleared: boolean[] = [];
	beginTurn();
	const first = link();
	const second = link();
	const third = link();
	// Streaming touches each in turn; only the last is live when the turn ends.
	for (const c of [first, second, third]) c.updateContent((c as any).lastMessage);

	check("all three show their reasoning mid-turn", [first, second, third].every((c) => c.render(WIDTH).join("").includes(THINKING)), true);
	endTurn();
	endTurnCleared = [first, second, third].map((c) => !c.render(WIDTH).join("").includes(THINKING));
	// Named one by one rather than with an .every(), so a failure says WHICH link
	// kept its label — the bug was that only the last one cleared.
	check("the first link clears", endTurnCleared[0], true);
	check("the middle one clears", endTurnCleared[1], true);
	check("and so does the last", endTurnCleared[2], true);
}

/* -------------------------------------------------------------------------- */
console.log("\n--- a message with nothing to say does not split a run ---");

{
	// Once reasoning is retired, the assistant messages BETWEEN tool calls render
	// as nothing — and a nothing was still splitting one run into two summary
	// lines with an invisible gap between them.
	const silent = () =>
		new AssistantMessageComponent(
			{ role: "assistant", content: [{ type: "thinking", thinking: "step" }], stopReason: "toolUse" } as never,
			true,
			getMarkdownTheme(),
			"Thinking...",
			1,
		);

	const chat = new Container();
	chat.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	chat.addChild(silent());
	chat.addChild(toolCall("bash", { command: "one" }, "1"));
	chat.addChild(silent());
	chat.addChild(toolCall("bash", { command: "two" }, "2"));
	chat.addChild(answer("all three done"));

	const lines = chat.render(WIDTH).filter((l) => !isBlank(l));
	// One summary plus the answer that folded it.
	check("the whole chain is one line", lines.length, 2);
	check("counting every call across it", lines[0]?.includes("Read 1 file, ran 2 shell commands"), true);

	// ...but a message the model actually SPOKE is a real boundary: the calls
	// before it and after it are answering different things.
	const spoken = new Container();
	spoken.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	spoken.addChild(toolCall("read", { file_path: "b.ts" }, "bbb"));
	spoken.addChild(new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text: "found it" }], stopReason: "stop" } as never,
		true,
		getMarkdownTheme(),
		"Thinking...",
		1,
	));
	spoken.addChild(toolCall("bash", { command: "one" }, "1"));
	spoken.addChild(toolCall("bash", { command: "two" }, "2"));
	spoken.addChild(answer("and done"));
	const text = spoken.render(WIDTH).join("\n");
	check("text between them still splits the runs", text.includes("Read 2 files") && text.includes("Ran 2 shell commands"), true);
	check("and what was said is still there", text.includes("found it"), true);
}

/* -------------------------------------------------------------------------- */
console.log("\n--- the summary is the quietest line on the screen ---");

{
	setPaint((color, text) => `<${color}>${text}`);
	const chat = new Container();
	chat.addChild(toolCall("read", { file_path: "a.ts" }, "aaa"));
	chat.addChild(toolCall("read", { file_path: "b.ts" }, "bbb"));
	chat.addChild(answer());
	const line = chat.render(WIDTH).find((l) => l.includes("Read 2 files"))!;
	// It says "nothing here needs you", so it must not read as loud as the answer
	// above it. At `muted` it did.
	check("painted in the summary colour", line.includes(`<${CONFIG.summaryColor}>`), true);
	check("which is dimmer than a live call's dot", CONFIG.summaryColor !== CONFIG.callOkColor, true);
	setPaint((_color, text) => text);
}

/* -------------------------------------------------------------------------- */
console.log("\n--- pi's own edit: one line once it has landed ---");

{
	// pi's edit declares `renderShell: "self"`, which for any other tool means
	// "the author chose the frame" and keeps it boxed. For edit it is a
	// mechanical choice, and boxing it made every edit the loudest thing on
	// the screen and the one call that never folded.
	const before = "const a = 1;\nconst b = 2;\n";
	const after = "const a = 1;\nconst b = 3;\n";
	// Named relative to the cwd the component gets, the way the model names
	// files: pi resolves the preview against it, and the header stays short.
	const file = "edit-me.ts";
	writeFileSync(join(ROOT, file), before);
	const edits = [{ oldText: "const b = 2;", newText: "const b = 3;" }];
	const edit = new ToolExecutionComponent("edit", "id-edit", { path: file, edits }, {}, undefined, ui as never, ROOT);
	edit.setArgsComplete();
	edit.markExecutionStarted();
	// pi computes the preview off the event loop, from the file on disk.
	await new Promise((resolve) => setTimeout(resolve, 100));

	const pending = edit.render(WIDTH);
	check("while it runs, the preview diff is on screen", pending.some((l) => seen(l).includes("const b = 3;")), true);
	check("under a dot, not in a box", pending.some((l) => l.includes(`${ESC}[48;`)), false);
	check("with the dot at column 0", trimmedRight(pending.find((l) => !isBlank(l)) ?? "").startsWith("● edit"), true);

	const { diff } = generateDiffString(before, after);
	edit.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff, firstChangedLine: 2 }, isError: false }, false);
	const settled = edit.render(WIDTH);
	const shown = settled.filter((l) => !isBlank(l));
	check("settled, it is one line", shown.length, 1);
	check("naming the tool and the file", seen(shown[0] ?? "").startsWith("● edit"), true);
	check("with the counts right after them", trimmedRight(shown[0] ?? "").endsWith("edit-me.ts  +1 -1"), true);
	check("and no diff line under it", settled.some((l) => seen(l).includes("const b")), false);
	check("still no tint", settled.some((l) => l.includes(`${ESC}[48;`)), false);
	check("the same frame is served from the memo", edit.render(WIDTH) === settled, true);

	edit.setExpanded(true);
	check("expanded brings the diff back", edit.render(WIDTH).some((l) => seen(l).includes("const b = 3;")), true);
	edit.setExpanded(false);
	check("and collapsing takes it away again", edit.render(WIDTH).filter((l) => !isBlank(l)).length, 1);

	// Folded like every other call now — the very thing the box prevented.
	const chat = new Container();
	chat.addChild(edit);
	chat.addChild(toolCall("bash", { command: "pnpm test" }, "ok"));
	chat.addChild(answer());
	const folded = chat.render(WIDTH).join("\n");
	check("it folds with the run it belongs to", folded.includes("Edited 1 file, ran 1 shell command"), true);
	check("and its line is gone into the summary", folded.includes("+1 -1"), false);

	// A failure keeps its reason: pi puts it in the call's body, not the result.
	const failed = new ToolExecutionComponent("edit", "id-edit-fail", { path: file, edits: [{ oldText: "nope", newText: "x" }] }, {}, undefined, ui as never, ROOT);
	failed.setArgsComplete();
	failed.markExecutionStarted();
	await new Promise((resolve) => setTimeout(resolve, 100));
	failed.updateResult({ content: [{ type: "text", text: "Could not find edits[0]" }], details: undefined, isError: true }, false);
	const failure = failed.render(WIDTH);
	check("a failed edit keeps the reason on screen", failure.some((l) => seen(l).includes("Could not find")), true);
	check("under a red dot", (() => { setPaint((color, text) => `<${color}>${text}`); const red = failed.render(WIDTH).some((l) => l.includes(`<${CONFIG.callErrorColor}>`)); setPaint((_c, t) => t); return red; })(), true);

	// An extension's self-framing tool is still its author's business.
	check("a self-framing extension tool is still left alone", selfDrawn.render(WIDTH).some((line) => seen(line).includes("drawn by its author")), true);

	// Only pi's edit Box is stepped around — told by the preview fields pi
	// stamps on it. Any other tool that draws a Box keeps every child of it.
	const { Box, Text } = await import("@earendil-works/pi-tui");
	const boxed = (name: string, shell?: "self") =>
		new ToolExecutionComponent(
			name,
			`id-${name}`,
			{ path: "x.ts" },
			{},
			{
				name,
				...(shell ? { renderShell: shell } : {}),
				renderCall: () => {
					const box = new Box(0, 0, (text: string) => text);
					box.addChild(new Text("title line", 0, 0));
					box.addChild(new Text("body line", 0, 0));
					return box;
				},
			} as never,
			ui as never,
			ROOT,
		);
	const foreign = boxed("boxy");
	foreign.setArgsComplete();
	foreign.markExecutionStarted();
	foreign.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, isError: false }, false);
	check("a foreign Box keeps its body once settled", foreign.render(WIDTH).some((line) => seen(line).includes("body line")), true);
	const ownEdit = boxed("edit", "self");
	ownEdit.setArgsComplete();
	ownEdit.markExecutionStarted();
	ownEdit.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: "-1 a\n+1 b" }, isError: false }, false);
	check("and so does an extension's own edit, whatever its name", ownEdit.render(WIDTH).some((line) => seen(line).includes("body line")), true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
