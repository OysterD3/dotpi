/**
 * Tests for the memory extension: the cwd→slug locating (including the
 * underscore fallback), frontmatter parsing, reading a memory directory,
 * budgeted assembly, settings, and the wiring (session_start loads it,
 * before_agent_start appends it to the system prompt).
 *
 * Everything runs against temp directories laid out like the real store.
 *
 * Run: jiti agent/extensions/memory/memory.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "memory-test-"));
const AGENT = join(ROOT, "agent");
const CLAUDE = join(ROOT, "claude");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { projectSlugs, memoryDirFor, globalClaudeMd } = await import("./locate.ts");
const { parseFrontmatter, readMemory, assemble } = await import("./load.ts");
const { loadSettings, loadMemoryFor } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

// ------------------------------------------------------------------- locate

console.log("--- locate: cwd -> slug ---");
check("dotfile path (matches the real -Users--pi form)", projectSlugs("/Users/me/.pi")[0], "-Users-me--pi");
check("hyphens survive", projectSlugs("/Users/me/acme/acme-api")[0], "-Users-me-acme-acme-api");
check("underscore path yields two candidates", projectSlugs("/work/my_proj"), ["-work-my-proj", "-work-my_proj"]);

// Lay out a fake store.
const mkMemory = (slug: string) => {
	const dir = join(CLAUDE, "projects", slug, "memory");
	mkdirSync(dir, { recursive: true });
	return dir;
};
const dirA = mkMemory("-work-alpha");
writeFileSync(join(dirA, "MEMORY.md"), "# Project Memory\n\n## Feedback\n- [PR rule](feedback_pr.md): only create PRs");
writeFileSync(join(dirA, "feedback_pr.md"), "---\nname: Never merge PRs\ndescription: only create\ntype: feedback\n---\nCreate PRs, never merge.\n\n**Why:** review first.");
writeFileSync(join(dirA, "arch.md"), "---\nname: Architecture\nmetadata:\n  type: project\n---\nUses hexagonal architecture.");

check("finds the memory dir for a cwd", memoryDirFor("/work/alpha", CLAUDE), dirA);
// A path whose only matching dir uses the underscore form is still found.
const dirU = mkMemory("-work-und_score");
check("underscore fallback candidate is found", memoryDirFor("/work/und_score", CLAUDE), dirU);
check("missing project -> undefined", memoryDirFor("/no/such/place", CLAUDE), undefined);
check("no global CLAUDE.md yet", globalClaudeMd(CLAUDE), undefined);
writeFileSync(join(CLAUDE, "CLAUDE.md"), "Global rule: be concise.");
check("global CLAUDE.md found once present", globalClaudeMd(CLAUDE), join(CLAUDE, "CLAUDE.md"));

// -------------------------------------------------------------- frontmatter

console.log("\n--- frontmatter parsing ---");
check("flat type", parseFrontmatter("---\nname: N\ndescription: D\ntype: feedback\n---\nBODY"), { name: "N", description: "D", type: "feedback", body: "BODY" });
check("nested metadata.type", parseFrontmatter("---\nname: N\nmetadata:\n  type: project\n---\nB").type, "project");
check("quotes stripped", parseFrontmatter('---\nname: "Q"\n---\nx').name, "Q");
check("no frontmatter -> raw body", parseFrontmatter("just a note"), { body: "just a note" });

// ------------------------------------------------------------------- read

console.log("\n--- reading a memory dir ---");
const raw = readMemory(dirA);
checkTrue("MEMORY.md captured", raw.memoryMd?.startsWith("# Project Memory") ?? false);
check("both fact files read, sorted", raw.facts.map((f) => f.file), ["arch.md", "feedback_pr.md"]);
check("frontmatter carried onto facts", [raw.facts[0].name, raw.facts[0].type], ["Architecture", "project"]);
check("empty/missing dir is safe", readMemory(join(CLAUDE, "nope")), { facts: [] });

// ---------------------------------------------------------------- assemble

console.log("\n--- assembly and budget ---");
const full = assemble({ memoryMd: raw.memoryMd, facts: raw.facts, globalClaudeMd: "Global rule.", includeFacts: true, maxChars: 24_000 });
checkTrue("has the header", full.text.startsWith("# Memory"));
checkTrue("includes the global section", full.text.includes("## Global (CLAUDE.md)") && full.text.includes("Global rule."));
checkTrue("includes the index", full.text.includes("## Index (MEMORY.md)") && full.text.includes("only create PRs"));
checkTrue("includes facts with headings and type tags", full.text.includes("## Facts") && full.text.includes("### Never merge PRs [feedback]") && full.text.includes("### Architecture [project]"));
check("counts the facts", full.factCount, 2);
check("not truncated at a generous budget", full.truncated, false);

const indexOnly = assemble({ memoryMd: raw.memoryMd, facts: raw.facts, includeFacts: false, maxChars: 24_000 });
check("includeFacts=false drops fact bodies", indexOnly.factCount, 0);
checkTrue("but keeps the index", indexOnly.text.includes("## Index (MEMORY.md)") && !indexOnly.text.includes("## Facts"));

const tight = assemble({ memoryMd: raw.memoryMd, facts: raw.facts, includeFacts: true, maxChars: 200 });
checkTrue("a tight budget truncates", tight.truncated && tight.factCount < 2);
checkTrue("the header always survives", tight.text.startsWith("# Memory"));

// ------------------------------------------------------------------- settings

console.log("\n--- settings ---");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ memory: block }));
writeSettings({});
{
	const s = loadSettings(AGENT);
	check("defaults", [s.enabled, s.includeFacts, s.maxChars], [true, true, 24_000]);
}
writeSettings({ enabled: false, includeFacts: false, maxChars: 5000, claudeHome: "/custom" });
{
	const s = loadSettings(AGENT);
	check("overrides", [s.enabled, s.includeFacts, s.maxChars, s.claudeHome], [false, false, 5000, "/custom"]);
}
writeSettings({ maxChars: -3 });
check("bad maxChars falls back", loadSettings(AGENT).maxChars, 24_000);

// ------------------------------------------------------------ loadMemoryFor

console.log("\n--- loadMemoryFor ---");
const settingsA = { enabled: true, includeFacts: true, maxChars: 24_000, claudeHome: CLAUDE };
const memA = loadMemoryFor("/work/alpha", settingsA);
checkTrue("loads memory for a known project", Boolean(memA?.text.includes("Never merge PRs")));
check("records the source dir", memA?.source, dirA);
check("disabled -> nothing", loadMemoryFor("/work/alpha", { ...settingsA, enabled: false }), undefined);
// Unknown project still surfaces the global CLAUDE.md as memory.
const memGlobalOnly = loadMemoryFor("/no/project/here", settingsA);
checkTrue("global-only memory when no project dir", Boolean(memGlobalOnly?.text.includes("Global rule")) && memGlobalOnly?.source === undefined);

// --------------------------------------------------------- wiring vs fake pi

console.log("\n--- wiring against a fake pi ---");
const extension = (await import("./index.ts")).default;
function makePi() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	return {
		pi: {
			on: (event: string, h: Function) => handlers.set(event, h),
			registerCommand: (name: string, def: any) => commands.set(name, def),
		},
		handlers,
		commands,
	};
}

{
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	checkTrue("registers /memory", h.commands.has("memory"));

	const statuses: Array<[string, string | undefined]> = [];
	const ctx = { cwd: "/work/alpha", hasUI: true, ui: { setStatus: (k: string, t: string | undefined) => statuses.push([k, t]), notify: () => {} } };
	h.handlers.get("session_start")!({}, ctx);
	checkTrue("status chip set when memory present", statuses.at(-1)?.[0] === "memory" && String(statuses.at(-1)?.[1]).includes("memory"));

	const out = h.handlers.get("before_agent_start")!({ systemPrompt: "BASE PROMPT" });
	checkTrue("appends memory to the system prompt", out?.systemPrompt.startsWith("BASE PROMPT\n\n# Memory") && out.systemPrompt.includes("Never merge PRs"));
}
{
	// No memory for this cwd -> no injection.
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	const ctx = { cwd: "/somewhere/empty", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
	// remove the global so there is truly nothing
	rmSync(join(CLAUDE, "CLAUDE.md"), { force: true });
	h.handlers.get("session_start")!({}, ctx);
	const out = h.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
	check("no memory -> no systemPrompt change", out, undefined);
}
{
	// Disabled -> no injection even where memory exists.
	writeFileSync(join(CLAUDE, "CLAUDE.md"), "Global rule: be concise.");
	writeSettings({ enabled: false, claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	const ctx = { cwd: "/work/alpha", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
	h.handlers.get("session_start")!({}, ctx);
	check("disabled injects nothing", h.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
