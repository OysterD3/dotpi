/**
 * End-to-end for auto mode and scratchpad scripts: a real pi session, the real
 * permissions and scratchpad extensions, pi's real tools. Only the model is
 * fake — pi-ai's faux provider plays both the agent and the classifier.
 *
 * The complaint this guards: every `node <scratch>/x.mjs` asked for approval,
 * because the classifier was shown the command and not the script, and was
 * told that code it cannot read is unsafe. So the fake classifier here answers
 * safe exactly when the question shows it a script's text, and unsafe when
 * that text says EVIL. Each row asserts whether the text was shown, whether a
 * prompt was raised (answered Block), and whether the script actually ran.
 *
 * Run it after editing permissions (from ~/.pi):
 *     node_modules/.bin/jiti agent/extensions/permissions/scripts.e2e.ts
 *
 * SAFETY: PI_CODING_AGENT_DIR and HOME point into a scratch root, asserted
 * before anything is written, as in modes.e2e.ts.
 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "scripts-e2e-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
const AGENT_DIR = join(ROOT, "agent");
const CWD = join(ROOT, "project");
const HOME = join(ROOT, "home");
const OUTSIDE = join(ROOT, "outside");
const TMP = join(ROOT, "tmp");
for (const dir of [AGENT_DIR, CWD, HOME, OUTSIDE, TMP]) mkdirSync(dir, { recursive: true });

process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_OFFLINE = "1";
process.env.HOME = HOME;
process.env.TMPDIR = TMP;

const pi = await import("@earendil-works/pi-coding-agent");
if (!pi.getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${pi.getAgentDir()}, outside the scratch root ${ROOT}`);
}
if (homedir() !== HOME) {
	throw new Error(`REFUSING TO RUN: homedir() is ${homedir()}, not the scratch home ${HOME}`);
}
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi;
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { registerApiProvider, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");

const HERE = dirname(fileURLToPath(import.meta.url));
const PERMISSIONS = join(HERE, "index.ts");
const SCRATCHPAD = join(HERE, "..", "scratchpad", "index.ts");
// Registers `bash` as a sequential tool, which is what makes pi run a batch
// one call at a time. The user's setup has it; the rows without it are pi's
// default, a parallel batch.
const BACKGROUND_SHELL = join(HERE, "..", "background-shell", "index.ts");

writeFileSync(
	join(AGENT_DIR, "settings.json"),
	JSON.stringify({ permissions: { defaultMode: "auto", deny: ["Read(**/secret-*.mjs)"] }, scratchpad: { root: TMP } }),
);
writeFileSync(join(CWD, "notes.txt"), "hello\n");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

/** A script that leaves `ran-<name>` beside itself, so a row can tell it ran. */
const script = (name: string, extra = "") =>
	`import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./ran-${name}", import.meta.url), "1");\n${extra}`;

const SHOWN = /\nscript .+, as it is on disk before this command runs:\n/;

type Call = [tool: string, input: Record<string, unknown>];

/**
 * One session per row. Each step is one assistant message, built when it is
 * sent, from the scratchpad path the scratchpad extension announced. `during`
 * runs while the classifier is answering, as another process would.
 */
async function run(steps: ((s: string) => Call[])[], sequential = false, during?: (s: string) => void) {
	const questions: string[] = [];
	const selects: string[] = [];
	const notes: string[] = [];
	const errors: unknown[] = [];
	let scratch = "";
	let step = 0;
	let calls = 0;

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ authPath: join(AGENT_DIR, "auth.json"), modelsPath: join(AGENT_DIR, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	// The classifier calls pi-ai's completeSimple, which finds a provider in the
	// global registry rather than in the session's model runtime.
	registerApiProvider({ api: faux.api, stream: faux.provider.stream, streamSimple: faux.provider.streamSimple } as any, "scripts-e2e");
	const text = (message: any) =>
		Array.isArray(message?.content) ? message.content.map((block: any) => block.text ?? "").join("") : String(message?.content ?? "");
	const respond = (context: any) => {
		const system = context.messages.find((message: any) => message.role === "system");
		if (text(system).startsWith("You are the permission classifier")) {
			const question = context.messages.filter((message: any) => message.role === "user").map(text).join("\n");
			questions.push(question);
			during?.(scratch);
			const safe = SHOWN.test(question) && !question.includes("EVIL");
			return fauxAssistantMessage(JSON.stringify({ safe, reason: safe ? "read the script" : "cannot read the script" }));
		}
		const next = steps[step++];
		if (!next) return fauxAssistantMessage("done");
		return fauxAssistantMessage(
			next(scratch).map(([tool, input]) => fauxToolCall(tool, input as any, { id: `c${++calls}` })),
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 40 }, () => respond) as any);

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: CWD,
		agentDir: AGENT_DIR,
		settingsManager,
		additionalExtensionPaths: [PERMISSIONS, SCRATCHPAD, ...(sequential ? [BACKGROUND_SHELL] : [])],
		extensionFactories: [
			(api) => {
				api.events.on("scratchpad:dir", (data) => {
					scratch = String((data as { dir?: unknown })?.dir ?? "");
				});
			},
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: CWD,
		agentDir: AGENT_DIR,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(CWD),
		tools: ["read", "bash", "edit", "write"],
	});

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
	unregisterApiProviders("scripts-e2e");
	// With the classifier unreachable, onError "allow" runs every script and a
	// row about prompts would pass for the wrong reason.
	check("  (the classifier was reachable)", notes.filter((note) => note.includes("degraded")), []);

	const ran = (name: string) => scratch !== "" && existsSync(join(scratch, `ran-${name}`));
	return { questions, shown: questions.map((q) => SHOWN.test(q)), asked: selects.length, ran, scratch, errors };
}

