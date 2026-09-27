/**
 * End-to-end for hooks: a real pi session, the real hooks AND permissions
 * extensions from this repo, and real hook commands on disk. Only the model is
 * fake — pi-ai's faux provider, scripted per scenario, which also records every
 * request so a check can read exactly what the model was shown.
 *
 * This is the level the behaviour lives at. Whether a PreToolUse "allow" skips
 * the permission prompt, whether a Stop hook's reason reaches the next request,
 * whether an untrusted project's hooks.json stays unloaded — each is a claim
 * about pi's dispatch order and two extensions agreeing over pi.events, and a
 * fake `pi` object would only have repeated what was assumed.
 *
 * Run it after editing this extension or permissions (from ~/.pi):
 *     node_modules/.bin/jiti agent/extensions/hooks/hooks.e2e.ts
 *
 * SAFETY: an earlier test in this repo pointed pi at the wrong env var and
 * overwrote the real settings.json. So before anything is written, this asserts
 * that pi's own getAgentDir() resolves inside the scratch root, and throws
 * otherwise. The variable is PI_CODING_AGENT_DIR.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "hooks-e2e-"));
const AGENT_DIR = join(ROOT, "agent");
const CWD = join(ROOT, "project");
const LOG = join(ROOT, "log.jsonl");
const PLAN = join(ROOT, "plan.json");
const HOOK = join(ROOT, "hook.mjs");
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(CWD, { recursive: true });

process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_OFFLINE = "1";

const pi = await import("@earendil-works/pi-coding-agent");
if (!pi.getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${pi.getAgentDir()}, outside the scratch root ${ROOT}`);
}
const { createAgentSession, DefaultResourceLoader, ModelRuntime, ProjectTrustStore, SessionManager, SettingsManager } = pi;
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSIONS = [join(HERE, "index.ts"), join(HERE, "..", "permissions", "index.ts")];

/**
 * One hook program for every scenario: it logs what it was sent, then does what
 * plan.json says for its name — a step, or a list of steps taken in turn. A
 * step with `sleep` logs "<name>:done" once it wakes, so a check can tell a
 * hook that finished from one that was killed.
 */
writeFileSync(
	HOOK,
	`import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const name = process.argv[2];
const payload = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ name, payload, projectDir: process.env.CLAUDE_PROJECT_DIR }) + "\\n");
let step = JSON.parse(readFileSync(${JSON.stringify(PLAN)}, "utf8"))[name];
if (Array.isArray(step)) {
	const counter = ${JSON.stringify(ROOT)} + "/count-" + name;
	const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
	writeFileSync(counter, String(n + 1));
	step = step[Math.min(n, step.length - 1)];
}
step ??= {};
if (step.sleep) {
	await new Promise((resolve) => setTimeout(resolve, step.sleep));
	appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ name: name + ":done", payload: {} }) + "\\n");
}
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === "string" ? step.stdout : JSON.stringify(step.stdout));
if (step.stderr !== undefined) process.stderr.write(step.stderr);
process.exit(step.exit ?? 0);
`,
);

const cmd = (name: string) => ({ type: "command", command: `node ${HOOK} ${name}` });

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

type LogEntry = { name: string; payload: Record<string, any>; projectDir?: string };
type Request = { system: string; messages: { role: string; text: string; isError?: boolean }[] };

function readLog(): LogEntry[] {
	if (!existsSync(LOG)) return [];
	return readFileSync(LOG, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function flatten(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) => (block.type === "text" ? block.text : block.type === "toolCall" ? `toolCall(${block.name})` : block.type))
		.join("|");
}

const bash = (command: string, id: string) => () => fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });
const write = (path: string, content: string, id: string) => () =>
	fauxAssistantMessage([fauxToolCall("write", { path, content }, { id })], { stopReason: "toolUse" });
const say = (text: string) => () => fauxAssistantMessage(text);

/**
 * Start a session with this scenario's settings, plan and scripted model.
 * `answers` feed the permissions prompt in order, matched by option prefix;
 * "Block@7000" answers after 7 s.
 */
