/**
 * End-to-end for /add-dir against the real extension and the real settings
 * writer, in a throwaway tree.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/add-dir/add-dir.e2e.ts
 *
 * SAFETY: an earlier test in this project pointed pi at the wrong env var and
 * overwrote the real settings.json. So before anything is written, this asserts
 * that pi's own getAgentDir() resolves inside the scratch root, and throws
 * otherwise. The variable is PI_CODING_AGENT_DIR — not PI_CONFIG_DIR.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "adddir-e2e-"));
const AGENT_DIR = join(ROOT, "agent");
const CWD = join(ROOT, "project");
const LIB = join(ROOT, "lib");
const DOCS = join(ROOT, "docs");
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(join(CWD, ".pi"), { recursive: true });
mkdirSync(LIB, { recursive: true });
mkdirSync(DOCS, { recursive: true });

process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
const resolved = getAgentDir();
if (!resolved.startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${resolved}, outside the scratch root ${ROOT}`);
}

const addDir = (await import("./index.ts")).default;
const { persist, unpersist, loadPersisted } = await import("./settings.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

const USER_SETTINGS = join(AGENT_DIR, "settings.json");
const PROJECT_SETTINGS = join(CWD, ".pi", "settings.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

// ---------------------------------------------------------------- settings.ts

console.log("--- settings writer ---");

// Existing unrelated content must survive, since this file is pi's too.
writeFileSync(
	USER_SETTINGS,
	JSON.stringify({ theme: "one-dark-pro", permissions: { defaultMode: "askDestructive", deny: ["Read(**/.env)"] } }, null, 2),
);
persist(USER_SETTINGS, LIB);
check("other top-level keys preserved", readJson(USER_SETTINGS).theme, "one-dark-pro");
check("other permission keys preserved", readJson(USER_SETTINGS).permissions.defaultMode, "askDestructive");
check("deny list preserved", readJson(USER_SETTINGS).permissions.deny, ["Read(**/.env)"]);
check("directory written", readJson(USER_SETTINGS).permissions.additionalDirectories, [LIB]);

persist(USER_SETTINGS, LIB);
check("re-adding is idempotent", readJson(USER_SETTINGS).permissions.additionalDirectories, [LIB]);

persist(USER_SETTINGS, DOCS);
check("second directory appends", readJson(USER_SETTINGS).permissions.additionalDirectories, [LIB, DOCS]);

check("unpersist reports success", unpersist(USER_SETTINGS, LIB), true);
check("unpersist removes just the one", readJson(USER_SETTINGS).permissions.additionalDirectories, [DOCS]);
check("unpersist of an absent dir is false", unpersist(USER_SETTINGS, "/nope"), false);

unpersist(USER_SETTINGS, DOCS);
check("empty list key dropped", "additionalDirectories" in readJson(USER_SETTINGS).permissions, false);
check("permissions block kept when it holds other keys", readJson(USER_SETTINGS).permissions.defaultMode, "askDestructive");

// Writing into a file that does not exist yet must create it and its directory.
const FRESH = join(ROOT, "fresh", "settings.json");
persist(FRESH, LIB);
check("missing file created", readJson(FRESH), { permissions: { additionalDirectories: [LIB] } });
unpersist(FRESH, LIB);
check("empty permissions block dropped entirely", readJson(FRESH), {});

// A stale lock directory left by a crashed process must not wedge us forever.
mkdirSync(`${USER_SETTINGS}.lock`);
let lockError: string | undefined;
try {
	persist(USER_SETTINGS, LIB);
} catch (error) {
	lockError = (error as NodeJS.ErrnoException).code;
}
check("a held lock is reported, not ignored", lockError, "EEXIST");
check("nothing written while locked", "additionalDirectories" in readJson(USER_SETTINGS).permissions, false);
rmSync(`${USER_SETTINGS}.lock`, { recursive: true });

console.log("\n--- settings loader ---");
persist(USER_SETTINGS, LIB);
writeFileSync(PROJECT_SETTINGS, JSON.stringify({ permissions: { additionalDirectories: [DOCS] } }, null, 2));

