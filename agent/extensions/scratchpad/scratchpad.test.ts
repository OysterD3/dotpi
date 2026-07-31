/**
 * Tests for the scratchpad's pure and filesystem parts.
 *
 *     pnpm dlx jiti agent/extensions/scratchpad/scratchpad.test.ts
 *
 * The interesting cases are the ones where a mistake reaches outside the
 * scratchpad: slugs that could traverse, pruning that could delete the wrong
 * thing, and a root that another user on the machine could read.
 */

import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { clear, ensure, list, prune, projectDir, rootFor, sessionDir, slug } from "./store.ts";
import { scratchpadPrompt } from "./prompt.ts";
import { DEFAULTS, loadSettings } from "./settings.ts";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures++;
	console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
console.log("\nslug — one path segment, never a traversal");

eq("separators become dashes", slug("/Users/dev/proj"), "Users-dev-proj");
check("no separator survives", !slug("/a/b/c").includes(sep));
check("a slug never starts with a dash", !slug("///x").startsWith("-"));
eq("an empty path still yields a name", slug("/"), "root");
eq("and so does one made only of junk", slug("???"), "root");
check("long paths are bounded", slug("/x".repeat(500)).length <= 120);

// Dots survive the character filter — they have to, or every `.config` becomes
// unreadable — which makes a name of ONLY dots the one dangerous survivor.
eq("`..` is not allowed through", slug(".."), "root");
eq("nor `.`", slug("."), "root");
eq("nor any run of them", slug("...."), "root");
eq("but a real dotted name is kept", slug(".config"), ".config");

// The property that actually matters: whatever goes in, joining stays inside.
for (const hostile of ["..", ".", "../..", "/etc/passwd", "..\\..\\windows", "a/../../b", "\0evil", "-", "--"]) {
	const joined = join("/root", slug(hostile));
	check(`"${hostile}" cannot escape`, joined.startsWith(`/root${sep}`), joined);
}

// ---------------------------------------------------------------------------
console.log("layout — per user, per project, per session");

const fakeRoot = "/tmp/pi-scratchpad-501";
check("the project sits under the root", projectDir(fakeRoot, "/w/a").startsWith(fakeRoot + sep));
check("the session sits under the project", sessionDir(fakeRoot, "/w/a", "s1").startsWith(projectDir(fakeRoot, "/w/a") + sep));
check(
	"two projects do not collide",
	projectDir(fakeRoot, "/w/a") !== projectDir(fakeRoot, "/w/b"),
);
check(
	"two sessions in one project do not collide",
	sessionDir(fakeRoot, "/w/a", "s1") !== sessionDir(fakeRoot, "/w/a", "s2"),
);
check("an override root is honoured", rootFor("/custom/place") === "/custom/place");
check("the default root is under the temp dir", rootFor().startsWith(tmpdir()));
check("and is per-user", /-(\d+|[A-Za-z].*)$/.test(rootFor()), rootFor());

// ---------------------------------------------------------------------------
console.log("ensure — creates it, and keeps the root private");

{
	const base = mkdtempSync(join(tmpdir(), "pi-scratch-test-"));
	const root = join(base, "root");
	const dir = ensure(root, "/w/proj", "session-1");

	check("a directory comes back", dir !== undefined);
	check("and it exists", dir !== undefined && existsSync(dir));
	check("under the root", dir !== undefined && dir.startsWith(root + sep));

	// The reason the root exists at all: /tmp is shared, so it must not be
	// readable by other accounts on the machine.
	if (process.platform !== "win32") {
		const mode = statSync(root).mode & 0o777;
		eq("the root is private to this user", mode, 0o700);
	}

	// Idempotent — a second session in the same project reuses the project dir.
	const second = ensure(root, "/w/proj", "session-2");
	check("a second session gets its own directory", second !== dir);
	check("in the same project directory", second !== undefined && second.startsWith(projectDir(root, "/w/proj") + sep));

	// A root that cannot be created is not fatal.
	eq("an impossible root yields no scratchpad", ensure("/proc/nonexistent-xyz/root", "/w", "s"), undefined);
}

// ---------------------------------------------------------------------------
console.log("list and clear");

