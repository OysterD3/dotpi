/**
 * End-to-end for `acceptChanges`: a real pi session, the real permissions
 * extension, pi's real read/write/edit/bash tools on a scratch tree. Only the
 * model is fake — pi-ai's faux provider, one scripted tool call per row.
 *
 * This is the level the mode's promise lives at. "An edit inside the workspace
 * runs, anything else asks" is a claim about the path pi's tool will actually
 * touch, and two of the rows below differ from the path the model sent: `~/`
 * is expanded by pi, and a symlink is followed by the file system. decide.ts
 * sees neither, so only a real tool writing a real file can show the check and
 * the tool agree.
 *
 * Every prompt is answered Block, so each row asserts two things: whether a
 * prompt was shown (and for which reason), and whether the tool had its effect.
 *
 * Run it after editing permissions (from ~/.pi):
 *     node_modules/.bin/jiti agent/extensions/permissions/modes.e2e.ts
 *
 * SAFETY: an earlier test in this repo pointed pi at the wrong env var and
 * overwrote the real settings.json. So before anything is written, this asserts
 * that pi's own getAgentDir() resolves inside the scratch root, and throws
 * otherwise. The variable is PI_CODING_AGENT_DIR. HOME is moved into the
 * scratch root too, and asserted the same way, because two rows write to `~/`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "modes-e2e-"));
const AGENT_DIR = join(ROOT, "agent");
const CWD = join(ROOT, "project");
const HOME = join(ROOT, "home");
const OUTSIDE = join(ROOT, "outside");
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(CWD, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_OFFLINE = "1";
process.env.HOME = HOME;

const pi = await import("@earendil-works/pi-coding-agent");
if (!pi.getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${pi.getAgentDir()}, outside the scratch root ${ROOT}`);
}
if (homedir() !== HOME) {
	throw new Error(`REFUSING TO RUN: homedir() is ${homedir()}, not the scratch home ${HOME}`);
}
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi;
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSIONS = [join(HERE, "index.ts")];

writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptChanges" } }));

// The tree the rows act on.
writeFileSync(join(CWD, "notes.txt"), "hello from notes\n");
writeFileSync(join(CWD, "edit-me.txt"), "old line\n");
symlinkSync(OUTSIDE, join(CWD, "link"));
mkdirSync(join(CWD, ".git", "hooks"), { recursive: true });
symlinkSync(join(CWD, ".git", "hooks"), join(CWD, "docs"));
// Dangling: the targets do not exist, and a write follows the link to create them.
symlinkSync(join(OUTSIDE, "planted.sh"), join(CWD, "dangling.md"));
symlinkSync(".git/hooks/post-checkout", join(CWD, "run.sh"));

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

type Request = { messages: { role: string; text: string }[] };

function flatten(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block: any) => (block.type === "text" ? block.text : block.type)).join("|");
}

/**
 * One session per row, so no row sees another's grants. The model makes the
 * one call, reads its result, and stops. Every prompt is answered Block.
 */
async function run(tool: string, input: Record<string, unknown>, cwd = CWD) {
	const requests: Request[] = [];
	const notes: string[] = [];
	const selects: string[] = [];
	const errors: unknown[] = [];

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ authPath: join(AGENT_DIR, "auth.json"), modelsPath: join(AGENT_DIR, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	faux.setResponses(
		[() => fauxAssistantMessage([fauxToolCall(tool, input, { id: "c1" })], { stopReason: "toolUse" }), () => fauxAssistantMessage("done")].map(
			(respond) => (context: any) => {
				requests.push({ messages: context.messages.map((m: any) => ({ role: m.role, text: flatten(m.content) })) });
				return respond();
			},
		) as any,
	);

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager,
		additionalExtensionPaths: EXTENSIONS,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: AGENT_DIR,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		tools: ["read", "bash", "edit", "write"],
	});

	// Only what the extension calls; anything else is a no-op.
	const ui = new Proxy(
		{
			notify: (message: string) => notes.push(message),
			select: async (title: string, options: string[]) => {
				selects.push(title);
				return options.find((option) => option === "Block");
			},
			confirm: async () => false,
		} as Record<string, unknown>,
		{ get: (target, key) => (key in target ? target[key as string] : () => undefined) },
	);
	await session.bindExtensions({ uiContext: ui as any, mode: "rpc", onError: (error) => errors.push(error) });

	await session.prompt("go");
	session.dispose();

	const result = requests[1]?.messages.find((message) => message.role === "toolResult")?.text ?? "";
	// The reason lines of the prompt, as promptTitle in index.ts lays them out.
	const reasons = selects.flatMap((title) => title.split("\n").filter((line) => line.startsWith("  • ")).map((line) => line.slice(4)));
	return { notes, reasons, result, errors };
}

const EDIT_ASK = (tool: string) => `acceptChanges mode: this ${tool} is outside the workspace or on a protected path`;
const has = (path: string) => existsSync(path);