async function start(setup: {
	permissions?: Record<string, unknown>;
	hooks?: Record<string, unknown>;
	plan?: Record<string, unknown>;
	responses: (() => unknown)[];
	answers?: string[];
}) {
	writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ permissions: setup.permissions ?? { defaultMode: "allowAll" }, hooks: setup.hooks ?? {} }));
	writeFileSync(PLAN, JSON.stringify(setup.plan ?? {}));
	rmSync(LOG, { force: true });
	for (const name of Object.keys(setup.plan ?? {})) rmSync(join(ROOT, `count-${name}`), { force: true });

	const requests: Request[] = [];
	const notes: string[] = [];
	const selects: string[] = [];
	const errors: unknown[] = [];
	const answers = [...(setup.answers ?? [])];

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ authPath: join(AGENT_DIR, "auth.json"), modelsPath: join(AGENT_DIR, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	faux.setResponses(
		setup.responses.map((respond) => (context: any) => {
			requests.push({
				system: String(context.systemPrompt ?? ""),
				messages: context.messages.map((m: any) => ({ role: m.role, text: flatten(m.content), ...(m.isError ? { isError: true } : {}) })),
			});
			return respond();
		}) as any,
	);

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: CWD,
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

	// Only what the two extensions call; anything else is a no-op.
	const ui = new Proxy(
		{
			notify: (message: string) => notes.push(message),
			select: async (title: string, options: string[]) => {
				selects.push(title);
				const [answer, delay] = (answers.shift() ?? "Block").split("@");
				if (delay) await new Promise((resolve) => setTimeout(resolve, Number(delay)));
				return options.find((option) => option.startsWith(answer));
			},
			confirm: async () => false,
		} as Record<string, unknown>,
		{ get: (target, key) => (key in target ? target[key as string] : () => undefined) },
	);
	await session.bindExtensions({ uiContext: ui as any, mode: "rpc", onError: (error) => errors.push(error) });

	return {
		session,
		requests,
		notes,
		selects,
		errors,
		quit: async () => {
			await (session as any).extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
	};
}

const last = <T>(items: T[]): T | undefined => items[items.length - 1];
const logged = (name: string) => readLog().filter((entry) => entry.name === name);
const toolResult = (request: Request | undefined, needle: string) =>
	request?.messages.find((message) => message.role === "toolResult" && message.text.includes(needle));

// ─── 1. SessionStart and UserPromptSubmit context ride the first prompt ───────
{
	const run = await start({
		hooks: { SessionStart: [{ hooks: [cmd("start")] }], UserPromptSubmit: [{ hooks: [cmd("prompt")] }] },
		plan: {
			start: { stdout: "START-CTX" },
			prompt: { stdout: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "PROMPT-CTX" } } },
		},
		responses: [say("ok")],
	});
	await run.session.prompt("hello");
	const roles = run.requests[0]?.messages.map((m) => m.role);
	const context = run.requests[0]?.messages.find((m) => m.text.includes("START-CTX"));
	check("1 one request", run.requests.length, 1);
	check("1 the context message follows the prompt", roles, ["system", "user", "user"]);
	check("1 SessionStart plain stdout reached the model", context?.text.includes("SessionStart hook additional context:\nSTART-CTX"), true);
	check("1 UserPromptSubmit additionalContext reached the model", context?.text.includes("PROMPT-CTX"), true);
	const [startEntry] = logged("start");
	check("1 SessionStart payload", [startEntry?.payload.hook_event_name, startEntry?.payload.source, startEntry?.payload.cwd], ["SessionStart", "startup", CWD]);
	check("1 session_id and transcript_path are sent", [typeof startEntry?.payload.session_id, startEntry?.payload.transcript_path], ["string", null]);
	check("1 CLAUDE_PROJECT_DIR is the session cwd", startEntry?.projectDir, CWD);
	check("1 UserPromptSubmit payload", logged("prompt")[0]?.payload.prompt, "hello");
	run.session.dispose();
}

// ─── 2. UserPromptSubmit exit 2 drops the prompt ──────────────────────────────
{
	const run = await start({
		hooks: { UserPromptSubmit: [{ hooks: [cmd("prompt")] }] },
		plan: { prompt: { exit: 2, stderr: "no secrets in prompts" } },
		responses: [],
	});
	await run.session.prompt("my password is hunter2");
	check("2 the model was never called", run.requests.length, 0);
	check("2 the user is told why", run.notes.some((note) => note.includes("no secrets in prompts")), true);
	check("2 nothing reached the session", run.session.messages.length, 0);
	run.session.dispose();
}