const write = (s: string, name: string, extra = ""): Call => ["write", { path: join(s, `${name}.mjs`), content: script(name, extra) }];
const node = (path: string): Call => ["bash", { command: `node ${path}` }];

{
	const r = await run([(s) => [write(s, "a")], (s) => [node(join(s, "a.mjs"))]]);
	check("scratchpad announced", r.scratch.startsWith(TMP), true);
	check("written last turn: text shown", r.shown, [true]);
	check("written last turn: no prompt", r.asked, 0);
	check("written last turn: it ran", r.ran("a"), true);
	check("no extension errors", r.errors.length, 0);
}

{
	// Where a relative name points depends on where the command is when it runs.
	const r = await run([(s) => [write(s, "b")], (s) => [["bash", { command: `cd ${s} && node b.mjs` }]]]);
	check("a relative name: text not shown", r.shown, [false]);
	check("a relative name: asked", r.asked, 1);
}

{
	// Another process rewrites the script while the classifier reads the old text.
	const r = await run(
		[(s) => [write(s, "r")], (s) => [node(join(s, "r.mjs"))]],
		false,
		(s) => writeFileSync(join(s, "r.mjs"), script("r", "// changed")),
	);
	check("changed while the classifier read it: text shown", r.shown, [true]);
	check("changed while the classifier read it: asked", r.asked, 1);
	check("changed while the classifier read it: did not run", r.ran("r"), false);
}

{
	const r = await run([(s) => [write(s, "c")], (s) => [["read", { path: "notes.txt" }], node(join(s, "c.mjs"))]]);
	check("beside a read in one batch: text shown", r.shown, [true]);
	check("beside a read in one batch: it ran", r.ran("c"), true);
}

{
	// The race the batch guard is for: the text on disk is harmless when the
	// check reads it, and the write beside the command replaces it before it runs.
	const r = await run([(s) => [write(s, "d")], (s) => [write(s, "d", "// EVIL"), node(join(s, "d.mjs"))]]);
	check("rewritten in the same parallel batch: text not shown", r.shown, [false]);
	check("rewritten in the same parallel batch: asked", r.asked, 1);
	check("rewritten in the same parallel batch: did not run", r.ran("d"), false);
}

{
	const r = await run([(s) => [write(s, "e"), node(join(s, "e.mjs"))]], true);
	check("written earlier in a sequential batch: text shown", r.shown, [true]);
	check("written earlier in a sequential batch: it ran", r.ran("e"), true);
	check("sequential batch: no extension errors", r.errors.length, 0);
}

{
	const r = await run([(s) => [write(s, "f")], (s) => [node(join(s, "f.mjs")), write(s, "f", "// EVIL")]], true);
	check("a write later in the batch: text not shown", r.shown, [false]);
	check("a write later in the batch: asked", r.asked, 1);
}

{
	const r = await run([
		(s) => [write(s, "g")],
		(s) => [node(join(s, "g.mjs"))],
		(s) => [["edit", { path: join(s, "g.mjs"), edits: [{ oldText: 'writeFileSync(new URL("./ran-g"', newText: '// EVIL\nwriteFileSync(new URL("./ran-g"' }] }]],
		(s) => [node(join(s, "g.mjs"))],
	]);
	check("an edited script is judged again, on its new text", r.questions.length, 2);
	check("an edited script: the second question shows the edit", r.questions[1]?.includes("EVIL"), true);
	check("an edited script: the second run asked", r.asked, 1);
}

{
	writeFileSync(join(OUTSIDE, "h.mjs"), script("h"));
	const r = await run([() => [node(join(OUTSIDE, "h.mjs"))]]);
	check("a script outside the scratchpad: text not shown", r.shown, [false]);
	check("a script outside the scratchpad: asked", r.asked, 1);
}

{
	writeFileSync(join(OUTSIDE, "i.mjs"), script("i"));
	const r = await run([
		(s) => {
			symlinkSync(join(OUTSIDE, "i.mjs"), join(s, "i.mjs"));
			return [node(join(s, "i.mjs"))];
		},
	]);
	check("a symlink out of the scratchpad: text not shown", r.shown, [false]);
	check("a symlink out of the scratchpad: asked", r.asked, 1);
}

{
	writeFileSync(join(OUTSIDE, "j.mjs"), script("j"));
	const r = await run([
		(s) => {
			linkSync(join(OUTSIDE, "j.mjs"), join(s, "j.mjs"));
			return [node(join(s, "j.mjs"))];
		},
	]);
	check("a hard link into the scratchpad: text not shown", r.shown, [false]);
	check("a hard link into the scratchpad: asked", r.asked, 1);
}

{
	// Showing the text to the classifier's model is a read, so a deny rule on reading the file holds.
	const r = await run([(s) => [write(s, "secret-k")], (s) => [node(join(s, "secret-k.mjs"))]]);
	check("a script a deny rule keeps from being read: it was written", existsSync(join(r.scratch, "secret-k.mjs")), true);
	check("a script a deny rule keeps from being read: text not shown", r.shown, [false]);
	check("a script a deny rule keeps from being read: asked", r.asked, 1);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
