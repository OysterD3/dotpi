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

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const { expandRoot, projectSlug, sessionSegment, scratchpadPath, scratchpadUnder, userRoot } = await import("./paths.ts");
const { buildPromptBlock, buildToolGuidance } = await import("./prompt.ts");
const { loadSettings, prepare, prepareRoot, list, describeContents } = await import("./index.ts");

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
eq(
	"no uid (Windows) still gets a per-user root of our own",
	scratchpadPath({ tmp: "/tmp", uid: undefined, cwd: "/a", sessionId: "s" }),
	"/tmp/pi-user/-a/s/scratchpad",
);

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
console.log("expandRoot — a configured root, made absolute");

eq("an absolute root is left alone", expandRoot("/tmp"), "/tmp");
// A literal `~` directory next to wherever pi was started is the visible half of
// getting this wrong.
eq("a bare tilde becomes the home directory", expandRoot("~"), homedir());
eq("a tilde path is expanded, not treated as a directory name", expandRoot("~/scratch"), join(homedir(), "scratch"));
check("surrounding whitespace does not become a path segment", !expandRoot("  /tmp  ")!.includes(" "));

// The one that matters: `resolve("scratch")` would resolve against the process
// cwd — the project — putting the pre-approved no-prompt directory inside the
// user's repo while the system prompt promised it was outside it.
eq("a relative root is refused, not resolved against the project", expandRoot("scratch"), undefined);
eq("...including the one that names the project itself", expandRoot("."), undefined);
eq("...and one that climbs out of it", expandRoot("../scratch"), undefined);

// ---------------------------------------------------------------------------
console.log("loadSettings — defaults, overrides, and a broken file");

eq("no settings file at all leaves the feature on", loadSettings(AGENT).enabled, true);
eq("no settings file means os.tmpdir()", loadSettings(AGENT).root, "");

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { enabled: false, root: "/tmp" } }));
eq("enabled is read", loadSettings(AGENT).enabled, false);
eq("root is read", loadSettings(AGENT).root, "/tmp");

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: "   " } }));
eq("a blank root falls back to the default rather than making an empty segment", loadSettings(AGENT).root, "");

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: "~/scratch" } }));
eq("the root is kept as written, so session_start can warn about a bad one", loadSettings(AGENT).root, "~/scratch");

writeFileSync(join(AGENT, "settings.json"), "{ not json");
eq("an unparseable settings file does not disable the scratchpad", loadSettings(AGENT).enabled, true);

writeFileSync(join(AGENT, "settings.json"), JSON.stringify({}));

// ---------------------------------------------------------------------------
console.log("prepare — creating the directory, and surviving not being able to");

const made = join(ROOT, "made", "deep", "scratchpad");
eq("a nested path is created recursively, with nothing to report", prepare(made), undefined);
check("it is a directory", statSync(made).isDirectory());
// The temp directory is shared with every other user on the machine.
eq("it is created private to this user", statSync(made).mode & 0o777, 0o700);
eq("creating it twice is not an error", prepare(made), undefined);

const blocked = join(ROOT, "a-file");
writeFileSync(blocked, "not a directory");
check("an impossible path reports the reason rather than throwing", typeof prepare(join(blocked, "scratchpad")) === "string");

// ---------------------------------------------------------------------------
console.log("prepareRoot — refusing a root that is not ours");

const goodRoot = join(ROOT, "root-ok", "pi-501");
eq("a fresh root is accepted", prepareRoot(goodRoot), undefined);
eq("and created private to this user", statSync(goodRoot).mode & 0o777, 0o700);
eq("re-verifying an existing good root is fine", prepareRoot(goodRoot), undefined);

