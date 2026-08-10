/**
 * Tests for per-skill load modes.
 *
 * The load-bearing one is the round trip: the block being rewritten is built by
 * pi's OWN `formatSkillsForPrompt`, imported from the installed package rather
 * than hand-written here. A hand-written fixture would keep passing on the day
 * pi changes its format, which is the one failure this extension has to notice —
 * so the fixture is generated from the real thing, and parsing it is the test.
 *
 * Run: pnpm dlx jiti agent/extensions/skill-loading/skill-loading.test.ts
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "skill-loading-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

// pi's real formatter, so the fixture cannot drift from what pi emits. Imported
// by filesystem path: the package's `exports` map does not expose this subpath,
// and reaching past it is the point — the test needs the actual generator, not a
// re-declaration of what it is believed to produce.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { formatSkillsForPrompt } = await import(
	join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js")
);

const { defaultSettings } = await import("./config.ts");
const { findSkillsSection, renderSection, unescapeXml } = await import("./parse.ts");
const { modeFor } = await import("./select.ts");
const { stripFrontmatter, loadBodies, renderBodies } = await import("./body.ts");
const { read, write, storePath } = await import("./store.ts");
const { apply, buildRows } = await import("./index.ts");

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures++;
	console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function settingsWith(over: Partial<ReturnType<typeof defaultSettings>>) {
	return { ...defaultSettings(), ...over };
}

// --------------------------------------------------------------------------
// A fixture built the way pi builds it.

const SKILL_DIR = join(ROOT, "skills");
mkdirSync(SKILL_DIR, { recursive: true });

function skillFile(name: string, body: string): string {
	const dir = join(SKILL_DIR, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: does ${name} things\n---\n\n${body}\n`);
	return path;
}

const skills = [
	{ name: "dataviz", description: "charts & <graphs>", filePath: skillFile("dataviz", "# Dataviz\n\nUse a bar chart."), disableModelInvocation: false },
	{ name: "pptx", description: "decks", filePath: skillFile("pptx", "# Pptx\n\nMake slides."), disableModelInvocation: false },
	{ name: "chrome-devtools-mcp:a11y", description: "a11y", filePath: skillFile("a11y", "# A11y"), disableModelInvocation: false },
	{ name: "chrome-devtools-mcp:perf", description: "perf", filePath: skillFile("perf", "# Perf"), disableModelInvocation: false },
];

const BASE = "You are a coding assistant.\n\nBe helpful.";
const PROMPT = BASE + formatSkillsForPrompt(skills as never);
const TAIL = "\n\nAlways be precise.";
const FULL = PROMPT + TAIL;

// ---------------------------------------------------------------------------
console.log("findSkillsSection — reading pi's own output");

const section = findSkillsSection(FULL);
check("the block pi emitted is found", section !== undefined);
eq("every skill is parsed out", section?.entries.length, 4);
eq("names survive", section?.entries[0]?.name, "dataviz");
// pi escapes descriptions on the way in; they have to come back unescaped or a
// rewritten prompt would show the model `&lt;graphs&gt;`.
eq("descriptions are unescaped", section?.entries[0]?.description, "charts & <graphs>");
eq("locations survive", section?.entries[1]?.location, skills[1]!.filePath);
check("the section stops before the rest of the prompt", FULL.slice(section!.end) === TAIL);
// Including the "\n\n" pi joins it on with — they belong to the section, or
// hiding every skill leaves a run of blank lines where it used to be.
check("the section starts at the preamble, not the marker", FULL.slice(section!.start).startsWith("\n\nThe following skills"));
check("and takes the separator with it", FULL.slice(0, section!.start) === BASE);

eq("a prompt with no skills block is left alone", findSkillsSection(BASE), undefined);
eq("an unterminated block is not rewritten", findSkillsSection(`${BASE}\n<available_skills>\n  <skill>`), undefined);
eq("a block with no parsable entries is not rewritten", findSkillsSection(`${BASE}\n<available_skills>\nnonsense\n</available_skills>`), undefined);

eq("ampersands unescape last, so &amp;lt; is not over-decoded", unescapeXml("&amp;lt;"), "&lt;");

// ---------------------------------------------------------------------------
console.log("renderSection — keeping a subset, byte-for-byte");

const all = renderSection(FULL, section!, section!.entries);
eq("keeping everything reproduces pi's own block exactly", all, FULL.slice(section!.start, section!.end));

const two = renderSection(FULL, section!, section!.entries.slice(0, 2));
const reparsed = findSkillsSection(BASE + two + TAIL);
eq("a filtered block still parses", reparsed?.entries.length, 2);
check("and keeps the survivors", reparsed?.entries.map((e) => e.name).join(",") === "dataviz,pptx");
eq("keeping nothing removes the preamble too", renderSection(FULL, section!, []), "");

// ---------------------------------------------------------------------------
console.log("modeFor — exact names, globs, and which wins");

const globbed = settingsWith({
	default: "name",
	skills: { "chrome-devtools-mcp:*": "command", "chrome-devtools-mcp:perf": "preload", "*": "command", pptx: "command" },
});

eq("an exact name beats every glob", modeFor("chrome-devtools-mcp:perf", globbed), "preload");
eq("a family glob covers its members", modeFor("chrome-devtools-mcp:a11y", globbed), "command");
// The member that does not exist yet is the reason globs are supported at all.
eq("...including ones added later", modeFor("chrome-devtools-mcp:brand-new", globbed), "command");
eq("a longer glob beats a shorter one", modeFor("chrome-devtools-mcp:x", settingsWith({ skills: { "*": "preload", "chrome-*": "command" } })), "command");
eq("a bare name still matches", modeFor("pptx", globbed), "command");
eq("catch-all applies to the rest", modeFor("anything-else", globbed), "command");
eq("no pattern falls through to default", modeFor("dataviz", settingsWith({ default: "preload" })), "preload");

// ---------------------------------------------------------------------------
console.log("stripFrontmatter — the fields already in the prompt");

eq("a leading block goes", stripFrontmatter("---\nname: x\n---\n\n# Body\n"), "# Body\n");
eq("no frontmatter is left alone", stripFrontmatter("# Body\n"), "# Body\n");
// A rule further down is content; treating it as a delimiter would eat the file.
eq("a horizontal rule mid-file is not a delimiter", stripFrontmatter("# Body\n\n---\n\nMore\n"), "# Body\n\n---\n\nMore\n");
eq("an unterminated opener means the whole file is body", stripFrontmatter("---\nname: x\n"), "---\nname: x\n");
eq("`---text` on line one is not frontmatter", stripFrontmatter("---text\nbody"), "---text\nbody");

// ---------------------------------------------------------------------------
console.log("loadBodies — budgets, and what happens at the ceiling");

const dataviz = { name: "dataviz", location: skills[0]!.filePath };
const pptx = { name: "pptx", location: skills[1]!.filePath };

const both = loadBodies([dataviz, pptx], { maxCharsPerSkill: 9999, maxChars: 9999 });
eq("both bodies load", both.length, 2);
check("the frontmatter is gone", !both[0]!.text.includes("description:"));
check("the body is there", both[0]!.text.includes("Use a bar chart."));
check("nothing was truncated", both.every((b) => !b.truncated));

const capped = loadBodies([dataviz], { maxCharsPerSkill: 10, maxChars: 9999 });
eq("the per-skill ceiling applies", capped[0]!.text.length, 10);
check("and is reported", capped[0]!.truncated);
check("the reader is told where the rest is", renderBodies(capped).includes(skills[0]!.filePath));

const starved = loadBodies([dataviz, pptx], { maxCharsPerSkill: 9999, maxChars: 12 });
check("the total ceiling stops the second skill", starved.length < 2);

eq("an unreadable file is skipped, not fatal", loadBodies([{ name: "x", location: join(ROOT, "absent.md") }], { maxCharsPerSkill: 99, maxChars: 99 }).length, 0);
eq("nothing preloaded renders nothing", renderBodies([]), "");

// ---------------------------------------------------------------------------
console.log("apply — the whole rewrite");

eq("no configuration leaves the prompt untouched", apply(FULL, defaultSettings()), undefined);
eq("disabled leaves the prompt untouched", apply(FULL, settingsWith({ enabled: false, skills: { pptx: "command" } })), undefined);
eq("a prompt with no block is untouched", apply(BASE, settingsWith({ skills: { pptx: "command" } })), undefined);

const hidden = apply(FULL, settingsWith({ skills: { "chrome-devtools-mcp:*": "command", pptx: "command" } }))!;
check("hiding shortens the prompt", hidden.delta > 0);
check("the hidden skill is gone from the listing", !hidden.prompt.includes("<name>pptx</name>"));
check("the kept skill is still listed", hidden.prompt.includes("<name>dataviz</name>"));
check("the rest of the prompt is intact", hidden.prompt.startsWith(BASE) && hidden.prompt.endsWith(TAIL));
eq("every skill is still accounted for", hidden.decided.length, 4);
eq("with its resolved mode", hidden.decided.find((d) => d.name === "pptx")?.mode, "command");

const everythingHidden = apply(FULL, settingsWith({ default: "command" }))!;
eq("hiding all of them removes the section entirely", everythingHidden.prompt, BASE + TAIL);

const preloaded = apply(FULL, settingsWith({ skills: { dataviz: "preload" } }))!;
check("preloading lengthens the prompt", preloaded.delta < 0);
check("the body is inlined", preloaded.prompt.includes("Use a bar chart."));
check("and the entry is still listed", preloaded.prompt.includes("<name>dataviz</name>"));
check("the model is told not to read it again", preloaded.prompt.includes("without reading their files first"));
check("the rest of the prompt is intact", preloaded.prompt.startsWith(BASE) && preloaded.prompt.endsWith(TAIL));

const brief = apply(FULL, settingsWith({ skills: { pptx: "brief" } }))!;
const briefEntry = /<skill>\s*<name>pptx<\/name>[\s\S]*?<\/skill>/.exec(brief.prompt)?.[0] ?? "";
check("dropping a description shortens the prompt", brief.delta > 0);
check("the skill is still listed", briefEntry.includes("<name>pptx</name>"));
// The path is what makes a name usable — without it the model knows a skill
// exists and has no way to open it.
check("with its path", briefEntry.includes("pptx/SKILL.md"));
check("and without its description", !briefEntry.includes("<description>"));
// Exactly one entry loses one element. A skill nobody configured keeps
// everything pi gave it, which counting the block says better than naming one.
eq(
	"and no other entry loses anything",
	(brief.prompt.match(/<description>/g) ?? []).length,
	(FULL.match(/<description>/g) ?? []).length - 1,
);
check("the rest of the prompt is intact", brief.prompt.startsWith(BASE) && brief.prompt.endsWith(TAIL));
eq("and the mode is reported", brief.decided.find((d) => d.name === "pptx")?.mode, "brief");

// The combination is the point: hide the ones you invoke by hand, inline the one
// you always want, shorten the ones whose names say enough, list the rest.
const mixed = apply(FULL, settingsWith({ skills: { dataviz: "preload", "chrome-devtools-mcp:*": "command" } }))!;
check("a hidden skill is out", !mixed.prompt.includes("<name>chrome-devtools-mcp:a11y</name>"));
check("a preloaded skill is in, with its body", mixed.prompt.includes("Use a bar chart."));
check("a defaulted skill is still just listed", mixed.prompt.includes("<name>pptx</name>") && !mixed.prompt.includes("Make slides."));

// ---------------------------------------------------------------------------
console.log("buildRows — what the picker shows");

const rows = buildRows(skills, FULL, settingsWith({ skills: { pptx: "command" } }));
eq("every loaded skill gets a row", rows.length, 4);
eq("with its resolved mode", rows.find((r) => r.name === "pptx")?.mode, "command");
// Measured from pi's own block, not estimated, so the number beside a skill is
// the number that actually goes away when you hide it.
const pptxRow = rows.find((r) => r.name === "pptx")!;
const hiddenOnly = apply(FULL, settingsWith({ skills: { pptx: "command" } }))!;
eq("and the cost it would save if hidden", pptxRow.chars, hiddenOnly.delta);

// A skill pi loaded but did not list is still reachable as /skill:<name>, so
// leaving it out would make the picker disagree with what you can type.
const withHiddenSkill = buildRows([...skills, { name: "never-listed" }], FULL, defaultSettings());
eq("a skill absent from the block still gets a row", withHiddenSkill.length, 5);
eq("costing nothing", withHiddenSkill.find((r) => r.name === "never-listed")?.chars, 0);

// ---------------------------------------------------------------------------
console.log("store — the machine-local preferences file");

const STORE = join(ROOT, "config", "pi", "skill-loading.json");

eq("respects XDG_CONFIG_HOME", storePath({ XDG_CONFIG_HOME: "/x/cfg" } as never), "/x/cfg/pi/skill-loading.json");
check("falls back to ~/.config", storePath({} as never).endsWith("/.config/pi/skill-loading.json"));
// The whole point of the relocation: not inside this repo, so `git clean`, a
// re-clone, or `git add -A` can neither discard nor publish it.
check("and never lands inside the agent dir", !storePath({} as never).startsWith(AGENT));

eq("a missing store reads as defaults", read(STORE).default, "name");
eq("and is not enabled-off by being missing", read(STORE).enabled, true);

write(settingsWith({ skills: { pptx: "command", dataviz: "preload" } }), STORE);
eq("modes round-trip", read(STORE).skills.pptx, "command");
eq("...both of them", read(STORE).skills.dataviz, "preload");
eq("defaults are not restated in the file", JSON.parse(readFileSync(STORE, "utf8")).maxChars, undefined);
eq("but the version is", JSON.parse(readFileSync(STORE, "utf8")).version, 1);

write(settingsWith({ default: "command", maxChars: 500 }), STORE);
eq("a non-default default is written", read(STORE).default, "command");
eq("and a non-default budget", read(STORE).maxChars, 500);

// Dropped, not defaulted: someone who wrote "hidden" believed they turned it
// off, and silently giving them `name` is the one outcome they did not ask for.
writeFileSync(STORE, JSON.stringify({ version: 1, modes: { pptx: "hidden", dataviz: "command" } }));
eq("an unknown mode is dropped", read(STORE).skills.pptx, undefined);
eq("its neighbours still load", read(STORE).skills.dataviz, "command");

writeFileSync(STORE, JSON.stringify({ version: 1, default: "nonsense", maxChars: -5 }));
eq("an unknown default falls back", read(STORE).default, "name");
eq("a negative budget falls back", read(STORE).maxChars, defaultSettings().maxChars);

writeFileSync(STORE, "{ not json");
eq("an unparseable store does not hide every skill", read(STORE).default, "name");
eq("nor disable the extension", read(STORE).enabled, true);

// Written through a rename, so a crash mid-save cannot leave truncated JSON
// that would read as "no preferences" and silently un-hide everything.
write(settingsWith({ skills: { a: "command" } }), STORE);
eq("no temp file is left behind", readdirSync(dirname(STORE)).filter((f) => f.includes(".tmp")).length, 0);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;

rmSync(ROOT, { recursive: true, force: true });
