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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "memory-test-"));
const AGENT = join(ROOT, "agent");
const CLAUDE = join(ROOT, "claude");
const PIHOME = join(ROOT, "pihome");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { projectSlugs, memoryDirFor, globalClaudeMd } = await import("./locate.ts");
const { parseFrontmatter, readMemory, assemble } = await import("./load.ts");
const { loadSettings, loadMemoryFor, resolveSource } = await import("./index.ts");
const { defaultPiHome, piMemoryDir, piSlug, safeFileName, ensureStore, readOrigin, listFiles } = await import("./store.ts");

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
const writeSettings = (block: Record<string, unknown>) =>
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ memory: { piHome: PIHOME, ...block } }));
writeSettings({});
{
	const s = loadSettings(AGENT);
	check("defaults", [s.enabled, s.includeFacts, s.maxChars, s.writable], [true, true, 24_000, true]);
	checkTrue("piHome defaults under a config dir", defaultPiHome({ XDG_CONFIG_HOME: "/x" }) === "/x/pi");
}
writeSettings({ enabled: false, includeFacts: false, maxChars: 5000, claudeHome: "/custom", writable: false });
{
	const s = loadSettings(AGENT);
	check("overrides", [s.enabled, s.includeFacts, s.maxChars, s.claudeHome, s.writable], [false, false, 5000, "/custom", false]);
}
writeSettings({ maxChars: -3 });
check("bad maxChars falls back", loadSettings(AGENT).maxChars, 24_000);

// ------------------------------------------------------------ loadMemoryFor