// ─── 3. PreToolUse exit 2 blocks; the model reads stderr ──────────────────────
{
	const run = await start({
		permissions: { defaultMode: "allowAll" },
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd("guard")] }] },
		plan: {
			guard: {
				exit: 2,
				stderr: "Blocked: Use rg, not grep",
				stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "rg is installed" } },
			},
		},
		responses: [bash("grep foo .", "c1"), say("done")],
	});
	await run.session.prompt("search");
	const result = toolResult(run.requests[1], "Blocked: Use rg");
	check("3 the block reason is the tool result", [Boolean(result), result?.isError], [true, true]);
	check("3 a blocked call's additionalContext rides the reason", result?.text.includes("rg is installed"), true);
	const [entry] = logged("guard");
	check(
		"3 PreToolUse payload: Claude's tool name, pi's input",
		[entry?.payload.tool_name, entry?.payload.tool_input, entry?.payload.tool_use_id, entry?.payload.permission_mode],
		["Bash", { command: "grep foo ." }, "c1", "allowAll"],
	);
	run.session.dispose();
}

// ─── 4. PreToolUse "ask" makes permissions prompt for a call it would allow ───
{
	const run = await start({
		permissions: { defaultMode: "askDestructive" },
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd("guard")] }], Notification: [{ hooks: [cmd("notify")] }] },
		plan: {
			guard: {
				stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "DANGEROUS: check", additionalContext: "ASK-CTX" } },
			},
		},
		responses: [bash("echo hi", "c1"), bash("echo again", "c2"), say("done")],
		// The first answered at once, the second after the 6 s a notification waits for.
		answers: ["Block", "Block@6500"],
	});
	await run.session.prompt("say hi");
	check("4 permissions prompted for each call", run.selects.length, 2);
	check("4 the prompt names the hook's reason", run.selects[0]?.includes("a PreToolUse hook asked about this call — DANGEROUS: check"), true);
	check("4 Block reached the model", Boolean(toolResult(run.requests[1], "Permission denied by user")), true);
	check("4 the ask hook's context survived the block", run.requests[1]?.messages.some((m) => m.role === "user" && m.text.includes("ASK-CTX")), true);
	await new Promise((resolve) => setTimeout(resolve, 500)); // Notification is not awaited
	const notes = logged("notify");
	check("4 one Notification: only the prompt left waiting", notes.length, 1);
	check("4 its payload", [notes[0]?.payload.notification_type, notes[0]?.payload.message], ["permission_prompt", "pi needs your permission to use Bash"]);
	run.session.dispose();
}

// ─── 5. PreToolUse "allow" skips the prompt; a deny rule still wins ───────────
{
	const run = await start({
		permissions: { defaultMode: "askMutating", deny: ["Write(**/secret.txt)"] },
		hooks: { PreToolUse: [{ matcher: "Write", hooks: [cmd("allow")] }] },
		plan: { allow: { stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } } } },
		responses: [
			() => fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "A" }, { id: "c1" }), fauxToolCall("write", { path: "secret.txt", content: "B" }, { id: "c2" })], { stopReason: "toolUse" }),
			say("done"),
		],
	});
	await run.session.prompt("write two files");
	check("5 no permission prompt", run.selects.length, 0);
	check("5 the allowed write happened", existsSync(join(CWD, "out.txt")) && readFileSync(join(CWD, "out.txt"), "utf8"), "A");
	check("5 the deny rule still blocked the other", [existsSync(join(CWD, "secret.txt")), Boolean(toolResult(run.requests[1], "deny rule"))], [false, true]);
	run.session.dispose();
}

