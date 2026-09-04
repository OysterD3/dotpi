/**
 * Tests for the diff panel: the pure helpers, the reader against a real git
 * repository, and the panel rendered and read back.
 *
 * The reader is driven the way the panel drives it — a repository is made,
 * committed, then edited, deleted from, added to and renamed in — because the
 * parsing of git's output is exactly the kind of thing a hand-written fixture
 * would get subtly wrong and a real `git status` cannot.
 *
 * Run with jiti from a directory where pi's packages resolve:
 *     node node_modules/jiti/lib/jiti-cli.mjs agent/extensions/diff-panel/diff-panel.test.ts
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "diff-panel-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir, initTheme, renderDiff } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}
initTheme("dark");
const { theme } = await import("@earendil-works/pi-coding-agent/modes/interactive/theme/theme");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const { countDiff, describe, gutterWidth, parseStatus } = await import("./model.ts");
const { ChangeReader } = await import("./git.ts");
const { DiffPanel, fitPath, packHints, wrapDiffLine } = await import("./panel.ts");
const { CONFIG } = await import("./config.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}

const ESC = "\u001b";
const ANSI = new RegExp("\\u001b\\[[0-9;?]*[A-Za-z]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", "g");
const seen = (line: string) => line.replace(ANSI, "");
const trimmed = (line: string) => seen(line).replace(/\s+$/, "");

/* -------------------------------------------------------------------------- */
console.log("\n--- parseStatus reads git's -z output ---");

check("a modified file", parseStatus(" M a.txt\0"), [{ path: "a.txt", code: " M" }]);
check("an untracked one", parseStatus("?? c.txt\0"), [{ path: "c.txt", code: "??" }]);
check("a staged deletion", parseStatus("D  gone.txt\0"), [{ path: "gone.txt", code: "D " }]);
check("a rename keeps where it came from", parseStatus("R  new.txt\0old.txt\0"), [{ path: "new.txt", code: "R ", from: "old.txt" }]);
check("and does not swallow the entry after it", parseStatus("R  new.txt\0old.txt\0?? c.txt\0"), [
	{ path: "new.txt", code: "R ", from: "old.txt" },
	{ path: "c.txt", code: "??" },
]);
check("a work-tree rename carries its origin too", parseStatus(" R new.txt\0old.txt\0?? c.txt\0"), [
	{ path: "new.txt", code: " R", from: "old.txt" },
	{ path: "c.txt", code: "??" },
]);
check("a path with a space survives", parseStatus(" M a b.txt\0"), [{ path: "a b.txt", code: " M" }]);
check("nothing is nothing", parseStatus(""), []);

/* -------------------------------------------------------------------------- */
console.log("\n--- countDiff and describe ---");

check("counts the signed lines only", countDiff(" 1 one\n-2 two\n+2 2\n 3 three\n     ...\n+4 four"), { added: 2, removed: 1 });

const changed = describe("a.txt", Buffer.from("one\ntwo\nthree\n"), Buffer.from("one\n2\nthree\nfour\n"));
check("a modified file is diffed", [changed.status, changed.added, changed.removed], ["modified", 2, 1]);
check("in pi's display format, numbered", changed.diff?.split("\n"), [" 1 one", "-2 two", "+2 2", " 3 three", "+4 four"]);
const created = describe("c.txt", null, Buffer.from("c1\nc2\n"));
check("a file HEAD lacks is added", [created.status, created.added, created.removed], ["added", 2, 0]);
const gone = describe("b.txt", Buffer.from("b1\nb2\n"), null);
check("a file the tree lacks is deleted", [gone.status, gone.added, gone.removed], ["deleted", 0, 2]);
check("a NUL makes a file binary, and it is not diffed", describe("x", Buffer.from("a\0b"), Buffer.from("a")).note, "binary");
check("a file over the cap is not diffed either", describe("x", Buffer.alloc(CONFIG.maxFileBytes + 1, 97), Buffer.from("a")).note, "too large");
check("same text, no diff", describe("x", Buffer.from("a\n"), Buffer.from("a\n")).note, "no text change");
check("CRLF is not a change in every line", describe("x", Buffer.from("a\r\nb\r\n"), Buffer.from("a\nb\n")).note, "no text change");
check("a lone CR never reaches a row", describe("x", Buffer.from("a\r\r\nb\r"), Buffer.from("a\r\r\nc\r")).diff?.includes("\r"), false);
check("gone from the tree is deleted, whatever HEAD has", describe("x", null, null).status, "deleted");
check("the gutter is sign, number, space", gutterWidth("  1 one\n-12 two\n+12 2"), 4);
check("no numbers, no gutter", gutterWidth(""), 0);

