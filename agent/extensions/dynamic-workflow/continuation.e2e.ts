/**
 * End-to-end for the turn a finished workflow starts: a real pi session, the
 * real dynamic-workflow extension, a real background run. Only the model is
 * fake — pi-ai's faux provider, one scripted reply per request.
 *
 * The complaint this guards: the result was delivered and its turn started,
 * but the model ended that turn with nothing — no text, no tool call — and the
 * agent looked stopped until the user typed. Delivery alone was being checked;
 * this checks what the parent did with it. An empty reply to a result gets one
 * retry with an explicit instruction, and a second empty reply an error, except
 * when the user cancelled (the turn, or the workflow), a question to the user is
 * pending, or the user queued a message.
 *
 * Run it after editing dynamic-workflow (from ~/.pi):
 *     node_modules/.bin/jiti agent/extensions/dynamic-workflow/continuation.e2e.ts
 *
 * SAFETY: PI_CODING_AGENT_DIR and HOME point into a scratch root, asserted
 * before anything is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(join(tmpdir(), "continuation-e2e-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
const AGENT_DIR = join(ROOT, "agent");
const CWD = join(ROOT, "project");
const HOME = join(ROOT, "home");
for (const dir of [AGENT_DIR, CWD, HOME]) mkdirSync(dir, { recursive: true });

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
const { fauxProvider, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } = await import("@earendil-works/pi-ai");

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "index.ts");
const HOOKS = join(HERE, "..", "hooks", "index.ts");

writeFileSync(join(AGENT_DIR, "settings.json"), "{}");

/**
 * Another extension's before-settle handler, loaded ahead of dynamic-workflow
 * so it runs first. OTHER_MODE picks what it does once, after the reply to a
 * workflow result: "continue" asks pi to go on with its own message, "queue"
 * sends one that starts a turn, and "note" sends one that does not — pi adds
 * that to the session after the settle hooks' entries, and runs nothing for it.
 * "user" queues a user message, as if the user typed while the run settled.
 */
const OTHER = join(ROOT, "other.ts");
writeFileSync(
	OTHER,
	`export default function (pi) {
	let done = false;
	pi.on("agent_before_settle", async (event) => {
		const mode = process.env.OTHER_MODE;
		const last = [...event.context.contextMessages].reverse().find((m) => m.role === "custom");
		if (done || !mode || last?.customType !== "workflow-result") return undefined;
		done = true;
		if (mode === "user") {
			pi.sendUserMessage("typed while it settled", { deliverAs: "followUp" });
			// Let pi's prompt path reach its queue before the next handler runs.
			await new Promise((resolve) => setTimeout(resolve, 50));
			return undefined;
		}
		if (mode === "queue" || mode === "note") {
			pi.sendMessage({ customType: "other", content: mode + " from another extension", display: true }, { triggerTurn: mode === "queue" });
			return undefined;
		}
		return { entries: [...event.entries, { type: "custom_message", customType: "other", content: "continued by another extension", display: true }], continue: true };
	});
}
`,
);
writeFileSync(join(CWD, "notes.txt"), "hello\n");

/** A Stop hook for the hooks extension: one line per call, with what it was shown. */
const STOP_LOG = join(ROOT, "stop.log");
const STOP_HOOK = join(ROOT, "stop-hook.mjs");
writeFileSync(
	STOP_HOOK,
	`import { appendFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => appendFileSync(${JSON.stringify(STOP_LOG)}, JSON.stringify(JSON.parse(input)) + "\\n"));
`,
);

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

/** A workflow that finishes at once, with no agents, so its result lands on the next idle. */
const WORKFLOW = 'export const meta = { name: "noop", description: "returns at once" }\nreturn "fleet done"';
/** One that runs until it is cancelled. */
const WAITING = 'export const meta = { name: "wait", description: "waits to be cancelled" }\nawait new Promise(() => {})\nreturn "never"';