// The attack the check exists for: another local user pre-creates the
// predictable `pi-<uid>` segment as a symlink into a directory they own, and
// mkdirSync(recursive) would follow it and put every scratch file there.
const elsewhere = join(ROOT, "attacker-owned");
mkdirSync(elsewhere, { recursive: true });
const symlinked = join(ROOT, "root-link", "pi-501");
mkdirSync(join(ROOT, "root-link"), { recursive: true });
symlinkSync(elsewhere, symlinked);
check("a symlinked root is refused rather than followed", prepareRoot(symlinked)?.includes("symlink") === true);
eq("and nothing was created through it", readdirSync(elsewhere).length, 0);

const fileRoot = join(ROOT, "root-file", "pi-501");
mkdirSync(join(ROOT, "root-file"), { recursive: true });
writeFileSync(fileRoot, "not a directory");
check("a file where the root should be is refused", typeof prepareRoot(fileRoot) === "string");

// mkdirSync only applies its mode to directories it creates, so a root that
// already existed — the interesting case — keeps whatever mode it had.
const looseRoot = join(ROOT, "root-loose", "pi-501");
mkdirSync(looseRoot, { recursive: true, mode: 0o755 });
chmodSync(looseRoot, 0o755);
check(
	"a pre-existing world-readable root is refused",
	process.getuid === undefined || prepareRoot(looseRoot)?.includes("other users") === true,
);

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
console.log("buildPromptBlock — what every request pays for, and must therefore earn");

const block = buildPromptBlock("/tmp/pi-501/-a/s/scratchpad");

check("names the actual directory, not a placeholder", block.includes("/tmp/pi-501/-a/s/scratchpad"));
check("states it as a directive, not an offer", block.includes("IMPORTANT: Always use"));
// These three are the claims a model acts on WITHOUT having asked for anything,
// so they are the ones worth carrying on every request. The rest moved to the
// tool, where they are paid for only when fetched.
check("says the directory already exists, saving an mkdir", block.toLowerCase().includes("already exists"));
check("says writes there do not prompt — the half that changes behaviour", block.includes("pre-approved"));
check("steers files away from /tmp", block.includes("instead of `/tmp`"));
check("points at the tool for everything it no longer carries", block.includes("`scratchpad` tool"));
check("is appended, so it starts by separating itself from what precedes it", block.startsWith("\n\n"));

// The whole point of the split. A block that drifts back to the old length is
// paying the old per-request cost again, and nothing else would notice.
check("stays short — it is on every request of the session", block.length < 380);
check("is much shorter than the guidance it replaced", block.length * 2 < buildToolGuidance("/x").length + block.length);

// ---------------------------------------------------------------------------
console.log("buildToolGuidance — the claims that moved, which must survive the move");

const guidance = buildToolGuidance("/tmp/pi-501/-a/s/scratchpad");

check("repeats the path, so the result stands alone in the transcript", guidance.includes("/tmp/pi-501/-a/s/scratchpad"));
check("says the directory already exists, saving an mkdir", guidance.toLowerCase().includes("already exists"));
check("says writes there do not prompt", guidance.includes("pre-approved"));
check("says it is session-specific", guidance.includes("specific to this session"));
check("says it keeps the user's project clean", guidance.includes("diff"));
check("leaves an explicit escape hatch for /tmp", guidance.includes("Only put temporary files in `/tmp`"));
check("lists the concrete cases, which is what made the long version work", guidance.includes("- Storing intermediate results"));

// ---------------------------------------------------------------------------
console.log("wiring against a fake pi — create, announce, inject");

const extension = (await import("./index.ts")).default;