/* -------------------------------------------------------------------------- */
console.log("\n--- wrapping a painted diff line ---");

const long = renderDiff(`+12 ${"word ".repeat(12).trim()}`);
const pieces = wrapDiffLine(long, 30, 4);
check("a short line is itself", wrapDiffLine("+1 hi", 30, 3), ["+1 hi"]);
check("a long one wraps", pieces.length > 1, true);
check("no piece is wider than asked", pieces.every((piece) => visibleWidth(piece) <= 30), true);
check("continuations hang under the text", pieces.slice(1).every((piece) => seen(piece).startsWith("    ") && !seen(piece).startsWith("     ")), true);
check(
	"and nothing is lost",
	pieces.map((piece) => seen(piece).trim()).join(" "),
	`+12 ${"word ".repeat(12).trim()}`,
);
check("the colour carries over the break", pieces.slice(1).every((piece) => piece.includes(`${ESC}[`)), true);
check("a path is cut from the front", fitPath("src/components/Header.tsx", 12), "…/Header.tsx");
check("or left alone when it fits", fitPath("a.txt", 12), "a.txt");
const wide = "src/コンポーネント/ヘッダー/index.tsx";
check("a wide-character path is cut by column, not by character", visibleWidth(fitPath(wide, 20)) <= 20 && fitPath(wide, 20).endsWith("index.tsx"), true);
check("and fills the room it has", visibleWidth(fitPath(wide, 30)) >= 28, true);
check("a one-column room is the ellipsis", fitPath(wide, 1), "…");

/* -------------------------------------------------------------------------- */
console.log("\n--- the reader, on a real repository ---");

const REPO = join(ROOT, "repo");
mkdirSync(REPO);
const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
		cwd: REPO,
		stdio: ["ignore", "pipe", "ignore"],
	});
git("init", "-q");
writeFileSync(join(REPO, "a.txt"), "one\ntwo\nthree\n");
writeFileSync(join(REPO, "b.txt"), "b1\nb2\n");
writeFileSync(join(REPO, "e.txt"), "moved\n");
writeFileSync(join(REPO, "bin.dat"), Buffer.from([1, 0, 2, 3]));
git("add", ".");
git("commit", "-q", "-m", "base");

const reader = new ChangeReader(REPO);
check("a clean tree has no changes", (await reader.read()) as unknown, { kind: "changes", set: { files: [], added: 0, removed: 0 } });

writeFileSync(join(REPO, "a.txt"), "one\n2\nthree\nfour\n");
rmSync(join(REPO, "b.txt"));
writeFileSync(join(REPO, "c.txt"), "c1\n");
mkdirSync(join(REPO, "dir"));
writeFileSync(join(REPO, "dir", "d.txt"), "d1\nd2\n");
writeFileSync(join(REPO, "bin.dat"), Buffer.from([1, 0, 2, 3, 4]));
git("mv", "e.txt", "moved.txt");
// Staged as new, then deleted from the tree: in neither HEAD nor the tree.
writeFileSync(join(REPO, "ad.txt"), "gone\n");
git("add", "ad.txt");
rmSync(join(REPO, "ad.txt"));
// Staged as new, then changed again: an addition, described from the tree.
writeFileSync(join(REPO, "am.txt"), "first\n");
git("add", "am.txt");
writeFileSync(join(REPO, "am.txt"), "first\nsecond\n");
// A dangling symlink: git lists it, the tree has nothing to read.
symlinkSync(join(REPO, "nowhere"), join(REPO, "dangling"));
// Present but unreadable: still listed, with the reason.
writeFileSync(join(REPO, "locked.txt"), "secret\n");
chmodSync(join(REPO, "locked.txt"), 0o000);
const canLock = process.getuid?.() !== 0;