type Reply = ReturnType<typeof fauxAssistantMessage>;
type Step = (session: any) => Reply;

const empty: Step = () => fauxAssistantMessage([]);
const say = (text: string): Step => () => fauxAssistantMessage([fauxText(text)]);

/**
 * One session per row. Step 0 starts the background workflow and step 1 ends
 * that turn; the rest answer the turn(s) the result starts. `before` runs
 * inside the session's own extension context, for rows that need one; `after`
 * runs once the first prompt is done. `hooks` loads the real hooks extension
 * AFTER dynamic-workflow — the order pi loads them in — with that config.
 */
async function run(
	steps: Step[],
	options: {
		prompt?: string;
		before?: (api: any) => void;
		after?: (session: any) => Promise<void>;
		withWorkflow?: boolean;
		workflow?: string;
		other?: "continue" | "queue" | "note" | "user";
		hooks?: Record<string, unknown>;
	} = {},
) {
	if (options.other) process.env.OTHER_MODE = options.other;
	else delete process.env.OTHER_MODE;
	const notes: { message: string; type?: string }[] = [];
	const errors: unknown[] = [];
	const requests: string[][] = [];
	const withWorkflow = options.withWorkflow ?? true;
	const script: Step[] = withWorkflow
		? [
				() => fauxAssistantMessage([fauxToolCall("workflow", { script: options.workflow ?? WORKFLOW }, { id: "wf1" })], { stopReason: "toolUse" }),
				say("Started the workflow."),
				...steps,
			]
		: steps;
	let step = 0;
	let session: any;
	const runsBefore = existsSync(join(AGENT_DIR, "workflow-runs")) ? readdirSync(join(AGENT_DIR, "workflow-runs")) : [];

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ authPath: join(AGENT_DIR, "auth.json"), modelsPath: join(AGENT_DIR, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	const respond = (context: any) => {
		requests.push(
			context.messages.map((message: any) =>
				`${message.role}:${Array.isArray(message.content) ? message.content.map((block: any) => block.text ?? block.type).join("|") : String(message.content)}`,
			),
		);
		const next = script[step++];
		return next ? next(session) : fauxAssistantMessage([fauxText("(the script ran out)")]);
	};
	faux.setResponses(Array.from({ length: 20 }, () => respond) as any);
	writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify(options.hooks ? { hooks: options.hooks } : {}));
	rmSync(STOP_LOG, { force: true });

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: CWD,
		agentDir: AGENT_DIR,
		settingsManager,
		additionalExtensionPaths: [...(options.other ? [OTHER] : []), EXTENSION, ...(options.hooks ? [HOOKS] : [])],
		extensionFactories: options.before ? [(api) => options.before!(api)] : [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	({ session } = await createAgentSession({
		cwd: CWD,
		agentDir: AGENT_DIR,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(CWD),
		tools: ["read", "workflow"],
	}));

	const ui = new Proxy(
		{
			notify: (message: string, type?: string) => notes.push({ message, type }),
			// pi copies these methods off the object, so a missing one is not caught by the Proxy below.
			setStatus: () => undefined,
			setEditorText: () => undefined,
		} as Record<string, unknown>,
		{ get: (target, key) => (key in target ? target[key as string] : () => undefined) },
	);
	await session.bindExtensions({ uiContext: ui as any, mode: "rpc", onError: (error: unknown) => errors.push(error) });

	await session.prompt(options.prompt ?? "go");
	await options.after?.(session);
	// The result lands on the first idle after the run ends (deliverResult polls
	// every 500 ms), and each turn it starts is one more request. Wait until
	// requests stop arriving and the session is idle.
	let seen = -1;
	for (let quiet = 0, waited = 0; quiet < 3 && waited < 30_000; waited += 500) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		quiet = requests.length === seen && session.isIdle ? quiet + 1 : 0;
		seen = requests.length;
	}
	await session.waitForIdle();

	// The run's own journal: delivery and the reply to it are recorded apart.
	const runs = join(AGENT_DIR, "workflow-runs");
	const known = new Set(runsBefore);
	const runId = existsSync(runs) ? readdirSync(runs).find((id) => !known.has(id)) : undefined;
	const journal = runId
		? readFileSync(join(runs, runId, "journal.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((record) => record.kind === "run" && (record.event === "delivered" || record.event === "reply"))
				.map((record) => [record.event, record.reply, record.skipped].filter(Boolean).join(":"))
		: [];

	const entries = session.sessionManager.getEntries() as any[];
	const custom = (type: string) => entries.filter((entry) => entry.type === "custom_message" && entry.customType === type);
	session.dispose();
	return {
		requests: requests.length,
		results: custom("workflow-result").length,
		retries: custom("workflow-continue").length,
		retryText: custom("workflow-continue")[0]?.content as string | undefined,
		errorNotes: notes.filter((note) => note.type === "error").map((note) => note.message),
		errors,
		journal,
		stops: existsSync(STOP_LOG)
			? readFileSync(STOP_LOG, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line).last_assistant_message)
			: [],
	};
}

{
	const r = await run([empty, say("The fleet says: done.")]);
	check("empty reply to a result: the result was delivered", r.results, 1);
	check("empty reply to a result: one retry", r.retries, 1);
	check("empty reply to a result: the retry tells the model to continue", /continue/i.test(r.retryText ?? ""), true);
	check("empty reply to a result: the model was asked again", r.requests, 4);
	check("empty reply to a result: no error once it answers", r.errorNotes, []);
	check("empty reply to a result: journal", r.journal, ["delivered", "reply:empty", "reply:answered"]);
	check("no extension errors", r.errors.length, 0);
}

{
	const r = await run([() => fauxAssistantMessage([fauxThinking("nothing to say")]), say("Done.")]);
	check("a reply with only thinking counts as empty: one retry", r.retries, 1);
	check("a reply with only thinking: the model was asked again", r.requests, 4);
}

{
	const r = await run([empty, empty]);
	check("empty twice: one retry only", r.retries, 1);
	check("empty twice: no third request", r.requests, 4);
	check("empty twice: an error is shown", r.errorNotes.length, 1);
	check("empty twice: the error says the reply was empty", /empty|nothing/i.test(r.errorNotes[0] ?? ""), true);
	check("empty twice: journal", r.journal, ["delivered", "reply:empty", "reply:empty-again"]);
}

{
	const r = await run([say("The fleet says: done.")]);
	check("a visible reply: no retry", r.retries, 0);
	check("a visible reply: no error", r.errorNotes, []);
	check("a visible reply: no extra request", r.requests, 3);
	check("a visible reply: journal", r.journal, ["delivered", "reply:answered"]);
}

{
	const r = await run([() => fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "r1" })], { stopReason: "toolUse" }), empty]);
	check("a tool call before an empty end: no retry", r.retries, 0);
	check("a tool call before an empty end: no error", r.errorNotes, []);
}

