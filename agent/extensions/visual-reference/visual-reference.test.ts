/**
 * Tests for visual-reference.
 *
 * The detection is pinned against pi's ACTUAL refusal string (copied from
 * core/tools/read.js) and against the real file that caused this — a 662KB
 * bundled mockup whose UI sat on line 388 at 459.2KB. A regex written to match
 * a paraphrase would pass here and never fire in practice.
 *
 * Run: jiti agent/extensions/visual-reference/visual-reference.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "visref-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { adviseOnReadResult, fileUrl, isRenderable, parseOversizedLine } = await import("./detect.ts");
const { VISUAL_REFERENCE_GUIDELINE } = await import("./guideline.ts");
const { DEFAULT_SETTINGS, loadSettings, resolveSettings, default: register } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// pi's refusal, verbatim in SHAPE — the numbers and the space in the filename
// are copied from the real session that motivated this, but the path is not.
// This repo is public: the original fixture pasted a home directory and the name
// of a private design file straight into it, which is what commit a6a689e had
// just finished stripping out of the tree.
const REAL = "[Line 388 is 459.2KB, exceeds 50.0KB limit. Use bash: sed -n '388p' /tmp/ref/ant pi Desktop.html | head -c 51200]";

console.log("--- parsing pi's refusal ---");
check("the real refusal parses", parseOversizedLine(REAL), {
	line: 388,
	size: "459.2KB",
	// A path with a SPACE in it, which is what the actual file had.
	path: "/tmp/ref/ant pi Desktop.html",
});
check("ordinary output is not a refusal", parseOversizedLine("42 lines read"), undefined);
check("a similar-looking sentence is not one", parseOversizedLine("Line 388 is long"), undefined);

console.log("\n--- which files get the advice ---");
check("html", isRenderable("/a/b.html"), true);
check("htm", isRenderable("/a/b.htm"), true);
check("svg", isRenderable("/a/b.svg"), true);
check("pdf", isRenderable("/a/b.pdf"), true);
// Deliberately narrow: a huge line in minified source really is a sed job, and
// telling the agent to open a bundle.js in a browser would be worse advice.
check("minified js is left alone", isRenderable("/a/bundle.min.js"), false);
check("css is left alone", isRenderable("/a/site.css"), false);
check("json is left alone", isRenderable("/a/data.json"), false);

console.log("\n--- the advice ---");
const advised = adviseOnReadResult(REAL)!;
check("the original refusal is kept", advised.startsWith(REAL), true);
check("it names the real problem", advised.includes("BUNDLED DOCUMENT"), true);
// The specific trap: the file self-extracts, so even the readable source is
// only the loader. That is what made the agent design from a loading screen.
check("it warns the source may only be a loader", advised.includes("shows only the loader"), true);
check("it gives a runnable command", advised.includes("agent-browser --session ref --allow-file-access open"), true);
// Without the wait the screenshot catches the unpacker mid-flight — which is
// exactly the "loading thumbnail" the advisor flagged.
check("including the wait for the unpacker", advised.includes("wait 4000"), true);
check("and pulling the unpacked DOM, not just an image", advised.includes("eval"), true);
// The path has a space; a bare file:// URL with a raw space is not a valid URL.
check("the path is URL-encoded", advised.includes("ant%20pi%20Desktop.html"), true);
// Separators must survive encoding, or the URL stops naming a path at all.
check("but the separators survive", advised.includes("file:///tmp/ref/"), true);

check("a non-renderable file gets nothing", adviseOnReadResult(REAL.replace("Desktop.html", "bundle.min.js")), undefined);

console.log("\n--- the suggested command has to survive a shell ---");
// encodeURI left these three alone. The URL is interpolated inside single
// quotes, so an apostrophe closed the quote and produced a broken command; `#`
// and `?` were read by the browser as a fragment or query, pointing it at a
// file that does not exist. Both ended with the agent giving up on the
// reference and inventing its own UI.
check("an apostrophe is escaped", fileUrl("/tmp/ref/it's a mockup.html"), "file:///tmp/ref/it%27s%20a%20mockup.html");
check("a hash is escaped", fileUrl("/tmp/ref/design #2.html"), "file:///tmp/ref/design%20%232.html");
check("a question mark is escaped", fileUrl("/tmp/ref/what?.html"), "file:///tmp/ref/what%3F.html");
// The whole point: the emitted line must be a syntactically valid shell command.
{
	const tricky = adviseOnReadResult(REAL.replace("/tmp/ref/ant pi Desktop.html", "/tmp/ref/it's #1.html"))!;
	const line = tricky.split("\n").find((l) => l.includes("--allow-file-access"))!;
	const quoted = line.slice(line.indexOf("'"));
	check("no unbalanced quote in the command", (quoted.match(/'/g) ?? []).length, 2);
}
check("a normal read gets nothing", adviseOnReadResult("hello\nworld"), undefined);

console.log("\n--- the guideline ---");
check("it is about order", VISUAL_REFERENCE_GUIDELINE.includes("BEFORE you build, not after"), true);
check("it says render rather than read", VISUAL_REFERENCE_GUIDELINE.includes("Render it, don't read it"), true);
// The measured failure was 23 looks at its own app to 6 at the reference.
check("it names the self-comparison trap", VISUAL_REFERENCE_GUIDELINE.includes("Looking at your own output is not comparison"), true);
check("it asks rather than guessing when the reference is unusable", VISUAL_REFERENCE_GUIDELINE.includes("say so and ask"), true);

console.log("\n--- settings ---");
check("absent -> defaults", resolveSettings(undefined), DEFAULT_SETTINGS);
check("halves switch independently", resolveSettings({ readAdvice: false }), { ...DEFAULT_SETTINGS, readAdvice: false });
// The removed gate's key must not come back as a field just because an old
// settings.json still carries it — every machine that ran the gate has one.
check("a leftover verifyGate key is ignored", resolveSettings({ verifyGate: false }), DEFAULT_SETTINGS);
writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ visualReference: { guideline: false } }));
check("read from disk", loadSettings(AGENT).guideline, false);
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unparsable -> defaults", loadSettings(AGENT), DEFAULT_SETTINGS);

console.log("\n--- wiring ---");
type Handler = (event: unknown) => any;

/**
 * A minimal stand-in for pi's real ExtensionAPI. `on` collects handlers into
 * arrays, not a single slot: pi's real runner chains every handler registered
 * for an event rather than letting the last one clobber the rest (see
 * runner.js's emitToolResult), and a Map<string, Handler> that overwrote on a
 * second registration would silently test the wrong handler. Only readAdvice
 * registers on `tool_result` today — the shape is kept because the assertions
 * below are about which handlers exist at all.
 */