const first = await reader.read();
if (first.kind !== "changes") throw new Error(`expected changes, got ${first.kind}`);
const byPath = new Map(first.set.files.map((file) => [file.path, file]));
check("every kind of change is listed", [...byPath.keys()].sort(), ["a.txt", "am.txt", "b.txt", "bin.dat", "c.txt", "dir/d.txt", "locked.txt", "moved.txt"]);
check("staged then changed again is an addition of what is on disk", [byPath.get("am.txt")?.status, byPath.get("am.txt")?.added], ["added", 2]);
check("a dangling symlink is not listed", byPath.has("dangling"), false);
check("an unreadable file is listed with its reason", canLock ? byPath.get("locked.txt")?.note : "unreadable", "unreadable");
check("the edit is a diff against HEAD", [byPath.get("a.txt")?.status, byPath.get("a.txt")?.added, byPath.get("a.txt")?.removed], ["modified", 2, 1]);
check("the deletion is all minus", [byPath.get("b.txt")?.status, byPath.get("b.txt")?.removed], ["deleted", 2]);
check("an untracked file is all plus", [byPath.get("c.txt")?.status, byPath.get("c.txt")?.added], ["added", 1]);
check("nested untracked files are files, not a directory", byPath.get("dir/d.txt")?.added, 2);
check("the binary is named, not diffed", [byPath.get("bin.dat")?.note, byPath.get("bin.dat")?.diff], ["binary", undefined]);
check("a rename is diffed against what it came from", byPath.get("moved.txt")?.note, "no text change");
check("a file in neither HEAD nor the tree is not listed", byPath.has("ad.txt"), false);
check("the totals add up", [first.set.added, first.set.removed], [7, 3]);
check("untracked files come after tracked ones, as git lists them", first.set.files.at(-1)?.path, "locked.txt");

const second = await reader.read();
check("an unchanged tree hands back the same set object", second.kind === "changes" && second.set === first.set, true);

writeFileSync(join(REPO, "a.txt"), "one\n2\nthree\nfour\nfive\n");
const third = await reader.read();
check("a further edit is a new set", third.kind === "changes" && third.set !== first.set, true);
check("with the file re-described", third.kind === "changes" ? third.set.files.find((f) => f.path === "a.txt")?.added : undefined, 3);
check("a tool's path becomes git's path", reader.toRepoPath(join(REPO, "dir", "d.txt")), "dir/d.txt");
check("relative to the cwd too", reader.toRepoPath("a.txt"), "a.txt");
check("a name that merely starts with two dots is inside", reader.toRepoPath("..hidden"), "..hidden");
check("the root itself is nothing to follow", reader.toRepoPath("."), undefined);
check("a file gone with its directory still resolves through what is left", reader.toRepoPath(join(REPO, "nodir", "x.txt")), "nodir/x.txt");

// git cannot stage what it cannot read; the lock was only for the reader.
chmodSync(join(REPO, "locked.txt"), 0o644);