{
	const r = await run([
		(session) => {
			// Esc while the model answers the result.
			void session.abort();
			return fauxAssistantMessage([]);
		},
	]);
	check("cancelled: no retry", r.retries, 0);
	check("cancelled: no error", r.errorNotes, []);
	check("cancelled: no extra request", r.requests, 3);
}

{
	const r = await run([empty], {
		// A question to the user is open: ask_user says so on this channel, and an
		// empty reply is the model waiting for the answer.
		before: (api) => api.on("session_start", () => api.events.emit("ask-user:asking", { active: true, blocking: false })),
	});
	check("a pending question: no retry", r.retries, 0);
	check("a pending question: no error", r.errorNotes, []);
	check("a pending question: no extra request", r.requests, 3);
	check("a pending question: journal says why it was left", r.journal, ["delivered", "reply:empty:question"]);
}

{
	const r = await run([say("The fleet says: done.")], {
		before: (api) => api.on("session_start", () => api.events.emit("ask-user:asking", { active: true, blocking: false })),
	});
	check("a pending question, a visible reply: journal gives no reason to skip", r.journal, ["delivered", "reply:answered"]);
}

{
	const r = await run([empty, say("Stopping, as you asked.")], {
		workflow: WAITING,
		// The user cancels the workflow; its result says so, and an empty reply to that is fine.
		after: (session) => session.prompt("/workflows cancel"),
	});
	check("a cancelled workflow: its result was delivered", r.results, 1);
	check("a cancelled workflow: no retry", r.retries, 0);
	check("a cancelled workflow: no error", r.errorNotes, []);
	check("a cancelled workflow: no extra request", r.requests, 3);
	check("a cancelled workflow: journal says why it was left", r.journal, ["delivered", "reply:empty:cancelled"]);
}

