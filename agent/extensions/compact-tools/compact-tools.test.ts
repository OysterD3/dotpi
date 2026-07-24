/**
 * Tests for compact-tools: the pure summary builders (call and result lines,
 * collapsed and expanded), settings parsing, and the wiring against a fake pi
 * (registers all seven built-ins when enabled, none when disabled).
 *
 * Run: jiti agent/extensions/compact-tools/compact-tools.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "compact-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { callLine, resultLine, textOf } = await import("./render.ts");
const { loadSettings } = await import("./index.ts");

// Identity theme: colours are erased so assertions see plain text.
const T = { fg: (_role: string, s: string) => s, bold: (s: string) => s };

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

// --------------------------------------------------------------- call lines

console.log("--- call lines ---");
check("read shows the path", callLine("read", { path: "src/foo.ts" }, T), "read src/foo.ts");
check("read shows offset/limit", callLine("read", { path: "a.ts", offset: 5, limit: 10 }, T), "read a.ts (offset=5, limit=10)");
check("bash shows the command", callLine("bash", { command: "pnpm test" }, T), "$ pnpm test");
checkTrue("bash elides a very long command", callLine("bash", { command: "x".repeat(300) }, T).endsWith("…"));
check("edit shows the path", callLine("edit", { path: "a.ts" }, T), "edit a.ts");
check("write shows path and line count", callLine("write", { path: "a.ts", content: "l1\nl2\nl3" }, T), "write a.ts (3 lines)");
check("grep shows pattern and path", callLine("grep", { pattern: "TODO", path: "src" }, T), "grep TODO in src");
check("ls shows the path", callLine("ls", { path: "src" }, T), "ls src");
check("ls defaults path to .", callLine("ls", {}, T), "ls .");

// ------------------------------------------------------------- result lines

console.log("\n--- result lines (collapsed) ---");
const textResult = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });
const read42 = textResult(Array.from({ length: 42 }, (_, i) => `line${i}`).join("\n"));

check("read summarizes to a line count", resultLine("read", read42, false, T, 100), "42 lines");
check("read notes truncation", resultLine("read", textResult("a\nb", { truncation: { truncated: true, totalLines: 999 } }), false, T, 100), "2 lines (of 999)");
check("read shows image", resultLine("read", { content: [{ type: "image" }] }, false, T, 100), "image");
check("bash success", resultLine("bash", textResult("out1\nout2\nexit code: 0"), false, T, 100), "done (3 lines)");
check("bash non-zero exit", resultLine("bash", textResult("boom\nexit code: 2"), false, T, 100), "exit 2 (2 lines)");
check("edit diff stats", resultLine("edit", textResult("done", { diff: "--- a\n+++ b\n+added one\n+added two\n-removed" }), false, T, 100), "+2 / -1");
check("edit with no diff", resultLine("edit", textResult("ok", {}), false, T, 100), "applied");
check("write", resultLine("write", textResult("Wrote 10 bytes"), false, T, 100), "written");
check("grep plural", resultLine("grep", textResult("a.ts:1:x\nb.ts:2:y"), false, T, 100), "2 matches");
check("grep singular", resultLine("grep", textResult("a.ts:1:x"), false, T, 100), "1 match");
check("find plural", resultLine("find", textResult("a\nb\nc"), false, T, 100), "3 results");
check("ls singular", resultLine("ls", textResult("only"), false, T, 100), "1 entry");
check("ls plural", resultLine("ls", textResult("a\nb"), false, T, 100), "2 entries");

console.log("\n--- errors surface as one line ---");
check("read error", resultLine("read", textResult("Error: ENOENT no such file\nstack..."), false, T, 100), "Error: ENOENT no such file");

console.log("\n--- expanded shows detail, capped ---");
const expanded = resultLine("read", read42, true, T, 10);
checkTrue("collapsed head is kept", expanded.startsWith("42 lines"));
checkTrue("detail lines are appended", expanded.includes("line0") && expanded.includes("line9"));
checkTrue("capped with a 'more' footer", expanded.includes("… 32 more lines") && !expanded.includes("line11"));
check("collapsed shows no detail", resultLine("read", read42, false, T, 10), "42 lines");

console.log("\n--- textOf ---");
check("joins text blocks, ignores others", textOf({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");

// ------------------------------------------------------------------ settings

console.log("\n--- settings ---");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ compactTools: block }));
writeSettings({});
check("defaults", loadSettings(AGENT), { enabled: true, expandedLines: 100 });
writeSettings({ enabled: false, expandedLines: 25 });
check("overrides", loadSettings(AGENT), { enabled: false, expandedLines: 25 });
writeSettings({ expandedLines: -4 });
check("non-positive expandedLines falls back", loadSettings(AGENT).expandedLines, 100);
writeFileSync(join(AGENT, "settings.json"), "{ bad");
check("unreadable falls back", loadSettings(AGENT), { enabled: true, expandedLines: 100 });

// ------------------------------------------------------ wiring against fake pi

console.log("\n--- wiring against a fake pi ---");
const extension = (await import("./index.ts")).default;
function makePi() {
	const tools: any[] = [];
	return { pi: { registerTool: (def: any) => tools.push(def) }, tools };
}

{
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	check("registers all seven built-ins", h.tools.map((t) => t.name).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	checkTrue("each has compact render + delegated execute", h.tools.every((t) => typeof t.renderCall === "function" && typeof t.renderResult === "function" && typeof t.execute === "function"));

	// renderResult returns a real component that renders text.
	const readTool = h.tools.find((t) => t.name === "read");
	const comp = readTool.renderResult({ content: [{ type: "text", text: "a\nb\nc" }] }, { expanded: false, isPartial: false }, T);
	checkTrue("renderResult yields a renderable component", typeof comp.render === "function");
	checkTrue("and it carries the summary", comp.render(80).join(" ").includes("3 lines"));
}
{
	writeSettings({ enabled: false });
	const h = makePi();
	extension(h.pi as never);
	check("disabled registers nothing", h.tools.length, 0);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