// A rename re-pointed at another source, the file itself untouched: the
// description must not come back from the cache keyed on the file alone.
git("add", "-A");
git("commit", "-q", "-m", "renames");
writeFileSync(join(REPO, "old1.txt"), "alpha\nbeta\ngamma\n");
writeFileSync(join(REPO, "old2.txt"), "alpha\nbeta\ndelta\n");
git("add", "old1.txt", "old2.txt");
git("commit", "-q", "-m", "two sources");
git("mv", "old1.txt", "new.txt");
const fromOld1 = await reader.read();
check("a rename from one source", fromOld1.kind === "changes" ? fromOld1.set.files.find((f) => f.path === "new.txt")?.note : undefined, "no text change");
git("reset", "-q", "--", "old1.txt", "new.txt");
git("rm", "-q", "--cached", "old2.txt");
git("add", "new.txt");
const fromOld2 = await reader.read();
check("re-pointed at another, the diff is against the other", fromOld2.kind === "changes" ? fromOld2.set.files.find((f) => f.path === "new.txt")?.removed : undefined, 1);
check("and a path outside the repo is nothing", reader.toRepoPath(join(ROOT, "elsewhere.txt")), undefined);

git("add", "-A");
git("commit", "-q", "-m", "all of it");
const committed = await reader.read();
check("committing empties the panel", committed.kind === "changes" ? committed.set.files.length : -1, 0);

// git not answering — killed, timed out — is not a "no", and is cached as
// nothing. A fake git on PATH dies on `show` and defers everything else.
{
	const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const bin = join(ROOT, "fakebin");
	mkdirSync(bin);
	writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = "show" ]; then kill -TERM $$; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
	writeFileSync(join(REPO, "a.txt"), "changed again\n");
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	const fresh = new ChangeReader(REPO);
	const dead = await fresh.read();
	process.env.PATH = path;
	check("a git that dies mid-read is a non-answer, not an empty HEAD", dead.kind, "unavailable");
	const alive = await fresh.read();
	check("and the next read, with git back, diffs against HEAD as it should", alive.kind === "changes" ? alive.set.files.find((f) => f.path === "a.txt")?.status : undefined, "modified");
}

const outside = mkdtempSync(join(tmpdir(), "diff-panel-norepo-"));
check("outside a repository there is nothing to compare against", await new ChangeReader(outside).read(), { kind: "no-repo" });

/* -------------------------------------------------------------------------- */
console.log("\n--- the panel, rendered and read back ---");

let unfocused = 0;
let closed = 0;
const host = { requestRender() {}, rows: () => 20, unfocus: () => void unfocused++, close: () => void closed++ };
const WIDTH = 40;
// rows 20 less the reserve: title, body, rule and the hint rows share it.
const HEIGHT = 20 - CONFIG.bottomReserve;

check("hints pack into lines no wider than asked", packHints(["q close", "esc back", "↑↓ scroll"], 20), ["q close  ·  esc back", "↑↓ scroll"]);
check("or one line when they fit", packHints(["a", "b"], 20), ["a  ·  b"]);

const panel = new DiffPanel(host, theme);
const loading = panel.render(WIDTH);
check("before the first read it says so", seen(loading[0] ?? "").includes("Reading the working tree"), true);
check("and is already full height", loading.length, HEIGHT);
check("every line is exactly as wide as the panel", [...new Set(loading.map((line) => visibleWidth(line)))], [WIDTH]);
check("no line holds a newline", loading.some((line) => line.includes("\n")), false);

panel.update({ kind: "no-repo" }, undefined);
check("no repository is a sentence, not an empty list", seen(panel.render(WIDTH)[0] ?? "").includes("Not a git repository"), true);

panel.update({ kind: "changes", set: { files: [], added: 0, removed: 0 } }, undefined);
check("a clean tree says so", seen(panel.render(WIDTH)[0] ?? "").includes("No uncommitted changes"), true);