{
	const r = await run([empty, say("Done.")], { other: "continue" });
	check("another extension goes on with an entry: no retry", r.retries, 0);
	check("another extension goes on with an entry: the model was asked again", r.requests, 4);
	check("another extension goes on with an entry: no error", r.errorNotes, []);
	// Its entry is a new input after the reply: what follows is its reply, not the result's.
	check("another extension goes on with an entry: journal", r.journal, ["delivered"]);
}

{
	// A message another extension queues is not one the user queued: the retry
	// is still sent, and both run in the one turn.
	const r = await run([empty, say("Done.")], { other: "queue" });
	check("another extension queues a turn: one retry", r.retries, 1);
	check("another extension queues a turn: the model was asked again, once", r.requests, 4);
	check("another extension queues a turn: no error", r.errorNotes, []);
	check("another extension queues a turn: journal", r.journal, ["delivered", "reply:empty", "reply:answered"]);
}

{
	const r = await run([empty, say("Answered the user.")], { other: "user" });
	check("the user queued a message: no retry", r.retries, 0);
	check("the user queued a message: it ran", r.requests, 4);
	check("the user queued a message: no error", r.errorNotes, []);
	check("the user queued a message: journal says why it was left", r.journal, ["delivered", "reply:empty:queued"]);
}

{
	// A note that starts no turn does not keep the session going, so the empty
	// reply is still a stall. pi adds the note after the retry, and the reply to
	// the retry is still judged.
	const r = await run([empty, empty], { other: "note" });
	check("a note from another extension: one retry", r.retries, 1);
	check("a note from another extension: the model was asked again", r.requests, 4);
	check("a note from another extension: an empty reply to the retry is an error", r.errorNotes.length, 1);
	check("a note from another extension: journal", r.journal, ["delivered", "reply:empty", "reply:empty-again"]);
}

{
	// The hooks extension loads after this one, so its Stop handler sees the
	// retry this one asked for. The agent is not stopping then: the Stop hook
	// runs once, at the real stop.
	const r = await run([empty, say("The fleet says: done.")], {
		hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${STOP_HOOK}` }] }] },
	});
	check("with a Stop hook: one retry", r.retries, 1);
	check("with a Stop hook: the model was asked again", r.requests, 4);
	check("with a Stop hook: it ran once, at the real stop", r.stops, ["Started the workflow.", "The fleet says: done."]);
	check("with a Stop hook: no extension errors", r.errors.length, 0);
}

{
	// A provider error ends the reply: pi reports it, and asking again is its retry setting's call, not this.
	const r = await run([() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" })]);
	check("a failed reply: no retry", r.retries, 0);
	check("a failed reply: no error from this extension", r.errorNotes, []);
	check("a failed reply: no extra request", r.requests, 3);
}

{
	const r = await run([empty], { withWorkflow: false, prompt: "hi" });
	check("an empty reply to the user, not to a result: no retry", r.retries, 0);
	check("an empty reply to the user: no error", r.errorNotes, []);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