{
	const base = mkdtempSync(join(tmpdir(), "pi-scratch-test-"));
	const dir = ensure(join(base, "root"), "/w/proj", "s")!;
	writeFileSync(join(dir, "small.txt"), "x");
	writeFileSync(join(dir, "big.txt"), "x".repeat(5000));
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "nested.txt"), "y");

	const entries = list(dir);
	eq("every entry is listed", entries.length, 3);
	eq("largest first", entries[0]?.name, "big.txt");
	check("directories are marked", entries.some((entry) => entry.name === "sub/"));

	const removed = clear(dir);
	eq("everything is removed", removed, 3);
	eq("including the nested directory", list(dir).length, 0);
	// The path the system prompt named must survive being emptied.
	check("but the scratchpad itself remains", existsSync(dir));
}

// ---------------------------------------------------------------------------
console.log("prune — old sessions only, and only inside the root");

{
	const base = mkdtempSync(join(tmpdir(), "pi-scratch-test-"));
	const root = join(base, "root");

	const stale = ensure(root, "/w/proj", "old")!;
	const fresh = ensure(root, "/w/proj", "new")!;
	writeFileSync(join(stale, "f.txt"), "x");
	writeFileSync(join(fresh, "f.txt"), "x");

	const now = Date.now();
	const old = new Date(now - 30 * DAY);
	utimesSync(stale, old, old);

	// A sibling that is NOT ours must be untouched, which is the whole risk of a
	// recursive delete driven by directory listings.
	const bystander = join(base, "not-ours");
	mkdirSync(bystander);
	writeFileSync(join(bystander, "precious.txt"), "keep me");

	const removed = prune(root, now, 7);
	eq("the stale session is removed", removed, 1);
	check("and is gone", !existsSync(stale));
	check("the fresh one survives", existsSync(fresh));
	check("and so does everything outside the root", existsSync(join(bystander, "precious.txt")));

	// Emptying a project removes the project directory too, rather than leaving
	// a drift of empty folders in /tmp.
	utimesSync(fresh, old, old);
	prune(root, now, 7);
	check("an emptied project directory is cleaned up", !existsSync(projectDir(root, "/w/proj")));

	eq("pruning a root that does not exist is not an error", prune(join(base, "absent"), now, 7), 0);
	// retainDays: 0 means "as soon as it is not today's".
	const zero = ensure(root, "/w/proj2", "s")!;
	utimesSync(zero, new Date(now - 1000), new Date(now - 1000));
	eq("retainDays 0 prunes immediately", prune(root, now, 0), 1);
}

// ---------------------------------------------------------------------------
console.log("the injected prompt");

{
	const text = scratchpadPrompt("/tmp/pi-scratchpad-501/proj/sess");
	check("names the absolute path", text.includes("/tmp/pi-scratchpad-501/proj/sess"));
	check("says why, not just what", text.toLowerCase().includes("git"));
	check("leaves an escape hatch", text.includes("/tmp"));
	check("is short enough to be read", text.length < 1200, `${text.length} chars`);
}

// ---------------------------------------------------------------------------
console.log("settings — an untrusted project cannot redirect it");

{
	const base = mkdtempSync(join(tmpdir(), "pi-scratch-test-"));
	const agentDir = join(base, "agent");
	const project = join(base, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });

	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ scratchpad: { retainDays: 3 } }));
	eq("the user's block is read", loadSettings(agentDir, project, false).settings.retainDays, 3);
	eq("defaults fill the rest", loadSettings(agentDir, project, false).settings.enabled, true);

	// `dir` decides where the agent is told to write, so a hostile repo pointing
	// it at a directory the repo also reads would be a foothold, not a nuisance.
	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ scratchpad: { dir: "/tmp/theirs", enabled: false } }));
	const untrusted = loadSettings(agentDir, project, false);
	eq("an untrusted project cannot move it", untrusted.settings.dir, undefined);
	eq("nor switch it off", untrusted.settings.enabled, true);
	check("and the attempt is reported", untrusted.warnings.some((line) => line.includes("not trusted")), untrusted.warnings.join(" | "));

	const trusted = loadSettings(agentDir, project, true);
	eq("a trusted one can", trusted.settings.dir, "/tmp/theirs");

	writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ scratchpad: { retainDays: -1, enabled: "yes" } }));
	const bad = loadSettings(agentDir, project, true);
	eq("a negative retention is rejected", bad.settings.retainDays, 3);
	eq("and a non-boolean enabled", bad.settings.enabled, true);
	eq("both reported", bad.warnings.filter((line) => line.includes("scratchpad.")).length, 2);

	eq("DEFAULTS is not mutated", DEFAULTS.retainDays, 7);
	eq("nor its dir", DEFAULTS.dir, undefined);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