panel.update(first, undefined);
const lines = panel.render(WIDTH);
const text = lines.map(seen);
check("the title counts files and lines", trimmed(lines[0] ?? "").startsWith("│ 8 files changed  +7 -3"), true);
check("and says where you are when there is more", / \d+–\d+ of \d+$/.test(trimmed(lines[0] ?? "")), true);
check("the panel is still full height", lines.length, HEIGHT);
check("the list opens the body", trimmed(lines[1] ?? "").startsWith("│ a.txt"), true);
check("with the counts flush right", trimmed(lines[1] ?? "").endsWith("+2 -1"), true);
check("a binary file names its reason", text.some((line) => /bin\.dat\s+binary$/.test(line.trimEnd())), true);
check("the hints are the following set", seen(lines.at(-1) ?? "").includes("shift+→ drive"), true);
check("every line is still exactly as wide", [...new Set(lines.map((line) => visibleWidth(line)))], [WIDTH]);

// Following: the last-touched file's section comes to the top.
panel.update(first, "c.txt");
const following = panel.render(WIDTH).map(seen);
check("the followed file's section leads the body", following[1]?.startsWith("│ ── c.txt "), true);
check("with its diff under it", following[2]?.includes("+1 c1"), true);
panel.update(first, "bin.dat");
check("a file with no diff cannot be followed to, so the top it is", panel.render(WIDTH).map(seen)[1]?.startsWith("│ a.txt"), true);
panel.update(first, "c.txt");

// Driving: the keys move the view, and the follow waits.
panel.focused = true;
const driving = panel.render(WIDTH);
check("focused, the hints change", driving.slice(-2).map(seen).join(" ").includes("esc back"), true);
check("and the panel keeps its height whatever the hints need", driving.length, HEIGHT);
panel.handleInput("g");
check("g goes to the top", panel.render(WIDTH).map(seen)[1]?.startsWith("│ a.txt"), true);
panel.handleInput("j");
check("j is one line down", panel.render(WIDTH).map(seen)[1]?.startsWith("│ am.txt"), true);
panel.handleInput("\t");
check("tab jumps to the next section", panel.render(WIDTH).map(seen)[1]?.startsWith("│ ── a.txt "), true);
panel.handleInput("\t");
check("and the next", panel.render(WIDTH).map(seen)[1]?.startsWith("│ ── am.txt "), true);
panel.handleInput("p");
check("p comes back", panel.render(WIDTH).map(seen)[1]?.startsWith("│ ── a.txt "), true);
panel.handleInput("G");
const bottom = panel.render(WIDTH).map(seen);
check("G reaches the end", bottom.some((line) => line.includes("+2 d2")), true);
panel.handleInput(ESC);
check("esc hands the keyboard back", unfocused, 1);
panel.focused = false;
check("and unfocused, the follow is back", panel.render(WIDTH).map(seen)[1]?.startsWith("│ ── c.txt "), true);
panel.focused = true;
panel.handleInput("q");
check("q closes", closed, 1);
panel.handleInput(`${ESC}[1;2C`);
check("so does the key that opened it", closed, 2);

// A miss keeps what was there.
panel.update({ kind: "unavailable" }, undefined);
check("git not answering keeps the last set on screen", trimmed(panel.render(WIDTH)[0] ?? "").startsWith("│ 8 files changed  +7 -3"), true);

// Narrow.
const narrow = panel.render(12);
check("a narrow panel is still exactly its width", [...new Set(narrow.map((line) => visibleWidth(line)))], [12]);

/* -------------------------------------------------------------------------- */
console.log("\n--- the wiring, driven through pi's API ---");