// ─── 6. updatedInput, PostToolUse and PostToolBatch context, a Stop loop ──────
{
	const run = await start({
		hooks: {
			PreToolUse: [{ matcher: "Bash", hooks: [cmd("rewrite")] }],
			PostToolUse: [{ matcher: "Bash", hooks: [cmd("post")] }],
			PostToolBatch: [{ hooks: [cmd("batch")] }],
			Stop: [{ hooks: [cmd("stop")] }],
		},
		plan: {
			rewrite: { stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo rewritten" } } } },
			post: { stdout: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "POST-CTX" } } },
			batch: { stdout: { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "BATCH-CTX" } } },
			stop: [{ exit: 2, stderr: "run the tests first" }, {}],
		},
		responses: [bash("echo original", "c1"), say("done"), say("final")],
	});
	await run.session.prompt("go");
	const result = toolResult(run.requests[1], "rewritten");
	check("6 the rewritten command ran", Boolean(result), true);
	check("6 PostToolUse context is part of the result", result?.text.includes("PostToolUse hook additional context:\nPOST-CTX"), true);
	check("6 PostToolBatch context reached the next request", run.requests[1]?.messages.some((m) => m.role === "user" && m.text.includes("BATCH-CTX")), true);
	check("6 the Stop reason drove one more request", last(run.requests[2]?.messages ?? [])?.text, "Stop hook feedback:\nrun the tests first");
	check("6 three requests in all", run.requests.length, 3);
	const stops = logged("stop").map((entry) => [entry.payload.stop_hook_active, entry.payload.last_assistant_message]);
	check("6 Stop payloads", stops, [[false, "done"], [true, "final"]]);
	const [post] = logged("post");
	check("6 PostToolUse sees the input that ran", post?.payload.tool_input, { command: "echo rewritten" });
	check("6 so does PostToolBatch", logged("batch")[0]?.payload.tool_calls?.[0]?.tool_input, { command: "echo rewritten" });
	check("6 PostToolUse sees pi's result", post?.payload.tool_response?.content?.[0]?.text, "rewritten\n");
	run.session.dispose();
}

// ─── 7. A Stop hook that always blocks is cut off after 8 ─────────────────────
{
	const run = await start({
		hooks: { Stop: [{ hooks: [cmd("stop")] }] },
		plan: { stop: { exit: 2, stderr: "again" } },
		responses: Array.from({ length: 12 }, (_, index) => say(`reply ${index}`)),
	});
	await run.session.prompt("loop");
	check("7 one request plus 8 continuations", run.requests.length, 9);
	check("7 the Stop hook still ran on the final stop, and was overruled", logged("stop").length, 9);
	check("7 the user is told", run.notes.some((note) => note.includes("8 times in a row")), true);
	run.session.dispose();
}

// ─── 8. PermissionRequest decides the prompt permissions would show ───────────
{
	const run = await start({
		permissions: { defaultMode: "askMutating" },
		hooks: { PermissionRequest: [{ matcher: "Write", hooks: [cmd("request")] }] },
		plan: {
			request: [
				{ stdout: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } } },
				{ stdout: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not today" } } } },
			],
		},
		responses: [write("a.txt", "1", "c1"), write("b.txt", "2", "c2"), say("done")],
	});
	await run.session.prompt("write");
	check("8 no human prompt", run.selects.length, 0);
	check("8 allow let the write run", existsSync(join(CWD, "a.txt")), true);
	check("8 deny blocked it with the hook's message", [existsSync(join(CWD, "b.txt")), Boolean(toolResult(run.requests[2], "not today"))], [false, true]);
	const [entry] = logged("request");
	check("8 PermissionRequest payload", [entry?.payload.tool_name, entry?.payload.tool_input?.path, entry?.payload.permission_mode], ["Write", "a.txt", "askMutating"]);
	run.session.dispose();
}

// ─── 9. PostToolUseFailure context; continue:false stops the agent ────────────
{
	const run = await start({
		hooks: {
			PostToolUseFailure: [{ hooks: [cmd("fail")] }],
			PostToolUse: [{ matcher: "Bash", hooks: [cmd("halt")] }],
		},
		plan: {
			fail: { stdout: { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "FAIL-CTX" } } },
			halt: { stdout: { continue: false, stopReason: "enough for today" } },
		},
		responses: [bash("exit 3", "c1"), bash("echo fine", "c2"), say("never")],
	});
	await run.session.prompt("go");
	check("9 the failure context is part of the error result", Boolean(toolResult(run.requests[1], "FAIL-CTX")), true);
	check("9 PostToolUseFailure payload carries the error", logged("fail")[0]?.payload.error.includes("3"), true);
	check("9 continue:false stopped before another request", run.requests.length, 2);
	check("9 the user is told why", run.notes.some((note) => note.includes("enough for today")), true);
	check(
		"9 and the reason stays in the transcript",
		run.session.messages.some((message: any) => message.role === "custom" && String(message.content).includes("enough for today")),
		true,
	);
	run.session.dispose();
}

