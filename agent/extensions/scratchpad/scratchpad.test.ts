/**
 * Tests for the scratchpad extension: the path layout, the session segment's
 * rejection of anything that could escape the root, settings loading, directory
 * creation (including its mode and its failure path), the listing `/scratchpad`
 * prints, and the prompt block's load-bearing claims.
 *
 * Everything runs against temp directories. Nothing here touches the real
 * scratchpad root.
 *
 * Run: pnpm dlx jiti agent/extensions/scratchpad/scratchpad.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "scratchpad-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { CONFIG } = await import("./config.ts");
const { projectSlug, sessionSegment, scratchpadPath, userRoot } = await import("./paths.ts");
const { buildPromptBlock } = await import("./prompt.ts");
const { loadSettings, prepare, list, describeContents } = await import("./index.ts");

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures++;
	console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
console.log("projectSlug — the same slugging the memory store uses");

eq("non-alphanumerics all become dashes", projectSlug("/Users/me/.pi"), "-Users-me--pi");
eq("a dot directory keeps its position", projectSlug("/a/.b"), "-a--b");
eq("underscores are not special here", projectSlug("/a/b_c"), "-a-b-c");

const deep = `/Users/me/${"nested/".repeat(40)}app`;
eq("an over-long slug is capped", projectSlug(deep).length, CONFIG.slugChars);
check("the cap keeps the distinctive tail", projectSlug(deep).endsWith("-app"));
check("a slug at the cap is left alone", projectSlug("/a").length === 2);

// ---------------------------------------------------------------------------
console.log("sessionSegment — one path segment, whatever the session id was");

eq("an ordinary uuid passes through", sessionSegment("019f89f7-1a2b-4c3d"), "019f89f7-1a2b-4c3d");
eq("a slash cannot introduce a directory level", sessionSegment("a/b"), "a-b");
// The one that matters: without this, the scratchpad lands outside its own root.
check("a traversal attempt cannot escape the root", !sessionSegment("../../etc").includes(".."));
eq("a leading run of dashes is trimmed, so the segment is never hidden", sessionSegment("../x"), "x");
check("an empty id falls back to the pid", sessionSegment("") === `pid-${process.pid}`);
check("an undefined id falls back to the pid", sessionSegment(undefined) === `pid-${process.pid}`);
eq("the fallback is stable within a process, so a resume finds its files", sessionSegment(""), sessionSegment(""));

// ---------------------------------------------------------------------------
console.log("scratchpadPath — the four levels, in order");

const path = scratchpadPath({ tmp: "/tmp", uid: 501, cwd: "/Users/me/app", sessionId: "abc123" });
eq("the whole layout", path, "/tmp/pi-501/-Users-me-app/abc123/scratchpad");
eq("the per-user root is the first level", userRoot("/tmp", 501), "/tmp/pi-501");
eq("no uid (Windows) still gets a root of our own", userRoot("/tmp", undefined), "/tmp/pi-user");

const other = scratchpadPath({ tmp: "/tmp", uid: 501, cwd: "/Users/me/app", sessionId: "def456" });
check("two sessions in one project do not collide", path !== other);
eq(
	"two projects in one session do not collide",
	scratchpadPath({ tmp: "/tmp", uid: 501, cwd: "/Users/me/other", sessionId: "abc123" }) === path,
	false,
);
eq(
	"the same session resumed lands in the same place",
	scratchpadPath({ tmp: "/tmp", uid: 501, cwd: "/Users/me/app", sessionId: "abc123" }),
	path,
);

// ---------------------------------------------------------------------------
console.log("loadSettings — defaults, overrides, and a broken file");

eq("no settings file at all leaves the feature on", loadSettings(AGENT).enabled, true);
eq("no settings file means os.tmpdir()", loadSettings(AGENT).root, "");

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { enabled: false, root: "/tmp" } }));
eq("enabled is read", loadSettings(AGENT).enabled, false);
eq("root is read", loadSettings(AGENT).root, "/tmp");

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: "   " } }));
eq("a blank root falls back to the default rather than making an empty segment", loadSettings(AGENT).root, "");

writeFileSync(join(AGENT, "settings.json"), "{ not json");
eq("an unparseable settings file does not disable the scratchpad", loadSettings(AGENT).enabled, true);

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));

// ---------------------------------------------------------------------------
console.log("prepare — creating the directory, and surviving not being able to");

const made = join(ROOT, "made", "deep", "scratchpad");
const result = prepare(made);
check("a nested path is created recursively", "dir" in result && result.dir === made);
check("it is a directory", statSync(made).isDirectory());
// The temp directory is shared with every other user on the machine.
eq("it is created private to this user", statSync(made).mode & 0o777, 0o700);
check("creating it twice is not an error", "dir" in prepare(made));

const blocked = join(ROOT, "a-file");
writeFileSync(blocked, "not a directory");
const failed = prepare(join(blocked, "scratchpad"));
check("an impossible path reports rather than throws", "error" in failed);

// ---------------------------------------------------------------------------
console.log("list / describeContents — what /scratchpad shows");

writeFileSync(join(made, "plan.md"), "1. read the handler");
mkdirSync(join(made, "runs"));
eq("directories are marked, and entries sorted", JSON.stringify(list(made)), JSON.stringify(["plan.md", "runs/"]));
eq("a missing directory lists as empty rather than throwing", list(join(ROOT, "absent")).length, 0);

eq("nothing in it reads as empty", describeContents([]), "  (empty)");
check("entries are indented", describeContents(["a"]) === "  a");
const many = describeContents(Array.from({ length: CONFIG.listLimit + 5 }, (_, at) => `f${at}`));
check("a long listing is capped and says how much it dropped", many.includes("…and 5 more"));
eq("the cap counts the shown entries, not the header", many.split("\n").length, CONFIG.listLimit + 1);

// ---------------------------------------------------------------------------
console.log("buildPromptBlock — the claims the rest of the feature has to make true");

const block = buildPromptBlock("/tmp/pi-501/-a/s/scratchpad");

check("names the actual directory, not a placeholder", block.includes("/tmp/pi-501/-a/s/scratchpad"));
check("states it as a directive, not an offer", block.includes("IMPORTANT: Always use"));
// Each of these is a property the implementation provides, and a model that is
// not told about it behaves as though it were absent.
check("says the directory already exists, saving an mkdir", block.toLowerCase().includes("already exists"));
check("says writes there do not prompt — the half that changes behaviour", block.includes("pre-approved"));
check("says it is session-specific", block.includes("specific to this session"));
check("says it keeps the user's project clean", block.includes("diff"));
check("steers files away from /tmp", block.includes("instead of `/tmp`"));
check("leaves an explicit escape hatch for /tmp", block.includes("Only put temporary files in `/tmp`"));
check("is appended, so it starts by separating itself from what precedes it", block.startsWith("\n\n"));

// ---------------------------------------------------------------------------
console.log("wiring against a fake pi — create, announce, inject");

const extension = (await import("./index.ts")).default;

function makePi() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const announced: Array<[string, unknown]> = [];
	return {
		pi: {
			on: (event: string, h: Function) => handlers.set(event, h),
			registerCommand: (name: string, def: any) => commands.set(name, def),
			events: { emit: (channel: string, data: unknown) => announced.push([channel, data]) },
		},
		handlers,
		commands,
		announced,
	};
}

function makeCtx(cwd: string, sessionId: string) {
	const notices: Array<[string, string]> = [];
	return {
		ctx: {
			cwd,
			hasUI: true,
			ui: { notify: (text: string, level: string) => notices.push([text, level]) },
			sessionManager: { getSessionId: () => sessionId },
		},
		notices,
	};
}

const TMP = join(ROOT, "tmproot");
mkdirSync(TMP, { recursive: true });

{
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: TMP } }));
	const h = makePi();
	extension(h.pi as never);
	check("registers /scratchpad", h.commands.has("scratchpad"));

	const { ctx, notices } = makeCtx("/work/alpha", "sess-1");
	h.handlers.get("session_start")!({}, ctx);

	const expected = join(TMP, `pi-${process.getuid?.() ?? "user"}`, "-work-alpha", "sess-1", "scratchpad");
	check("the directory exists after session start", statSync(expected).isDirectory());
	eq("nothing is said about it at startup", notices.length, 0);

	// The announcement is the whole permission mechanism — a session that creates
	// the directory but does not publish it still prompts for every write.
	eq("announced once", h.announced.length, 1);
	eq("on the channel permissions listens to", h.announced[0]![0], "scratchpad:dir");
	eq("carrying the absolute path", (h.announced[0]![1] as { dir: string }).dir, expected);

	const out = h.handlers.get("before_agent_start")!({ systemPrompt: "BASE PROMPT" });
	check("the block is appended to the system prompt", out?.systemPrompt.startsWith("BASE PROMPT\n\n# Scratchpad Directory"));
	check("naming the directory it just made", out?.systemPrompt.includes(expected));
}

{
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { enabled: false, root: TMP } }));
	const h = makePi();
	extension(h.pi as never);
	const { ctx } = makeCtx("/work/beta", "sess-2");
	h.handlers.get("session_start")!({}, ctx);

	// Announced *with no directory* rather than not announced: that is what takes
	// a previous session's exemption away instead of leaving a dead one allowed.
	eq("disabled still announces, so a stale exemption is cleared", h.announced.length, 1);
	eq("carrying no directory", (h.announced[0]![1] as { dir?: string }).dir, undefined);
	eq("and injects nothing", h.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
}

{
	// A temp root that cannot hold a directory: the session must still start, and
	// the model must not be told to use a directory that is not there.
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: blocked } }));
	const h = makePi();
	extension(h.pi as never);
	const { ctx, notices } = makeCtx("/work/gamma", "sess-3");
	h.handlers.get("session_start")!({}, ctx);

	check("the failure is reported once, as a warning", notices.length === 1 && notices[0]![1] === "warning");
	check("and says what could not be created", notices[0]![0].startsWith("Scratchpad: could not create "));
	eq("it still announces, so a stale exemption is cleared", h.announced.length, 1);
	eq("with no directory", (h.announced[0]?.[1] as { dir?: string } | undefined)?.dir, undefined);
	eq("nothing is injected", h.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;

rmSync(ROOT, { recursive: true, force: true });