{
	// index.ts is registrations and a lifecycle; what can go wrong in it is a
	// name — the event, the option, the method on the handle — so it is driven
	// with the shapes pi hands it and nothing more.
	const { default: install } = await import("./index.ts");
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
	const shortcuts = new Map<string, (ctx: unknown) => Promise<void> | void>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const channels = new Map<string, Array<(data: unknown) => void>>();
	install({
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => void commands.set(name, options.handler),
		registerShortcut: (key: string, options: { handler: (ctx: unknown) => Promise<void> | void }) => void shortcuts.set(key, options.handler),
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void handlers.get(event)?.push(handler) ?? handlers.set(event, [handler]),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				(channels.get(channel) ?? channels.set(channel, []).get(channel)!).push(handler);
				return () => void channels.get(channel)?.splice(channels.get(channel)!.indexOf(handler), 1);
			},
		},
	} as never);
	check("it registers /diff", commands.has("diff"), true);
	check("and the key in config", shortcuts.has(CONFIG.key), true);
	check("and listens for tools finishing", ["tool_execution_start", "tool_execution_end", "turn_end", "session_shutdown"].every((name) => handlers.has(name)), true);

	// A ctx as pi builds it, with a custom() that mounts the component the way
	// interactive mode does: factory, then the handle, resolving on done().
	let mounted: { render(width: number): string[]; focused: boolean } | undefined;
	let hidden: boolean | undefined;
	let focusCalls = 0;
	let resolved = false;
	const handle = { hide() {}, setHidden: (value: boolean) => void (hidden = value), isHidden: () => hidden === true, focus: () => void focusCalls++, unfocus() {}, isFocused: () => false };
	const notices: string[] = [];
	const ctx = {
		mode: "tui",
		cwd: REPO,
		ui: {
			notify: (message: string) => void notices.push(message),
			custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => unknown, options: { overlay?: boolean; overlayOptions?: { nonCapturing?: boolean }; onHandle?: (handle: unknown) => void }) => {
				check("it mounts as an overlay", options.overlay, true);
				check("that does not take the keyboard", options.overlayOptions?.nonCapturing, true);
				await new Promise<void>((finish) => {
					mounted = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, () => {
						resolved = true;
						finish();
					}) as typeof mounted;
					options.onHandle?.(handle);
				});
			},
		},
	};

	// Something to show: the committed repo gets one more change.
	writeFileSync(join(REPO, "a.txt"), "one\n2\nthree\nfour\nfive\nsix\n");
	const opening = shortcuts.get(CONFIG.key)!(ctx);
	await new Promise((tick) => setTimeout(tick, 300));
	check("the shortcut opens the panel", mounted !== undefined, true);
	check("and the first read has landed", mounted?.render(60).map(seen)[0]?.includes("1 file changed"), true);

	await shortcuts.get(CONFIG.key)!(ctx);
	check("pressed again, it hands the panel the keyboard", focusCalls, 1);
	channels.get("ask-user:asking")?.forEach((handler) => handler({ active: true }));
	check("a question hides it", hidden, true);
	channels.get("ask-user:asking")?.forEach((handler) => handler({ active: false }));
	check("and its answer brings it back", hidden, false);

	// An edit names the file to follow; a finished tool schedules a read.
	writeFileSync(join(REPO, "c.txt"), "c1\nc2\nc3\n");
	for (const handler of handlers.get("tool_execution_start") ?? []) handler({ type: "tool_execution_start", toolName: "edit", args: { path: join(REPO, "c.txt") } }, ctx);
	for (const handler of handlers.get("tool_execution_end") ?? []) handler({ type: "tool_execution_end", toolName: "edit" }, ctx);
	await new Promise((tick) => setTimeout(tick, CONFIG.settleMs + 300));
	const followed = mounted?.render(60).map(seen) ?? [];
	check("the next read sees the new file", followed[0]?.includes("2 files changed"), true);
	check("and follows it", followed[1]?.startsWith("│ ── c.txt "), true);

	await commands.get("diff")!("", ctx);
	await opening;
	check("/diff closes it, and the custom() promise settles", resolved, true);
	check("a second /diff opens it again", (() => { void commands.get("diff")!("", ctx); return true; })(), true);
	await new Promise((tick) => setTimeout(tick, 50));
	// pi runs the factory again for the next session and hides overlays
	// itself, so the shutdown of THIS session is the one signal to close on.
	for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "new" }, ctx);
	await new Promise((tick) => setTimeout(tick, 50));
	check("and the session's shutdown closes it", mounted !== undefined && resolved, true);
	check("nothing was notified along the way", notices, []);
}

rmSync(ROOT, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