function install(block: Record<string, unknown>) {
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ visualReference: block }));
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[] = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	register({
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: (message: unknown, options: unknown) => sent.push([message, options]),
		events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }) },
	} as never);
	return { handlers, sent, emitted };
}

/**
 * Dispatch every registered handler for one event, chaining tool_result
 * fields the way pi's real emitToolResult does: each handler sees the event as
 * modified by the ones before it, and only fields a handler actually returns
 * replace the running result.
 */
function runToolResult(handlers: Map<string, Handler[]>, event: Record<string, unknown>) {
	let current: Record<string, unknown> = { ...event };
	let modified = false;
	for (const handler of handlers.get("tool_result") ?? []) {
		const result = handler(current);
		if (!result) continue;
		for (const field of ["content", "details", "isError", "usage"] as const) {
			if (result[field] !== undefined) {
				current[field] = result[field];
				modified = true;
			}
		}
	}
	return modified ? { content: current.content, details: current.details, isError: current.isError, usage: current.usage } : undefined;
}

check("disabled registers nothing", [...install({ enabled: false }).handlers.keys()], []);
check("readAdvice registers alone", [...install({ guideline: false }).handlers.keys()], ["tool_result"]);
check("guideline registers alone", [...install({ readAdvice: false }).handlers.keys()], ["before_agent_start"]);
// Both model-facing flags off leaves nothing at all: the pin producer that used
// to run regardless went with the gate it was extracted from.
check("both flags off registers nothing", [...install({ readAdvice: false, guideline: false }).handlers.keys()], []);
// THE REMOVAL, at the wiring level: agent_end is where the gate resumed the
// agent, and nothing registers there any more.
check("nothing hooks agent_end", [...install({}).handlers.keys()].includes("agent_end"), false);

const { handlers, sent, emitted } = install({});
const readEvent = {
	toolName: "read",
	content: [{ type: "text", text: REAL }],
	details: { truncation: { totalLines: 400 } },
	isError: false,
	usage: { input: 3, output: 4 },
};
const out = runToolResult(handlers, readEvent)!;
check("an oversized html read is advised", String((out.content as { text: string }[])[0]!.text).includes("BUNDLED DOCUMENT"), true);
// pi rebuilds the result from this return value, so anything not echoed back is
// deleted — an omitted `details` blanks the renderer, an omitted `usage` loses
// the spend. Only isError has a fallback.
check("details survive", out.details, { truncation: { totalLines: 400 } });
check("usage survives", out.usage, { input: 3, output: 4 });
check("a normal read is untouched", runToolResult(handlers, { toolName: "read", content: [{ type: "text", text: "ok" }] }), undefined);
check(
	"a bash call with no reference or screenshot evidence is untouched",
	runToolResult(handlers, { toolName: "bash", content: [{ type: "text", text: REAL }] }),
	undefined,
);

// Appending, never replacing: several extensions chain on this hook, and
// returning a bare guideline would delete the system prompt.
const before = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE PROMPT" });
check("the guideline is appended to the prompt", before.systemPrompt.startsWith("BASE PROMPT"), true);
check("and the guideline is in there", before.systemPrompt.includes("Working from a reference"), true);

console.log("\n--- the removed gate stays removed ---");
{
	// The measured false positive, replayed: UI-extension edits with no render
	// used to resume the agent at agent_end with "screenshot your app AND the
	// reference", and that is how an agent with no reference at all ended up
	// driving a browser. The extension now says nothing about them.
	const { handlers: h, sent: s } = install({});
	runToolResult(h, { toolName: "edit", input: { path: "/app/Button.css" }, isError: false, content: [] });
	runToolResult(h, { toolName: "write", input: { path: "/app/Header.tsx" }, isError: false, content: [] });
	check("UI edits send no follow-up", s.length, 0);
	check("and there is no agent_end handler to fire one", h.get("agent_end"), undefined);
}
{
	// The pin producer went with it. A reference opened in a browser and read
	// back as an image used to announce that image's toolCallId on
	// "context-diet:pin"; nothing publishes on that channel from here now.
	const { handlers: h, emitted: e } = install({});
	runToolResult(h, {
		toolName: "bash",
		input: { command: "agent-browser --session ref --allow-file-access open 'file:///tmp/ref/mock.html'" },
		isError: false,
		content: [],
	});
	runToolResult(h, { toolName: "read", toolCallId: "call-42", input: {}, isError: false, content: [{ type: "image" }] });
	check("no pin is emitted for a reference screenshot", e.length, 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