function makePi() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const announced: Array<[string, unknown]> = [];
	const tools = new Map<string, any>();
	return {
		pi: {
			on: (event: string, h: Function) => handlers.set(event, h),
			registerCommand: (name: string, def: any) => commands.set(name, def),
			registerTool: (def: any) => tools.set(def.name, def),
			events: { emit: (channel: string, data: unknown) => announced.push([channel, data]) },
		},
		handlers,
		commands,
		tools,
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
	// The path reaches the model through the system prompt and the tool; there is
	// no slash command, so nothing here is driven by hand.
	eq("registers no slash command", h.commands.size, 0);

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

	// The tool half: the request carries the path, this carries the rest.
	check("registers the scratchpad tool", h.tools.has("scratchpad"));
	const tool = h.tools.get("scratchpad")!;

	const path = await tool.execute("call-1", {});
	check("defaults to the guidance", path.content[0].text.includes("Use this directory for ALL temporary file needs"));
	check("naming the real directory", path.content[0].text.includes(expected));

	writeFileSync(join(expected, "notes.md"), "x");
	const listed = await tool.execute("call-2", { action: "list" });
	check("list reports what is actually in it", listed.content[0].text.includes("notes.md"));
	eq("and counts it", listed.details.count, 1);
	check("list does not re-send the guidance", !listed.content[0].text.includes("Use this directory for ALL"));

	// dir is read at call time, not captured: a /new that removes the scratchpad
	// must not leave the tool handing out the old path.
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { enabled: false, root: TMP } }));
	h.handlers.get("session_start")!({}, makeCtx("/work/alpha", "sess-1b").ctx);
	const gone = await tool.execute("call-3", {});
	check("after a session turns it off, the tool says so instead of naming a dead path", gone.content[0].text.startsWith("No scratchpad"));
	eq("and reports no directory", gone.details.dir, null);
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: TMP } }));
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
	check("and says which root it would not use", notices[0]![0].startsWith("Scratchpad: refusing to use "));
	eq("it still announces, so a stale exemption is cleared", h.announced.length, 1);
	eq("with no directory", (h.announced[0]?.[1] as { dir?: string } | undefined)?.dir, undefined);
	eq("nothing is injected", h.handlers.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
}

{
	// A relative root is refused rather than silently resolved into the project.
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: "scratch" } }));
	const h = makePi();
	extension(h.pi as never);
	const { ctx, notices } = makeCtx("/work/delta", "sess-4");
	h.handlers.get("session_start")!({}, ctx);

	check("the bad setting is named, as a warning", notices[0]?.[1] === "warning" && notices[0][0].includes('scratchpad.root "scratch"'));
	check("and the default root is used instead of failing outright", h.announced[0]![1] !== undefined);
	const announced = (h.announced[0]![1] as { dir?: string }).dir;
	check("the scratchpad still lands under the system temp directory", announced?.startsWith(tmpdir()) === true);
	check("and nowhere near the project", !announced?.includes("/work/delta"));
}

{
	// A fork keeps the conversation, so it must keep the files the conversation
	// refers to — a new session id would otherwise swap in an empty directory.
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ scratchpad: { root: TMP } }));
	const first = makePi();
	extension(first.pi as never);
	first.handlers.get("session_start")!({}, makeCtx("/work/epsilon", "sess-old").ctx);
	const original = (first.announced[0]![1] as { dir: string }).dir;
	writeFileSync(join(original, "analysis.json"), "{}");

	const forked = makePi();
	extension(forked.pi as never);
	forked.handlers.get("session_start")!(
		{ reason: "fork", previousSessionFile: "/sessions/2026-08-07T10-00-00_sess-old.jsonl" },
		makeCtx("/work/epsilon", "sess-new").ctx,
	);

	eq("a fork inherits the directory its context already names", (forked.announced[0]![1] as { dir: string }).dir, original);
	check("so the file it believes it wrote is still there", list(original).includes("analysis.json"));

	// An unrelated previous session is not inherited — /new must start clean.
	const fresh = makePi();
	extension(fresh.pi as never);
	fresh.handlers.get("session_start")!(
		{ reason: "new", previousSessionFile: "/sessions/2026-08-07T10-00-00_sess-unrelated.jsonl" },
		makeCtx("/work/epsilon", "sess-third").ctx,
	);
	check("a session with no scratchpad to inherit gets its own", (fresh.announced[0]![1] as { dir: string }).dir !== original);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;

rmSync(ROOT, { recursive: true, force: true });
