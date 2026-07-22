/**
 * Unit coverage for the /add-dir pure logic: path containment, validation
 * results and their wording, session-entry replay, and the prompt block.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/add-dir/add-dir.test.ts
 *
 * pi only auto-loads `index.ts` from an extension folder, so this file sits here
 * harmlessly next to the thing it tests.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { displayPath, expandPath, isWithin, tildify } from "./paths.ts";
import { buildPromptBlock, findContextFile, loadContextFiles } from "./prompt.ts";
import { describe, validateDirectory } from "./validate.ts";
import { restoreSessionDirs } from "./workspace.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

const ROOT = mkdtempSync(join(tmpdir(), "adddir-"));
const CWD = join(ROOT, "project");
const SIBLING = join(ROOT, "sibling");
mkdirSync(join(CWD, "src"), { recursive: true });
mkdirSync(join(SIBLING, "lib"), { recursive: true });
writeFileSync(join(CWD, "file.txt"), "x");

console.log("--- paths/expandPath ---");
check("relative resolves against base", expandPath("src", CWD), join(CWD, "src"));
check("absolute passes through", expandPath(SIBLING, CWD), SIBLING);
check("bare tilde is home", expandPath("~", CWD), homedir());
check("tilde slash joins home", expandPath("~/x", CWD), join(homedir(), "x"));
check("whitespace trimmed", expandPath("  src  ", CWD), join(CWD, "src"));
check("empty is the base", expandPath("", CWD), CWD);
check("parent traversal resolves", expandPath("../sibling", CWD), SIBLING);
try {
	expandPath("a\0b", CWD);
	check("null byte rejected", "no throw", "throw");
} catch (error) {
	check("null byte rejected", error instanceof Error, true);
}

console.log("\n--- paths/isWithin ---");
check("same directory", isWithin("/a/b", "/a/b"), true);
check("child", isWithin("/a/b/c", "/a/b"), true);
check("parent is not within child", isWithin("/a/b", "/a/b/c"), false);
check("sibling", isWithin("/a/bb", "/a/b"), false);
check("prefix is not containment", isWithin("/a/bcd", "/a/b"), false);
check("unrelated", isWithin("/x", "/a/b"), false);
check("private tmp equals tmp", isWithin("/private/tmp/w", "/tmp/w"), true);
check("tmp equals private tmp", isWithin("/tmp/w", "/private/tmp/w"), true);
check("private var equals var", isWithin("/private/var/f/x", "/var/f"), true);
check("case matters by default", isWithin("/a/B", "/a/b"), false);
check("case folds when asked", isWithin("/a/B", "/a/b", { caseFold: true }), true);
check("root contains everything", isWithin("/a/b", "/"), true);

console.log("\n--- paths/display ---");
check("tildify home", tildify(homedir()), "~");
check("tildify under home", tildify(join(homedir(), "p", "q")), join("~", "p", "q"));
check("tildify leaves others", tildify("/opt/x"), "/opt/x");
check("display cwd itself", displayPath(CWD, CWD), ".");
check("display child relative", displayPath(join(CWD, "src"), CWD), "src");
check("display outside absolute", displayPath(SIBLING, CWD), tildify(SIBLING));
// A sibling whose name extends the cwd's must not be shown as a relative path.
check("display near-miss absolute", displayPath(`${CWD}-other`, CWD), tildify(`${CWD}-other`));

console.log("\n--- validate ---");
const base = { workingDirs: [CWD], cwd: CWD, additionalCount: 0 };

check("empty input", (await validateDirectory("", base)).resultType, "emptyPath");
check("missing path", (await validateDirectory(join(ROOT, "nope"), base)).resultType, "pathNotFound");
check("a file is not a directory", (await validateDirectory(join(CWD, "file.txt"), base)).resultType, "notADirectory");
check("new sibling succeeds", (await validateDirectory(SIBLING, base)).resultType, "success");
check("success returns absolute", (await validateDirectory("../sibling", base)) as unknown, {
	resultType: "success",
	absolutePath: SIBLING,
});

const already = await validateDirectory(CWD, base);
check("cwd is already there", already.resultType, "alreadyInWorkingDirectory");
check("cwd exact + original", already, {
	resultType: "alreadyInWorkingDirectory",
	directoryPath: CWD,
	workingDir: CWD,
	isExactMatch: true,
	isOriginalCwd: true,
});
check(
	"cwd message",
	describe(already),
	`${CWD} is already the current working directory.`,
);

const nested = await validateDirectory(join(CWD, "src"), base);
check("child of cwd is covered", nested.resultType, "alreadyInWorkingDirectory");
check(
	"child message names the covering dir",
	describe(nested),
	`${join(CWD, "src")} is already accessible within the current working directory ${CWD}.`,
);

const withSibling = { ...base, workingDirs: [CWD, SIBLING] };
check(
	"added dir repeat message",
	describe(await validateDirectory(SIBLING, withSibling)),
	`${SIBLING} is already added as a working directory.`,
);
check(
	"child of added dir message",
	describe(await validateDirectory(join(SIBLING, "lib"), withSibling)),
	`${join(SIBLING, "lib")} is already accessible within the additional working directory ${SIBLING}.`,
);
check(
	"not-a-directory suggests the parent",
	describe(await validateDirectory(join(CWD, "file.txt"), base)),
	`${join(CWD, "file.txt")} is not a directory. Did you mean to add the parent directory ${CWD}?`,
);
check(
	"missing path message",
	describe(await validateDirectory(join(ROOT, "nope"), base)),
	`Path ${join(ROOT, "nope")} was not found.`,
);
check("limit is enforced", (await validateDirectory(SIBLING, { ...base, additionalCount: 24 })).resultType, "limitReached");

// A symlink pointing at a directory is a directory as far as stat is concerned,
// which is what Claude Code does too.
const LINK = join(ROOT, "link");
symlinkSync(SIBLING, LINK);
check("symlink to a directory is accepted", (await validateDirectory(LINK, base)).resultType, "success");
// ...but a dangling one reads as missing, not as a crash.
const DEAD = join(ROOT, "dead");
symlinkSync(join(ROOT, "gone"), DEAD);
check("dangling symlink is not found", (await validateDirectory(DEAD, base)).resultType, "pathNotFound");

console.log("\n--- workspace/replay ---");
const entry = (dir: string, active: boolean) => ({ type: "custom", customType: "workspace_dir", data: { dir, active } });
check("no entries", restoreSessionDirs([]), []);
check("one add", restoreSessionDirs([entry("/a", true)]), ["/a"]);
check("add then remove", restoreSessionDirs([entry("/a", true), entry("/a", false)]), []);
check("remove then re-add", restoreSessionDirs([entry("/a", true), entry("/a", false), entry("/a", true)]), ["/a"]);
check("duplicate add is idempotent", restoreSessionDirs([entry("/a", true), entry("/a", true)]), ["/a"]);
check("order preserved", restoreSessionDirs([entry("/a", true), entry("/b", true)]), ["/a", "/b"]);
check("removal keeps the rest", restoreSessionDirs([entry("/a", true), entry("/b", true), entry("/a", false)]), ["/b"]);
check("remove of an unknown dir is a no-op", restoreSessionDirs([entry("/z", false)]), []);
check("other custom types ignored", restoreSessionDirs([{ type: "custom", customType: "goal_state", data: { dir: "/a", active: true } }]), []);
check("non-custom entries ignored", restoreSessionDirs([{ type: "message", data: { dir: "/a", active: true } }]), []);
check("malformed data skipped", restoreSessionDirs([{ type: "custom", customType: "workspace_dir", data: { active: true } }]), []);
check("empty dir string skipped", restoreSessionDirs([entry("", true)]), []);

console.log("\n--- prompt ---");
check("no dirs, no block", buildPromptBlock([]), "");
const block = buildPromptBlock([SIBLING]);
check("block lists the directory", block.includes(`- ${SIBLING}`), true);
check("block explains absolute paths", block.includes("absolute path"), true);
check("no context file, no context block", block.includes("<project_context>"), false);

writeFileSync(join(SIBLING, "AGENTS.md"), "sibling rules");
check("context file found", findContextFile(SIBLING), join(SIBLING, "AGENTS.md"));
check("no context file returns undefined", findContextFile(join(CWD, "src")), undefined);
const loaded = loadContextFiles([SIBLING]);
check("context file loaded", loaded.length, 1);
check("context content", loaded[0]?.content, "sibling rules");
check("not truncated", loaded[0]?.truncated, false);

const withContext = buildPromptBlock([SIBLING]);
check("context block present", withContext.includes("<project_context>"), true);
check("context labelled by path", withContext.includes(`path="${join(SIBLING, "AGENTS.md")}"`), true);
check("context content inlined", withContext.includes("sibling rules"), true);

// AGENTS.md wins over CLAUDE.md, matching pi's own candidate order.
const BOTH = join(ROOT, "both");
mkdirSync(BOTH);
writeFileSync(join(BOTH, "CLAUDE.md"), "claude");
writeFileSync(join(BOTH, "AGENTS.md"), "agents");
check("AGENTS.md preferred", findContextFile(BOTH), join(BOTH, "AGENTS.md"));

// An oversized file is cut, not dropped, and says so.
const BIG = join(ROOT, "big");
mkdirSync(BIG);
writeFileSync(join(BIG, "AGENTS.md"), "x".repeat(40_000));
const bigLoaded = loadContextFiles([BIG]);
check("oversized file truncated", bigLoaded[0]?.truncated, true);
check("oversized file capped at 24k", bigLoaded[0]?.content.length, 24_000);
check("truncation is declared in the prompt", buildPromptBlock([BIG]).includes('truncated="true"'), true);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