/**
 * `ask` is the one reason the prompt must give, or undefined for no prompt.
 * `ran` reads the tool's effect off the disk or its result; a row that asks is
 * answered Block, so it expects the effect to be absent.
 */
const ROWS: { label: string; tool: string; input: Record<string, unknown>; cwd?: string; ask?: string; ran: (result: string) => boolean }[] = [
	{
		label: "write inside cwd",
		tool: "write",
		input: { path: "new.txt", content: "N" },
		ran: () => has(join(CWD, "new.txt")) && readFileSync(join(CWD, "new.txt"), "utf8") === "N",
	},
	{
		label: "edit inside cwd",
		tool: "edit",
		input: { path: "edit-me.txt", edits: [{ oldText: "old line", newText: "new line" }] },
		ran: () => readFileSync(join(CWD, "edit-me.txt"), "utf8") === "new line\n",
	},
	{
		label: "read inside cwd",
		tool: "read",
		input: { path: "notes.txt" },
		ran: (result) => result.includes("hello from notes"),
	},
	{
		label: "write ~/ is the home directory, not <cwd>/~",
		tool: "write",
		input: { path: "~/tilde.txt", content: "H" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(HOME, "tilde.txt")) || has(join(CWD, "~", "tilde.txt")),
	},
	{
		label: "write @~/ drops the @ as pi does",
		tool: "write",
		input: { path: "@~/at-tilde.txt", content: "H" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(HOME, "at-tilde.txt")) || has(join(CWD, "@~", "at-tilde.txt")),
	},
	{
		label: "write file:// URL outside cwd",
		tool: "write",
		input: { path: pathToFileURL(join(OUTSIDE, "url.txt")).href, content: "U" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(OUTSIDE, "url.txt")),
	},
	{
		label: "write <cwd>/link/x where link points outside cwd",
		tool: "write",
		input: { path: join(CWD, "link", "x.txt"), content: "L" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(OUTSIDE, "x.txt")),
	},
	{
		label: "write <cwd>/docs/x where docs points into .git/hooks",
		tool: "write",
		input: { path: join(CWD, "docs", "pre-commit"), content: "#!/bin/sh\necho hi\n" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(CWD, ".git", "hooks", "pre-commit")),
	},
	{
		label: "write through a dangling link to a file outside cwd",
		tool: "write",
		input: { path: "dangling.md", content: "echo planted\n" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(OUTSIDE, "planted.sh")),
	},
	{
		label: "write through a dangling link into .git/hooks",
		tool: "write",
		input: { path: "run.sh", content: "#!/bin/sh\necho hi\n" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(CWD, ".git", "hooks", "post-checkout")),
	},
	// The workspace is the directory that holds pi's agent dir, as when you work
	// in ~/.pi: no path below it is named .pi, so its config is protected by name.
	{
		label: "write the agent dir's hooks.json from the dir that holds it",
		tool: "write",
		input: { path: "agent/hooks.json", content: "{}" },
		cwd: ROOT,
		ask: EDIT_ASK("write"),
		ran: () => has(join(AGENT_DIR, "hooks.json")),
	},
	{
		label: "write another file in the agent dir from there",
		tool: "write",
		input: { path: "agent/notes.md", content: "N" },
		cwd: ROOT,
		ran: () => has(join(AGENT_DIR, "notes.md")),
	},
	{
		label: "write .pi/hooks.json",
		tool: "write",
		input: { path: ".pi/hooks.json", content: "{}" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(CWD, ".pi", "hooks.json")),
	},
	{
		label: "write .envrc in cwd",
		tool: "write",
		input: { path: ".envrc", content: "export X=1\n" },
		ask: EDIT_ASK("write"),
		ran: () => has(join(CWD, ".envrc")),
	},
	{
		label: "bash ls",
		tool: "bash",
		input: { command: "ls" },
		ask: "acceptChanges mode: bash is not a file edit",
		ran: (result) => result.includes("notes.txt"),
	},
];

const warned: string[] = [];
const crashed: unknown[] = [];
for (const row of ROWS) {
	const { notes, reasons, result, errors } = await run(row.tool, row.input, row.cwd);
	warned.push(...notes.filter((note) => note.includes("defaultMode")));
	crashed.push(...errors.map(String));
	check(`${row.label}: ${row.ask ? "prompts" : "no prompt"}`, reasons, row.ask ? [row.ask] : []);
	check(`${row.label}: ${row.ask ? "blocked, did not run" : "ran"}`, row.ran(result), !row.ask);
}
// An unknown mode name falls back to the default with a warning, and several
// rows above would pass under that default too. This is what tells them apart.
check("acceptChanges loaded with no defaultMode warning", warned, []);
// pi reports a handler that throws (other than tool_call) here, not through a
// call. A session_start that threw would leave the extension with no policy,
// every call would run with no prompt, and the rows that expect that would
// pass for the wrong reason.
check("the extension raised no error", crashed, []);

rmSync(ROOT, { recursive: true, force: true });
if (failures === 0) console.log("\nALL PASS");
else {
	console.log(`\n${failures} FAILED`);
	process.exitCode = 1;
}