// ─── 10. http hooks; a project's hooks.json needs real trust ──────────────────
{
	const bodies: any[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			bodies.push({ body: JSON.parse(body), auth: request.headers.authorization });
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "denied over http" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	process.env.HOOKS_E2E_TOKEN = "t0ken";
	process.env.HOOKS_E2E_SECRET = "must-not-leak";

	// The user's own hooks.json, in the plugin shape; the project's, bare.
	writeFileSync(
		join(AGENT_DIR, "hooks.json"),
		JSON.stringify({
			description: "e2e",
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{
								type: "http",
								url: `http://127.0.0.1:${port}/hook`,
								headers: { authorization: "Bearer $HOOKS_E2E_TOKEN/${HOOKS_E2E_SECRET}" },
								allowedEnvVars: ["HOOKS_E2E_TOKEN"],
							},
						],
					},
				],
			},
		}),
	);
	mkdirSync(join(CWD, ".pi"), { recursive: true });
	writeFileSync(join(CWD, ".pi", "hooks.json"), JSON.stringify({ UserPromptSubmit: [{ hooks: [cmd("project")] }] }));

	const run = await start({ responses: [bash("echo hi", "c1"), say("done")] });
	await run.session.prompt("go");
	check("10 the http hook got the event", bodies[0]?.body.hook_event_name, "PreToolUse");
	check("10 only allowed env vars reach headers", bodies[0]?.auth, "Bearer t0ken/");
	check("10 its deny blocked the call", Boolean(toolResult(run.requests[1], "denied over http")), true);
	check("10 an untrusted project's hooks.json did not run", logged("project").length, 0);
	check("10 and the user is told", run.notes.some((note) => note.includes("not trusted")), true);
	run.session.dispose();

	new ProjectTrustStore(AGENT_DIR).set(CWD, true);
	const trusted = await start({ responses: [say("ok")] });
	await trusted.session.prompt("go");
	check("10 once trusted, it runs", logged("project").length, 1);
	trusted.session.dispose();

	server.close();
	rmSync(join(AGENT_DIR, "hooks.json"));
	rmSync(join(CWD, ".pi"), { recursive: true });
}

// ─── 11. A prompt hook on Stop, answered by the model ─────────────────────────
{
	const run = await start({
		hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Did the agent run the tests? $ARGUMENTS" }] }] },
		responses: [say("done"), say('```json\n{"ok": false, "reason": "run the tests"}\n```'), say("final"), say('{"ok": true}')],
	});
	await run.session.prompt("go");
	check("11 main, hook, main, hook", run.requests.length, 4);
	check("11 the hook was shown the event", run.requests[1]?.messages.find((m) => m.role === "user")?.text.includes('"hook_event_name":"Stop"'), true);
	check("11 its reason drove the continuation", last(run.requests[2]?.messages ?? [])?.text, "Stop hook feedback:\nrun the tests");
	run.session.dispose();
}

// ─── 12. SessionEnd on quit, and bad config is reported, not ignored ──────────
{
	const run = await start({
		hooks: {
			SessionEnd: [{ hooks: [cmd("end")] }],
			TeammateIdle: [{ hooks: [cmd("never")] }],
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "agent", prompt: "x" }] }],
		},
		responses: [],
	});
	check("12 an event pi cannot fire is named", run.notes.some((note) => note.includes("TeammateIdle never fires in pi")), true);
	check("12 an unsupported type is named", run.notes.some((note) => note.includes('"agent" hooks are not supported')), true);
	await run.quit();
	const [end] = logged("end");
	check("12 SessionEnd ran with its reason", end?.payload.reason, "prompt_input_exit");
}