const trusted = loadPersisted(AGENT_DIR, CWD, true);
check("trusted project contributes", trusted.sources.map((s) => s.dirs).flat(), [LIB, DOCS]);
check("both files reported", trusted.sources.map((s) => s.path), [USER_SETTINGS, PROJECT_SETTINGS]);

const untrusted = loadPersisted(AGENT_DIR, CWD, false);
check("untrusted project ignored", untrusted.sources.map((s) => s.dirs).flat(), [LIB]);
check("and says so", untrusted.warnings.length, 1);
check("warning names the file", untrusted.warnings[0]?.includes(PROJECT_SETTINGS), true);

writeFileSync(PROJECT_SETTINGS, "{ not json");
check("unparseable file is skipped, not fatal", loadPersisted(AGENT_DIR, CWD, true).sources.length, 1);
check("and warns", loadPersisted(AGENT_DIR, CWD, true).warnings.length, 1);

writeFileSync(PROJECT_SETTINGS, JSON.stringify({ permissions: { additionalDirectories: "nope" } }));
check("non-array value warns", loadPersisted(AGENT_DIR, CWD, true).warnings[0]?.includes("must be an array"), true);

rmSync(PROJECT_SETTINGS);
unpersist(USER_SETTINGS, LIB);

// --------------------------------------------------------------- the command

type Command = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: any) => Promise<void>;
};

const commands = new Map<string, Command>();
const handlers = new Map<string, Function>();
const entries: Array<{ type: string; customType: string; data: any }> = [];
const notices: string[] = [];

const pi = {
	on: (event: string, handler: Function) => handlers.set(event, handler),
	registerCommand: (name: string, options: Command) => commands.set(name, options),
	appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
};

/**
 * Resolve a wanted answer against the options actually offered.
 *
 * Deliberately strict: an earlier version of this fake echoed back whatever the
 * test asked for, which let a test "choose" a label the product never showed.
 */
function makeUi(answers: string[]) {
	let index = 0;
	return {
		select: async (_title: string, options: string[]) => {
			const want = answers[index++];
			if (want === undefined) throw new Error(`select() called with no answer queued; options were ${JSON.stringify(options)}`);
			if (want === "\0cancel") return undefined;
			const exact = options.filter((option) => option === want);
			if (exact.length === 1) return exact[0];
			const partial = options.filter((option) => option.includes(want));
			if (partial.length === 1) return partial[0];
			throw new Error(`answer ${JSON.stringify(want)} matched ${partial.length} of ${JSON.stringify(options)}`);
		},
		input: async () => {
			const want = answers[index++];
			return want === "\0cancel" ? undefined : want;
		},
		notify: (message: string) => notices.push(message),
	};
}

function makeCtx(answers: string[], options?: { hasUI?: boolean; trusted?: boolean }) {
	return {
		cwd: CWD,
		hasUI: options?.hasUI ?? true,
		isProjectTrusted: () => options?.trusted ?? true,
		sessionManager: { getBranch: () => entries },
		ui: makeUi(answers),
	};
}

function startSession(ctx: any) {
	handlers.get("session_start")?.({}, ctx);
}

async function run(command: string, args: string, answers: string[], options?: { hasUI?: boolean; trusted?: boolean }) {
	notices.length = 0;
	const ctx = makeCtx(answers, options);
	startSession(ctx);
	await commands.get(command)!.handler(args, ctx);
	return notices;
}

addDir(pi as any);

console.log("\n--- registration ---");
check("both commands registered", [...commands.keys()], ["add-dir", "dirs"]);
check("description matches Claude Code", commands.get("add-dir")?.description, "Add a new working directory");
check("session_start hooked", handlers.has("session_start"), true);
check("before_agent_start hooked", handlers.has("before_agent_start"), true);

console.log("\n--- /add-dir for this session ---");
let out = await run("add-dir", LIB, ["Yes, for this session"]);
check("confirms the session scope", out[0]?.startsWith(`Added ${LIB} as a working directory for this session`), true);
check("session entry recorded", entries.at(-1), { type: "custom", customType: "workspace_dir", data: { dir: LIB, active: true } });
check("nothing written to settings", existsSync(USER_SETTINGS) && !("additionalDirectories" in readJson(USER_SETTINGS).permissions), true);

