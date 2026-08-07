/**
 * Tests for the scratchpad exemption: the containment test, which tools it
 * covers, and — the part that actually matters — where it sits in the
 * precedence order.
 *
 *     pnpm dlx jiti agent/extensions/permissions/scratch.test.ts
 *
 * The exemption removes permission prompts, so every test below is really the
 * same question asked from a different angle: can it remove one it should not?
 * Hence the deny, ask, denyAll and traversal cases, and hence bash being pinned
 * to "still classified" rather than left unstated.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompiledPolicy, decide } from "./decide.ts";
import { parseRules } from "./rules.ts";
import { escapesScratchpad, isWithin, targetsScratchpad, usableScratchDir } from "./scratch.ts";
import { BUILTIN, type PermissionSettings } from "./settings.ts";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) return;
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

const CWD = "/work/project";
const SCRATCH = "/tmp/pi-501/-work-project/abc123/scratchpad";
const FILE = `${SCRATCH}/plan.md`;

const behavior = (policy: CompiledPolicy, tool: string, input: Record<string, unknown>) =>
	decide(policy, { tool, input, cwd: CWD, scratchDir: SCRATCH }).behavior;

// ---------------------------------------------------------------------------
console.log("isWithin — containment, including macOS's two spellings of one place");

check("a file inside is inside", isWithin("/tmp/s/a.md", "/tmp/s"));
check("the directory itself counts", isWithin("/tmp/s", "/tmp/s"));
check("nested arbitrarily deep is still inside", isWithin("/tmp/s/a/b/c.md", "/tmp/s"));
check("a sibling is not inside", !isWithin("/tmp/s2/a.md", "/tmp/s"));
// The prefix trap: "/tmp/scratch" starts with "/tmp/s" as a string.
check("a name that merely shares a prefix is not inside", !isWithin("/tmp/scratchpad-evil/a", "/tmp/s"));
check("the parent is not inside the child", !isWithin("/tmp", "/tmp/s"));
check("a traversal back out is not inside", !isWithin("/tmp/s/../../etc/passwd", "/tmp/s"));

// macOS hands one spelling to the tool and the other to us; without this the
// exemption silently never fires on a Mac, which is where it is mostly used.
check("/private/tmp and /tmp name the same directory", isWithin("/private/tmp/s/a.md", "/tmp/s"));
check("...in the other direction too", isWithin("/tmp/s/a.md", "/private/tmp/s"));
check("and the same for /var/folders", isWithin("/private/var/folders/x/T/s/a", "/var/folders/x/T/s"));

// ---------------------------------------------------------------------------
console.log("targetsScratchpad — which calls it recognises");

check("a write inside", targetsScratchpad({ tool: "write", input: { path: FILE }, cwd: CWD, scratchDir: SCRATCH }));
check("an edit inside", targetsScratchpad({ tool: "edit", input: { path: FILE }, cwd: CWD, scratchDir: SCRATCH }));
check("a read inside", targetsScratchpad({ tool: "read", input: { path: FILE }, cwd: CWD, scratchDir: SCRATCH }));
check("a write outside", !targetsScratchpad({ tool: "write", input: { path: "/work/project/src/a.ts" }, cwd: CWD, scratchDir: SCRATCH }));

// bash is deliberately not covered: a command is not judged by the paths it
// mentions, and `curl … > $SCRATCH/x.sh && sh $SCRATCH/x.sh` writes only inside.
check("bash is never exempted, whatever path it names", !targetsScratchpad({ tool: "bash", input: { command: `cat ${FILE}` }, cwd: CWD, scratchDir: SCRATCH }));
check("nor is a custom tool with a path argument", !targetsScratchpad({ tool: "my_tool", input: { path: FILE }, cwd: CWD, scratchDir: SCRATCH }));

check("no scratchpad announced means nothing is exempt", !targetsScratchpad({ tool: "write", input: { path: FILE }, cwd: CWD, scratchDir: undefined }));
check("a missing path argument is not a match", !targetsScratchpad({ tool: "write", input: {}, cwd: CWD, scratchDir: SCRATCH }));
check("a non-string path is not a match", !targetsScratchpad({ tool: "write", input: { path: 42 }, cwd: CWD, scratchDir: SCRATCH }));
check("an empty path is not a match", !targetsScratchpad({ tool: "write", input: { path: "" }, cwd: CWD, scratchDir: SCRATCH }));
check("a null byte rejects rather than throwing", !targetsScratchpad({ tool: "write", input: { path: `${SCRATCH}/a\0b` }, cwd: CWD, scratchDir: SCRATCH }));
check("a relative scratchpad is refused outright", !targetsScratchpad({ tool: "write", input: { path: FILE }, cwd: CWD, scratchDir: "scratchpad" }));

// Judged on where it lands, not how it was spelled.
check(
	"a relative path is resolved against the cwd first",
	targetsScratchpad({ tool: "write", input: { path: "../../tmp/pi-501/-work-project/abc123/scratchpad/a.md" }, cwd: CWD, scratchDir: SCRATCH }),
);
check(
	"a traversal out of the scratchpad is not exempt",
	!targetsScratchpad({ tool: "write", input: { path: `${SCRATCH}/../../../../../etc/hosts` }, cwd: CWD, scratchDir: SCRATCH }),
);

// ---------------------------------------------------------------------------
console.log("usableScratchDir — the bound on what the channel may name");

eq("the ordinary case passes through", usableScratchDir(SCRATCH, CWD), SCRATCH);

// The channel is the trust boundary. Before this, one `{ dir: "/" }` from any
// extension in the session turned off prompting for every path on the machine.
eq("the filesystem root is refused", usableScratchDir("/", CWD), undefined);
eq("...and so is any directory containing the project", usableScratchDir("/work", CWD), undefined);
eq("...including the project itself", usableScratchDir(CWD, CWD), undefined);
eq("...and the home directory above it", usableScratchDir("/", "/Users/me/app"), undefined);
// A scratchpad in the repo is the failure the feature exists to prevent, with
// the prompt suppressed on top.
eq("a directory inside the project is refused", usableScratchDir(`${CWD}/scratch`, CWD), undefined);
// /tmp itself is shared with every process on the machine.
eq("a single segment below the root is refused", usableScratchDir("/tmp", CWD), undefined);
eq("two segments is enough", usableScratchDir("/tmp/pi-501", CWD), "/tmp/pi-501");
eq("a relative directory is refused", usableScratchDir("scratchpad", CWD), undefined);
eq("nothing announced is refused", usableScratchDir(undefined, CWD), undefined);
eq("a null byte is refused", usableScratchDir("/tmp/a\0b/c", CWD), undefined);

eq(
	"an unusable announcement cannot exempt anything",
	targetsScratchpad({ tool: "write", input: { path: "/etc/hosts" }, cwd: CWD, scratchDir: "/" }),
	false,
);

// ---------------------------------------------------------------------------
console.log("escapesScratchpad — confirming the lexical answer against the disk");

const FS = mkdtempSync(join(tmpdir(), "scratch-esc-"));
const PAD = join(FS, "scratchpad");
mkdirSync(PAD, { recursive: true });
writeFileSync(join(PAD, "notes.txt"), "real file");
mkdirSync(join(PAD, "runs"), { recursive: true });

const OUTSIDE = join(FS, "outside");
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, "id_rsa"), "secret");

check("an ordinary file inside does not escape", !escapesScratchpad(join(PAD, "notes.txt"), CWD, PAD));
check("a file that does not exist yet does not escape", !escapesScratchpad(join(PAD, "new.json"), CWD, PAD));
check("nor one under a subdirectory that does not exist yet", !escapesScratchpad(join(PAD, "a/b/c.json"), CWD, PAD));

// The case the old "the agent would have had to create that symlink itself"
// comment wrongly dismissed: bash in scratch space is cleared by the classifier,
// so the symlink gets planted and the read was then lexically inside.
symlinkSync(join(OUTSIDE, "id_rsa"), join(PAD, "leak.txt"));
check("a symlink out of the scratchpad escapes", escapesScratchpad(join(PAD, "leak.txt"), CWD, PAD));

symlinkSync(OUTSIDE, join(PAD, "door"));
check("a symlinked directory escapes", escapesScratchpad(join(PAD, "door"), CWD, PAD));
check("...and so does writing through it to a file that does not exist", escapesScratchpad(join(PAD, "door/planted.sh"), CWD, PAD));

check("a missing scratchpad root fails closed", escapesScratchpad(join(PAD, "a.txt"), CWD, join(FS, "absent")));

// ---------------------------------------------------------------------------
console.log("decide — where the exemption sits in the order");

const auto = policyFor({ defaultMode: "auto" });

eq("a write into the scratchpad allows without a classifier call", behavior(auto, "write", { path: FILE }), "allow");
eq("an edit into it, likewise", behavior(auto, "edit", { path: FILE }), "allow");
eq("a write outside it still goes to the classifier", behavior(auto, "write", { path: "/work/project/a.ts" }), "classify");
eq("bash naming it still goes to the classifier", behavior(auto, "bash", { command: `sh ${FILE}` }), "classify");
eq(
	"the reason names the scratchpad, so /permissions can explain itself",
	decide(auto, { tool: "write", input: { path: FILE }, cwd: CWD, scratchDir: SCRATCH }).reason,
	"inside this session's scratchpad",
);

// Sitting at the allow step is the whole safety argument: deny and the
// destructive table have already run by the time it is reached.
const denied = policyFor({ defaultMode: "auto", deny: ["Write(**/.env)"] });
eq("a deny rule still wins inside the scratchpad", behavior(denied, "write", { path: `${SCRATCH}/.env` }), "deny");

