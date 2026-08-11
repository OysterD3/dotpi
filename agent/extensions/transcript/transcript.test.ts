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
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "transcript-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir, initTheme, getMarkdownTheme, AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent } =
	await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { isBlank, prefix, trimBlank, withGutter } = await import("./render.ts");
const { applyPatches, setPaint } = await import("./patch.ts");
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

const bash = toolCall("bash", { command: "pnpm test" }, "405 passed");
const bashLines = bash.render(WIDTH);
const bashShown = bashLines.filter((line) => !isBlank(line));

check("opens with a blank line, keeping pi's rhythm", isBlank(bashLines[0] ?? ""), true);
check("the mark nests the call under the assistant line", trimmedRight(bashShown[0] ?? ""), `  ∟ $ pnpm test`);
check("output hangs under the mark, not beside it", trimmedRight(bashShown[1] ?? ""), "    405 passed");
check("no line carries a background tint", bashLines.some((line) => line.includes(`${ESC}[48;`)), false);
check("no line is wider than the width asked for", bashLines.every((line) => seen(line).length <= WIDTH), true);

/* -------------------------------------------------------------------------- */
console.log("\n--- a failed call still reads as failed ---");

// Dropping the box drops the red tint pi used to signal a failure, so the mark
// has to carry it. Naming the colour rather than painting it keeps the check
// on the decision instead of on a theme's hex values.
setPaint((color, text) => `<${color}>${text}`);
const failed = new ToolExecutionComponent("bash", "id-failed", { command: "pnpm lint" }, {}, undefined, ui as never, ROOT);
failed.setArgsComplete();
failed.markExecutionStarted();
failed.updateResult({ content: [{ type: "text", text: "1 error" }], details: {}, isError: true }, false);

const okMark = bash.render(WIDTH).find((line) => line.includes(CONFIG.toolMark));
const failedMark = failed.render(WIDTH).find((line) => line.includes(CONFIG.toolMark));
check("a call that worked is dim", okMark?.includes(`<${CONFIG.toolColor}>`), true);
check("a call that failed is not", failedMark?.includes(`<${CONFIG.toolColor}>`), false);
check("it carries the error colour", failedMark?.includes(`<${CONFIG.toolErrorColor}>`), true);
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
check("and gets no mark", selfDrawn.render(WIDTH).some((line) => seen(line).includes(CONFIG.toolMark.trim())), false);

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
check("an extension tool drawn in pi's box is de-boxed like any other", trimmedRight(replacedLines.find((l) => !isBlank(l)) ?? ""), "  ∟ $ echo hi");
check("and keeps no tint", replacedLines.some((line) => line.includes(`${ESC}[48;`)), false);

/* -------------------------------------------------------------------------- */
console.log("\n--- applying twice cannot double-mark ---");

applyPatches();
check("the second call is a no-op", user.render(WIDTH).map(trimmedRight)[0], userLines.map(trimmedRight)[0]);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