console.log("\n--- the model is told ---");
const prompt = handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, makeCtx([]));
check("prompt extended", (prompt as any).systemPrompt.startsWith("BASE"), true);
check("prompt names the directory", (prompt as any).systemPrompt.includes(LIB), true);

console.log("\n--- adding twice ---");
out = await run("add-dir", LIB, []);
check("already added is reported", out[0], `${LIB} is already added as a working directory.`);
out = await run("add-dir", CWD, []);
check("cwd is reported", out[0], `${CWD} is already the current working directory.`);
out = await run("add-dir", join(LIB, "sub"), []);
check("a missing child is not found", out[0], `Path ${join(LIB, "sub")} was not found.`);

console.log("\n--- declining ---");
const before = entries.length;
out = await run("add-dir", DOCS, ["No"]);
check("no means no", out[0], `Did not add ${DOCS} as a working directory.`);
check("nothing recorded", entries.length, before);

out = await run("add-dir", DOCS, ["\0cancel"]);
check("escape is the same as no", out[0], `Did not add ${DOCS} as a working directory.`);

console.log("\n--- /add-dir remembered globally ---");
out = await run("add-dir", DOCS, ["Yes, and remember this directory", "Every project"]);
check("saved and says where", out[0]?.includes(`saved to ${USER_SETTINGS}`), true);
check("written to the user file", readJson(USER_SETTINGS).permissions.additionalDirectories, [DOCS]);
check("no session entry for a persisted dir", entries.at(-1)?.data.dir, LIB);

console.log("\n--- /add-dir remembered per project ---");
out = await run("add-dir", join(ROOT, "extra"), ["Yes, and remember this directory", "This project"], { trusted: true });
mkdirSync(join(ROOT, "extra"));
out = await run("add-dir", join(ROOT, "extra"), ["Yes, and remember this directory", "This project"], { trusted: true });
check("written to the project file", readJson(PROJECT_SETTINGS).permissions.additionalDirectories, [join(ROOT, "extra")]);

console.log("\n--- an untrusted project cannot persist ---");
rmSync(PROJECT_SETTINGS);
const MORE = join(ROOT, "more");
mkdirSync(MORE);
out = await run("add-dir", MORE, ["Yes, and remember this directory", "This project"], { trusted: false });
check("falls back to the session", out[0]?.includes("for this session only"), true);
check("explains why", out[0]?.includes("not trusted"), true);
check("and does not write the file", existsSync(PROJECT_SETTINGS), false);

console.log("\n--- without a UI ---");
// MORE is already in the workspace from the case above, so this needs its own.
const HEADLESS = join(ROOT, "headless");
mkdirSync(HEADLESS);
out = await run("add-dir", "", [], { hasUI: false });
check("no path, no dialog: usage", out[0], "Usage: /add-dir <path>");
out = await run("add-dir", HEADLESS, [], { hasUI: false });
check("an explicit path is honoured for the session", out[0], `Added ${HEADLESS} as a working directory for this session`);
check("a repeat still reports it is already there", (await run("add-dir", HEADLESS, [], { hasUI: false }))[0], `${HEADLESS} is already added as a working directory.`);

console.log("\n--- /dirs ---");
const listCtx = makeCtx(["Done"]);
startSession(listCtx);
notices.length = 0;
await commands.get("dirs")!.handler("", listCtx);
check("done leaves everything alone", notices.length, 0);

notices.length = 0;
const removeCtx = makeCtx([DOCS]);
startSession(removeCtx);
await commands.get("dirs")!.handler("", removeCtx);
check("removal reports both places", notices[0], `Removed ${DOCS} from the workspace and from ${USER_SETTINGS}`);
check("and updates the file", "additionalDirectories" in readJson(USER_SETTINGS).permissions, false);

console.log("\n--- completions ---");
const complete = commands.get("add-dir")!.getArgumentCompletions!;
const suggestions = complete(`${ROOT}/`) as Array<{ value: string }> | null;
check("directories offered", suggestions?.some((item) => item.value === `${LIB}/`), true);
check("only directories", suggestions?.every((item) => item.value.endsWith("/")), true);
check("unknown prefix yields nothing", complete("/no/such/path/"), null);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
