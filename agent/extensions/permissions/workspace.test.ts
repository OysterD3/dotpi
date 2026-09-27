/**
 * Tests for `acceptChanges`: which calls it lets run, and the filesystem check
 * that confirms a workspace edit.
 *
 *     pnpm dlx jiti agent/extensions/permissions/workspace.test.ts
 *
 * The mode removes the prompt for an edit, so most rows here ask the same
 * question as scratch.test.ts: can it remove one it should not? Hence the path
 * spellings that `resolve` reads wrongly (`~`, `@`, `file://`), the protected
 * paths where an edit is a command that runs later, and every rule and hook that
 * must still win over it.
 *
 * decide() is the seam for the text half. escapesWorkspace() is the other half,
 * and it runs against a real temp directory, because a symlink is the case.
 */

import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Call, type CompiledPolicy, type Decision, decide } from "./decide.ts";
import { parseRules } from "./rules.ts";
import { BUILTIN, type PermissionSettings } from "./settings.ts";
import { escapesWorkspace } from "./workspace.ts";

let failures = 0;
let passes = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) {
		passes++;
		return;
	}
	failures++;
	console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function policyFor(overrides: Partial<PermissionSettings> = {}): CompiledPolicy {
	const settings: PermissionSettings = {
		...BUILTIN,
		...overrides,
		auto: { ...BUILTIN.auto, ...(overrides.auto ?? {}) },
	};
	return {
		allow: parseRules(settings.allow).rules,
		ask: parseRules(settings.ask).rules,
		deny: parseRules(settings.deny).rules,
		settings,
		allowDestructive: new Set(settings.allowDestructive),
	};
}

/** The behaviour plus every marker index.ts acts on, so one string pins all of them. */
function outcome(decision: Decision): string {
	const marks = [
		decision.workspace && "workspace",
		decision.scratch && "scratch",
		(decision.findings ?? []).length > 0 && "findings",
	];
	return [decision.behavior, ...marks.filter(Boolean)].join(" ");
}

// The workspace as dirsFor() in index.ts builds it: the cwd, then the
// additionalDirectories and /add-dir entries, then the usable scratchpad.
const CWD = "/work/project";
const ADDED = "/work/design-system";
const SCRATCH = "/tmp/pi-501/-work-project/abc123/scratchpad";
const WORKSPACE = [CWD, ADDED, SCRATCH];

const accept = policyFor({ defaultMode: "acceptChanges" });

const run = (tool: string, input: Record<string, unknown>, extra: Partial<Call> = {}, policy = accept): string =>
	outcome(decide(policy, { tool, input, cwd: CWD, scratchDir: SCRATCH, workspace: WORKSPACE, ...extra }));

const write = (path: string) => ({ path, content: "x" });

// The layout when you work in ~/.pi: the workspace root is .pi, and pi's agent
// dir is inside it.
const PI_HOME = "/home/me/.pi";
const runAt = (cwd: string, input: Record<string, unknown>) =>
	outcome(decide(accept, { tool: String("content" in input ? "write" : "edit"), input, cwd, workspace: [cwd], agentDir: `${PI_HOME}/agent` }));
const edit = (path: string) => ({ path, edits: [{ oldText: "a", newText: "b" }] });

// ---------------------------------------------------------------------------
console.log("acceptChanges through decide() — what runs and what asks");