const asked = policyFor({ defaultMode: "auto", ask: ["Write(**/*.sh)"] });
eq("an ask rule still wins inside the scratchpad", behavior(asked, "write", { path: `${SCRATCH}/run.sh` }), "ask");

// An implicit rule written in no settings file has no business being the thing
// that lets something run in the mode whose point is that nothing does.
const denyAll = policyFor({ defaultMode: "denyAll" });
eq("denyAll is not loosened by it", behavior(denyAll, "write", { path: FILE }), "deny");

// It is an allow, so it is at least as permissive as the modes above auto.
eq("askMutating stops prompting for scratch writes", behavior(policyFor({ defaultMode: "askMutating" }), "write", { path: FILE }), "allow");
eq("askAll stops prompting for scratch writes", behavior(policyFor({ defaultMode: "askAll" }), "write", { path: FILE }), "allow");
eq(
	"askAll still prompts for a write outside it",
	behavior(policyFor({ defaultMode: "askAll" }), "write", { path: "/work/project/a.ts" }),
	"ask",
);

// With the scratchpad extension absent, nothing about the old behaviour moves.
eq(
	"no announcement leaves auto mode exactly as it was",
	decide(auto, { tool: "write", input: { path: FILE }, cwd: CWD }).behavior,
	"classify",
);

eq(
	"the allow is marked, so index.ts knows to confirm it against the filesystem",
	decide(auto, { tool: "write", input: { path: FILE }, cwd: CWD, scratchDir: SCRATCH }).scratch,
	true,
);
eq(
	"an ordinary allow carries no such marker",
	decide(policyFor({ defaultMode: "auto", allow: ["Write(**/*.ts)"] }), {
		tool: "write",
		input: { path: "/work/project/a.ts" },
		cwd: CWD,
		scratchDir: SCRATCH,
	}).scratch,
	undefined,
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;

rmSync(FS, { recursive: true, force: true });