// ─── 13. An async hook: no deadline, and its context lands in the same run ────
{
	const run = await start({
		hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ ...cmd("slow"), async: true, timeout: 0.1 }] }] },
		plan: { slow: [{ sleep: 300, stdout: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "ASYNC-CTX" } } }, {}] },
		responses: [bash("echo one", "c1"), bash("sleep 1", "c2"), say("done")],
	});
	await run.session.prompt("go");
	check("13 the 0.1 s timeout did not kill it", logged("slow:done").length, 1);
	check("13 its context reached the next request of the same run", run.requests[2]?.messages.some((m) => m.text.includes("ASYNC-CTX")), true);
	run.session.dispose();
}

// ─── 14. A PermissionRequest rewrite is judged again ──────────────────────────
{
	mkdirSync(join(CWD, "victim"), { recursive: true });
	const run = await start({
		// auto mode: a flagged rewrite would otherwise go to the classifier, and
		// must not slip through it. The ask rule makes the original call prompt
		// without a classifier call, so the model script stays deterministic.
		permissions: { defaultMode: "auto", ask: ["Bash(echo *)"] },
		hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [cmd("rewrite")] }] },
		plan: {
			rewrite: { stdout: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "rm -rf ./victim" } } } } },
		},
		responses: [bash("echo hi", "c1"), say("done")],
		answers: ["Block"],
	});
	await run.session.prompt("go");
	check("14 the flagged rewrite was put to a human", run.selects.length, 1);
	check("14 and blocked, so the directory survives", existsSync(join(CWD, "victim")), true);
	run.session.dispose();

	const quiet = await start({
		permissions: { defaultMode: "askMutating" },
		hooks: { PermissionRequest: [{ matcher: "Write", hooks: [cmd("rewrite")] }] },
		plan: {
			rewrite: { stdout: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { path: "rewritten.txt", content: "R" } } } } },
		},
		responses: [write("a.txt", "A", "c1"), say("done")],
	});
	await quiet.session.prompt("go");
	check("14 a rewrite only the mode would ask about is allowed", [quiet.selects.length, existsSync(join(CWD, "rewritten.txt"))], [0, true]);
	quiet.session.dispose();
}

// ─── 15. A rewrite with a non-string command cannot dodge a deny rule ─────────
{
	const run = await start({
		permissions: { defaultMode: "allowAll", deny: ["Bash(rm *)"] },
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [cmd("rewrite")] }] },
		plan: { rewrite: { stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: ["rm -rf ./victim"] } } } } },
		responses: [bash("echo hi", "c1"), say("done")],
	});
	await run.session.prompt("go");
	check("15 blocked: the command is not a string", Boolean(toolResult(run.requests[1], "command is not a string")), true);
	check("15 the directory survives", existsSync(join(CWD, "victim")), true);
	run.session.dispose();
}

// ─── 16. An unreadable trust.json costs the project's hooks, not the user's ───
{
	const trustPath = join(AGENT_DIR, "trust.json");
	const saved = existsSync(trustPath) ? readFileSync(trustPath, "utf8") : undefined;
	writeFileSync(trustPath, "{ not json");
	const run = await start({
		hooks: { UserPromptSubmit: [{ hooks: [cmd("prompt")] }] },
		responses: [say("ok")],
	});
	await run.session.prompt("go");
	check("16 the user's hook still ran", logged("prompt").length, 1);
	check("16 and the user is told why project hooks are off", run.notes.some((note) => note.includes("trust store could not be read")), true);
	run.session.dispose();
	if (saved === undefined) rmSync(trustPath);
	else writeFileSync(trustPath, saved);
}

// ─── 17. A hook still running when the session ends is killed, not left to crash pi
{
	const run = await start({
		hooks: { SessionStart: [{ hooks: [cmd("slow-start")] }] },
		plan: { "slow-start": { sleep: 1000, exit: 1, stderr: "late failure" } },
		responses: [],
	});
	await run.quit();
	// Had it lived, its late error would have been reported through a dead ctx —
	// an unhandled rejection, which ends this process before the checks below.
	await new Promise((resolve) => setTimeout(resolve, 1500));
	check("17 the hook was stopped with the session", logged("slow-start:done").length, 0);
	check("17 and nothing reported through the dead session", run.notes.some((note) => note.includes("late failure")), false);
}

rmSync(ROOT, { recursive: true, force: true });
if (failures === 0) console.log("\nALL PASS");
else {
	console.log(`\n${failures} FAILED`);
	process.exitCode = 1;
}