const rows: Array<[string, string, string]> = [
	// Reads run, wherever they are. Claude Code prompts once for a read outside
	// the workspace; this mode does not, on purpose. Deny rules are the answer to
	// a secret file.
	["read inside the workspace", run("read", { path: "src/a.ts" }), "allow"],
	["grep", run("grep", { pattern: "TODO" }), "allow"],
	["find", run("find", { pattern: "*.ts" }), "allow"],
	["ls", run("ls", { path: "." }), "allow"],
	["read outside the workspace", run("read", { path: "/etc/hosts" }), "allow"],
	["read of a protected path", run("read", { path: ".git/config" }), "allow"],

	// Edits inside the workspace run, and carry the marker index.ts confirms
	// against the filesystem.
	["write inside the cwd", run("write", write("src/a.ts")), "allow workspace"],
	["edit inside the cwd", run("edit", edit("src/a.ts")), "allow workspace"],
	["write by absolute path inside the cwd", run("write", write(`${CWD}/src/a.ts`)), "allow workspace"],
	["write with pi's @ prefix", run("write", write("@src/a.ts")), "allow workspace"],
	["write by file:// URL inside the cwd", run("write", write(`file://${CWD}/src/a.ts`)), "allow workspace"],
	["write inside an /add-dir directory", run("write", write(`${ADDED}/tokens.css`)), "allow workspace"],
	["write inside the scratchpad", run("write", write(`${SCRATCH}/plan.md`)), "allow scratch"],
	// judge() re-decides without scratchDir when the scratchpad check escapes;
	// the scratchpad is still in the list, so the workspace check must mark it.
	["the scratchpad through the workspace list alone", run("write", write(`${SCRATCH}/plan.md`), { scratchDir: undefined }), "allow workspace"],

	// Outside the workspace asks. The first three are the spellings a plain
	// resolve(cwd, path) reads as <cwd>/~/… or <cwd>/file:/…, inside.
	["~/x", run("write", write("~/x")), "ask"],
	["@~/x", run("write", write("@~/x")), "ask"],
	["file:// URL outside", run("write", write("file:///work/other/a.ts")), "ask"],
	// pi joins after the tilde, so this is under the home directory; a resolve()
	// would drop the home and land on /work/project/a.ts, inside.
	["~//work/project/a.ts", run("write", write("~//work/project/a.ts")), "ask"],
	["../outside", run("write", write("../outside/a.ts")), "ask"],
	["an absolute path outside", run("edit", edit("/etc/hosts")), "ask"],

	// Protected paths inside the workspace ask: an edit there runs later.
	[".pi/hooks.json", run("write", write(".pi/hooks.json")), "ask"],
	[".pi/settings.json", run("edit", edit(".pi/settings.json")), "ask"],
	[".git/hooks/pre-commit", run("write", write(".git/hooks/pre-commit")), "ask"],
	[".GIT/config, any case", run("write", write(".GIT/config")), "ask"],
	["a nested repo's sub/.git/config", run("write", write("sub/.git/config")), "ask"],
	[".config/git/ignore", run("write", write(".config/git/ignore")), "ask"],
	[".zshrc", run("write", write(".zshrc")), "ask"],
	[".envrc", run("write", write(".envrc")), "ask"],
	["sub/.npmrc", run("write", write("sub/.npmrc")), "ask"],
	["a protected path in an /add-dir directory", run("write", write(`${ADDED}/.git/config`)), "ask"],
	// Every directory that holds the path is asked, so adding .pi as a directory
	// of its own does not clear what the cwd protects.
	[
		"a directory added inside a protected one",
		run("write", write(`${CWD}/.pi/settings.json`), { workspace: [CWD, `${CWD}/.pi`] }),
		"ask",
	],
	// APFS folds ſ to s and ﬁ to fi, so these name the real protected paths.
	[".vſcode/tasks.json", run("write", write(".vſcode/tasks.json")), "ask"],
	[".gitconﬁg", run("write", write(".gitconﬁg")), "ask"],
	[".HUſKY/pre-commit", run("write", write(".HUſKY/pre-commit")), "ask"],
	// Working in ~/.pi itself: nothing below the root is named .pi, so pi's own
	// config files are protected by full path instead. Extension code is not.
	["agent/settings.json with the workspace at ~/.pi", runAt(PI_HOME, write("agent/settings.json")), "ask"],
	["agent/hooks.json", runAt(PI_HOME, write("agent/hooks.json")), "ask"],
	["agent/mcp.json", runAt(PI_HOME, write("agent/mcp.json")), "ask"],
	["agent/trust.json", runAt(PI_HOME, write("agent/trust.json")), "ask"],
	["agent/Settings.JSON, any case", runAt(PI_HOME, write("agent/Settings.JSON")), "ask"],
	["the agent dir's config from anywhere else in the workspace", runAt(PI_HOME, write(`${PI_HOME}/agent/models.json`)), "ask"],
	["extension code in the agent dir runs", runAt(PI_HOME, edit("agent/extensions/x/index.ts")), "allow workspace"],
	["a settings.json that is not the agent dir's runs", runAt(PI_HOME, write("docs/settings.json")), "allow workspace"],
	// Segments, not prefixes: a directory named like a protected one is not one.
	[".pitch/notes.md", run("write", write(".pitch/notes.md")), "allow workspace"],
	["git/notes.md", run("write", write("git/notes.md")), "allow workspace"],

	// Every rule above the mode's default still wins over it.
	["a deny rule", run("write", write("config/.env"), {}, policyFor({ defaultMode: "acceptChanges", deny: ["Write(**/.env)"] })), "deny"],
	["an ask rule", run("edit", edit("db/001.sql"), {}, policyFor({ defaultMode: "acceptChanges", ask: ["Edit(**/*.sql)"] })), "ask"],
	["a hook's ask", run("write", write("src/a.ts"), { hook: { decision: "ask", reason: "reviewed by a hook" } }), "ask"],

	// Everything that is not a file edit asks. All bash, too: Claude Code lets
	// mkdir, touch, rm, mv, cp and sed inside the workspace run; this mode does
	// not, on purpose.
	["bash ls", run("bash", { command: "ls" }), "ask"],
	["destructive bash", run("bash", { command: "rm -rf build" }), "ask findings"],
	["generate_image into the cwd", run("generate_image", { prompt: "a circle", path: `${CWD}/image.png` }), "ask"],
	["an MCP tool", run("mcp__github__create_issue", { title: "x" }), "ask"],
	["a custom tool", run("web_fetch", { url: "https://x.test" }), "ask"],

	// No workspace, no edit inside it.
	["an empty workspace list", run("edit", edit("src/a.ts"), { workspace: [] }), "ask"],
	["no workspace list at all", run("edit", edit("src/a.ts"), { workspace: undefined }), "ask"],
	["a write with no path", run("write", { content: "x" }), "ask"],
];
for (const [label, actual, expected] of rows) eq(label, actual, expected);