console.log("\n--- loadMemoryFor ---");
const settingsA = { enabled: true, includeFacts: true, maxChars: 24_000, claudeHome: CLAUDE, piHome: PIHOME, writable: true };
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
	const tools = new Map<string, any>();
	return {
		pi: {
			on: (event: string, h: Function) => handlers.set(event, h),
			registerCommand: (name: string, def: any) => commands.set(name, def),
			registerTool: (def: any) => tools.set(def.name, def),
		},
		handlers,
		commands,
		tools,
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

// ------------------------------------------------------- pi's own store

console.log("\n--- the store and its guards ---");
{
	check("a plain fact file is allowed", safeFileName("prefers-tabs.md"), "prefers-tabs.md");
	check("MEMORY.md is allowed", safeFileName("MEMORY.md"), "MEMORY.md");
	check("a path is refused", safeFileName("a/b.md"), undefined);
	check("climbing out is refused", safeFileName("../../.ssh/config.md"), undefined);
	check("a dotfile is refused", safeFileName(".origin.json"), undefined);
	check("a non-markdown file is refused", safeFileName("notes.txt"), undefined);
	check("an empty name is refused", safeFileName("   "), undefined);
	check("pi's dir is the primary slug, no probing", piMemoryDir("/work/alpha", PIHOME), join(PIHOME, "memory", piSlug("/work/alpha")));
}

// --------------------------------------------------- the fork, end to end

console.log("\n--- clone on first write ---");
{
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	checkTrue("the memory tool is registered", h.tools.has("memory"));

	const cwd = "/work/alpha";
	const mine = piMemoryDir(cwd, PIHOME);
	const ctx = { cwd, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
	h.handlers.get("session_start")!({}, ctx);

	check("before any write, memory is the inherited store", resolveSource(cwd, loadSettings(AGENT)).own, false);

	const tool = h.tools.get("memory")!;
	const text = (r: any) => r.content[0].text as string;

	// read comes from wherever memory currently is
	const before = await tool.execute("1", { action: "read", file: "feedback_pr.md" }, undefined, undefined, ctx);
	checkTrue("read reaches the inherited file", text(before).includes("Never merge PRs"));

	const written = await tool.execute("2", { action: "write", file: "prefers-tabs.md", content: "---\nname: prefers-tabs\n---\nTabs, always." }, undefined, undefined, ctx);
	checkTrue("the write says it forked", text(written).includes("Forked"));
	checkTrue("pi's store now exists", existsSync(mine));
	checkTrue("the inherited facts came across", existsSync(join(mine, "feedback_pr.md")));
	checkTrue("and the new one is there too", existsSync(join(mine, "prefers-tabs.md")));
	checkTrue("the fork is recorded", readOrigin(mine)?.clonedFrom?.includes("claude") === true);
	check("the other agent's store is untouched", existsSync(join(CLAUDE, "projects", piSlug(cwd), "memory", "prefers-tabs.md")), false);

	check("reads now come from pi's own store", resolveSource(cwd, loadSettings(AGENT)).own, true);
	const injected = h.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
	checkTrue("the new fact is in the next request", injected.systemPrompt.includes("Tabs, always."));
	checkTrue("and so is the inherited one", injected.systemPrompt.includes("Never merge PRs"));

	// A second write must not re-fork or lose anything.
	const again = await tool.execute("3", { action: "write", file: "MEMORY.md", content: "# Memory\n\n- [Tabs](prefers-tabs.md) — indentation" }, undefined, undefined, ctx);
	check("the fork happens once", text(again).includes("Forked"), false);
	checkTrue("the index is written", listFiles(mine).includes("MEMORY.md"));

	const deleted = await tool.execute("4", { action: "delete", file: "prefers-tabs.md" }, undefined, undefined, ctx);
	checkTrue("delete reports what it did", text(deleted).includes("Deleted"));
	check("and the file is gone", existsSync(join(mine, "prefers-tabs.md")), false);
	const missing = await tool.execute("5", { action: "delete", file: "never-existed.md" }, undefined, undefined, ctx);
	checkTrue("deleting nothing is not an error", missing.isError !== true && text(missing).includes("No never-existed.md"));

	const refused = await tool.execute("6", { action: "write", file: "../escape.md", content: "x" }, undefined, undefined, ctx);
	checkTrue("a path escape is refused", refused.isError === true);
	check("and nothing was created", existsSync(join(PIHOME, "memory", "escape.md")), false);

	const listed = await tool.execute("7", { action: "list" }, undefined, undefined, ctx);
	checkTrue("list names pi's files", text(listed).includes("MEMORY.md") && text(listed).includes("feedback_pr.md"));
}

{
	// A project the other agent never knew: the store is created empty, not skipped.
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	const cwd = "/work/brand-new";
	const ctx = { cwd, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
	h.handlers.get("session_start")!({}, ctx);
	const out = await h.tools.get("memory")!.execute("1", { action: "write", file: "first.md", content: "---\nname: first\n---\nSomething true." }, undefined, undefined, ctx);
	check("nothing to fork, so no fork is claimed", (out.content[0].text as string).includes("Forked"), false);
	checkTrue("but the fact is stored", existsSync(join(piMemoryDir(cwd, PIHOME), "first.md")));
	checkTrue("and loads on the next request", h.handlers.get("before_agent_start")!({ systemPrompt: "B" }).systemPrompt.includes("Something true."));
}

{
	// writable:false is the way to keep the old read-only behaviour.
	writeSettings({ claudeHome: CLAUDE, writable: false });
	const h = makePi();
	extension(h.pi as never);
	check("no tool when memory is read-only", h.tools.has("memory"), false);
}

console.log("\n--- what the review found ---");
{
	// A disabled extension must not write, and must not fork.
	writeSettings({ claudeHome: CLAUDE, enabled: false });
	const h = makePi();
	extension(h.pi as never);
	check("no tool at all when memory is off", h.tools.has("memory"), false);
}
{
	// Turned off after registration (settings reload every session_start).
	// A project no earlier block forked, so "nothing was created" means it.
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	const cwd = "/work/switched-off";
	const ctx = { cwd, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
	h.handlers.get("session_start")!({}, ctx);
	writeSettings({ claudeHome: CLAUDE, enabled: false });
	h.handlers.get("session_start")!({}, ctx);
	const out = await h.tools.get("memory")!.execute("1", { action: "write", file: "nope.md", content: "x" }, undefined, undefined, ctx);
	checkTrue("a write while off is refused", out.isError === true);
	check("and forks nothing", existsSync(piMemoryDir(cwd, PIHOME)), false);
}
{
	// The status chip must follow what was actually written.
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	const cwd = "/work/alpha";
	const chips: Array<string | undefined> = [];
	const ctx = { cwd, hasUI: true, ui: { setStatus: (_k: string, t: string | undefined) => chips.push(t), notify: () => {} } };
	h.handlers.get("session_start")!({}, ctx);
	const before = chips.at(-1);
	await h.tools.get("memory")!.execute("1", { action: "write", file: "extra-fact.md", content: "---\nname: extra\n---\nA new fact." }, undefined, undefined, ctx);
	checkTrue("the chip is updated after a write", chips.at(-1) !== before);
	checkTrue("and counts the new fact", String(chips.at(-1)).includes(String((h.handlers.get("before_agent_start")!({ systemPrompt: "" }).systemPrompt.match(/^### /gm) ?? []).length)));
}
{
	// Global-only memory has no source directory to name.
	writeFileSync(join(CLAUDE, "CLAUDE.md"), "Global rule: be concise.");
	writeSettings({ claudeHome: CLAUDE });
	const h = makePi();
	extension(h.pi as never);
	const notices: string[] = [];
	const ctx = { cwd: "/nowhere/at/all", hasUI: true, ui: { setStatus: () => {}, notify: (m: string) => notices.push(m) } };
	h.handlers.get("session_start")!({}, ctx);
	await h.commands.get("memory")!.handler("status", ctx);
	checkTrue("no memory directory is not printed as undefined", !notices.at(-1)!.includes("undefined"));
	checkTrue("and the global file is named instead", notices.at(-1)!.includes("CLAUDE.md"));
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