// ---------------------------------------------------------------------------
console.log("escapesWorkspace — confirming the lexical answer against the disk");

const FS = mkdtempSync(join(tmpdir(), "workspace-esc-"));
const WS = join(FS, "project");
const AWAY = join(FS, "outside");
mkdirSync(join(WS, ".git", "hooks"), { recursive: true });
mkdirSync(AWAY, { recursive: true });
writeFileSync(join(WS, "notes.txt"), "real file");
writeFileSync(join(AWAY, "id_rsa"), "secret");

symlinkSync(join(AWAY, "id_rsa"), join(WS, "leak.txt"));
symlinkSync(AWAY, join(WS, "door"));
symlinkSync(join(WS, ".git", "hooks"), join(WS, "docs"));
const LINKED = join(FS, "linked");
symlinkSync(WS, LINKED);
// Dangling: a write follows the link and creates its target.
symlinkSync(join(AWAY, "planted.sh"), join(WS, "dangling.md"));
symlinkSync(".git/hooks/post-checkout", join(WS, "run.sh"));
linkSync(join(AWAY, "id_rsa"), join(WS, "hard.txt"));
const AGENT = join(WS, "agent");
mkdirSync(AGENT);
writeFileSync(join(AGENT, "settings.json"), "{}");
symlinkSync(AGENT, join(WS, "cfg"));

const escapes = (path: string, cwd = WS) => escapesWorkspace({ tool: "write", input: { path }, cwd, workspace: [cwd], agentDir: AGENT });

// The text half cannot see a link, so it lets this one through. That is the
// reason judge() in index.ts asks the disk before it acts on the marker.
eq(
	"the text alone lets docs/pre-commit through",
	outcome(decide(accept, { tool: "write", input: write("docs/pre-commit"), cwd: WS, workspace: [WS] })),
	"allow workspace",
);

const disk: Array<[string, boolean, boolean]> = [
	["an ordinary file inside does not escape", escapes("notes.txt"), false],
	["a new file inside does not escape", escapes("new.ts"), false],
	["nor one under directories that do not exist yet", escapes("src/deep/new.ts"), false],
	["a symlink to a file outside escapes", escapes("leak.txt"), true],
	["a write through a symlinked directory escapes", escapes("door/planted.sh"), true],
	["docs -> .git/hooks escapes: protected once resolved", escapes("docs/pre-commit"), true],
	["a workspace reached through a symlink does not escape", escapes("a.ts", LINKED), false],
	["...nor does an existing file in it", escapes("notes.txt", LINKED), false],
	["a tilde path is judged at home, not under the cwd", escapes("~/x"), true],
	["a dangling symlink to a file outside escapes", escapes("dangling.md"), true],
	["a dangling symlink into .git/hooks escapes", escapes("run.sh"), true],
	["a hard link to a file outside escapes", escapes("hard.txt"), true],
	["the agent dir's settings.json escapes", escapes("agent/settings.json"), true],
	["...and so does the same file through a symlinked directory", escapes("cfg/settings.json"), true],
	["other files in the agent dir do not", escapes("agent/extensions/x.ts"), false],
];
for (const [label, actual, expected] of disk) eq(label, actual, expected);

console.log(`\n${passes} passed`);
console.log(`${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;

rmSync(FS, { recursive: true, force: true });
