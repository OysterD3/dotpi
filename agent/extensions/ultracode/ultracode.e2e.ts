/**
 * End-to-end wiring for the ultracode extension against the real index.ts and
 * tool registration, with a fake `pi` object and no subprocesses or network:
 * registration, the keyword flow, the session-mode command and its reminder
 * cadence, thinking-level exits, branch restore, and the workflow tool's
 * no-agent, error, and abort paths (agent-spawning paths run in ultracode.live.ts).
 *
 * Run it after editing this extension, with jiti from a directory where pi's
 * packages resolve (they are not dependencies of this repo):
 *     jiti agent/extensions/ultracode/ultracode.e2e.ts
 *
 * Reads settings from a scratch agent dir via PI_CODING_AGENT_DIR and never
 * writes outside it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "ultracode-e2e-"));
const AGENT = join(ROOT, "agent");
const CWD = join(ROOT, "project");
mkdirSync(AGENT, { recursive: true });
mkdirSync(CWD, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { KEYWORD_REMINDER, ENTER_FULL, ENTER_SPARSE, EXIT, routingReminder } = await import("./reminders.ts");
const { PANEL_CHANNEL, PANEL_OPEN_CHANNEL, SPEND_CHANNEL, SPEND_SOURCE } = await import("./config.ts");
const { SUBAGENT_PREAMBLE } = await import("./description.ts");
const { createRun, readMeta } = await import("./store.ts");

/** What ultracode puts on SPEND_CHANNEL. */
type SpendEvent = { source: string; detail?: string; calls?: number; usage: { cost?: number; reasoning?: number } };
const ultracode = (await import("./index.ts")).default;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------- fake pi

const events = new Map<string, Function>();
const commands = new Map<string, { description?: string; handler: Function; getArgumentCompletions?: Function }>();
const shortcuts = new Map<string, { description?: string; handler: Function }>();
const tools = new Map<string, any>();
const entryRenderers: string[] = [];
const messageRenderers: string[] = [];
const appended: Array<{ customType: string; data: any }> = [];
const sent: Array<{ message: any; options: any }> = [];
let thinkingLevel = "medium";
const thinkingLog: string[] = [];
// Mimics pi: the applied level is the requested one clamped to what the model
// supports. Tests swap this to exercise the clamp paths.
let clampLevel: (level: string) => string = (level) => level;

// The inter-extension bus. ultracode announces its active-run lines here for the
// statusline to append to the footer, so the fake has to carry it — without it
// drawPanel() throws into its own catch and silently stops drawing.
const busEmitted: Array<{ channel: string; data: unknown }> = [];
const busHandlers = new Map<string, (data: unknown) => void>();

const pi = {
	on: (event: string, handler: Function) => events.set(event, handler),
	events: {
		emit: (channel: string, data: unknown) => {
			busEmitted.push({ channel, data });
			busHandlers.get(channel)?.(data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			busHandlers.set(channel, handler);
			return () => busHandlers.delete(channel);
		},
	},
	registerCommand: (name: string, options: any) => commands.set(name, options),
	registerShortcut: (key: string, options: any) => shortcuts.set(key, options),
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerEntryRenderer: (type: string, _renderer: Function) => entryRenderers.push(type),
	registerMessageRenderer: (type: string, _renderer: Function) => messageRenderers.push(type),
	sendMessage: (message: any, options: any) => sent.push({ message, options }),
	appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	getThinkingLevel: () => thinkingLevel,
	setThinkingLevel: (level: string) => {
		thinkingLevel = clampLevel(level);
		thinkingLog.push(level);
	},
};

ultracode(pi as any);

/** Colourless theme: renderers are checked for content, not for escape codes. */
const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };

function makeCtx(
	options: {
		model?: any;
		branch?: any[];
		trusted?: boolean;
		registryModels?: any[];
		/** Models the session has credentials for; defaults to all of them. */
		authedModels?: any[];
		idle?: boolean;
		dead?: () => boolean;
		/** Make ui.custom reject, to check the panel hands the footer back anyway. */
		customRejects?: boolean;
		/** Resolve the panel with a PanelResult, as `R` (resume) does. */
		customResult?: { editorText: string; notice: string };
		/** Pretend to be a different pi session. */
		sessionId?: string;
	} = {},
) {
	const notices: Array<{ message: string; type: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const customs: Array<{ options: any }> = [];
	const editorText: string[] = [];
	// pi's context getters call assertActive() and THROW once the session they
	// belong to is replaced; `dead` reproduces that.
	const live = () => {
		if (options.dead?.()) throw new Error("Extension runtime is no longer active");
	};
	const ctx = {
		get cwd() {
			live();
			return CWD;
		},
		get hasUI() {
			live();
			return true;
		},
		get model() {
			live();
			return options.model;
		},
		isIdle: () => {
			live();
			return options.idle ?? true;
		},
		isProjectTrusted: () => {
			live();
			return options.trusted ?? true;
		},
		sessionManager: {
			getBranch: () => options.branch ?? [],
			getSessionFile: () => join(CWD, "session.jsonl"),
			// Real: /workflows scopes its list to this, so a fake without it made
			// the filter fall through to its ephemeral-session branch and the
			// scoping assertions pass without exercising the comparison.
			getSessionId: () => options.sessionId ?? E2E_SESSION,
		},
		modelRegistry: {
			getAll: () => options.registryModels ?? [],
			// Everything is authenticated unless a test says otherwise, so the
			// existing cases keep exercising the path they were written for.
			hasConfiguredAuth: (model: any) =>
				options.authedModels === undefined || options.authedModels.some((m) => m.provider === model.provider && m.id === model.id),
		},
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
			setEditorText: (text: string) => editorText.push(text),
			// The panel is recorded and closed at once: this harness checks that
			// /workflows reaches for it, not how it draws.
			custom: async (factory: any, mountOptions: any) => {
				customs.push({ options: mountOptions });
				if (options.customRejects) throw new Error("the component blew up");
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 40, columns: 120 } },
					theme,
					{},
					() => {},
				);
				component.dispose?.();
				if (!options.customResult) return undefined;
				// pi restores the editor's saved text before resolving this promise.
				// Reproducing that here is the only way to prove a caller writes the
				// panel's resume instruction *after* the await and not before.
				editorText.push(RESTORED_PROMPT);
				return options.customResult;
			},
		},
	};
	return { ctx, notices, statuses, widgets, customs, editorText };
}

/** What pi puts back in the prompt on the way out of an overlay:false component. */
/** The session id every makeCtx() reports unless told otherwise. */
const E2E_SESSION = "e2e-session";

const RESTORED_PROMPT = "«pi restored what was typed»";

const MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", name: "mini", reasoning: true, contextWindow: 200_000 };
const NO_REASONING = { provider: "x", id: "plain-model", name: "plain", reasoning: false, contextWindow: 32_000 };

const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ ultracode: block }));

/** One user turn: the input event, then before_agent_start with its context. */
async function turn(text: string, source = "interactive", ctx?: unknown) {
	await events.get("input")!({ type: "input", text, source });
	return events.get("before_agent_start")!({ type: "before_agent_start", prompt: text }, ctx ?? bareCtx);
}

/** Context for turns whose model registry does not matter. */
const bareCtx = makeCtx().ctx;

// --------------------------------------------------------------- registration

console.log("--- registration ---");
check("workflow tool registered", tools.has("workflow"), true);
check("workflow is sequential", tools.get("workflow")?.executionMode, "sequential");
check("workflow has prompt snippet", typeof tools.get("workflow")?.promptSnippet, "string");
check("description carries Ultracode section", tools.get("workflow")?.description.includes("**Ultracode.**"), true);
check("description explains background runs", tools.get("workflow")?.description.includes("run in the BACKGROUND"), true);
check("description routes models from the request", tools.get("workflow")?.description.includes("**Model routing.**"), true);
check(
	"routing section points at the triggering request",
	tools.get("workflow")?.description.includes("triggering request"),
	true,
);
// The posture assertions below are the point of the description, not decoration.
// The costly runs measured on this machine were four agents deep, not wide, and
// they were produced by a description that told the model to workflow every
// substantive task with cost no object. If either phrasing comes back, so does
// the spend — so both the absence of the old text and the presence of the
// depth-bounding section are asserted.
const description = tools.get("workflow")?.description ?? "";
check("description bounds agent depth", description.includes("**Bounding an agent.**"), true);
check("depth section says the prompt is the budget", description.includes("the prompt is the only budget"), true);
check("no standing instruction to always workflow", description.includes("for every substantive task"), false);
check("cost is not declared a non-constraint", description.toLowerCase().includes("cost is not a constraint"), false);
check(
	"ultracode section reads as permission, not instruction",
	description.includes("That is permission, not an instruction"),
	true,
);
check("subagents are told to stop when done", SUBAGENT_PREAMBLE.includes("Do what the task asks and then stop."), true);
// Measured: 142 of 151 assistant turns in a 53-minute workflow agent made
// exactly one tool call, and every turn re-read ~92k tokens of context. pi has
// always run batched calls concurrently; nothing told the model to batch. The
// line is duplicated from tool-batching/guideline.ts because a subagent spawns
// with --no-extensions and no extension can reach its system prompt.
check("and to batch independent tool calls", SUBAGENT_PREAMBLE.includes("independent tool calls in the same message"), true);
// This preamble once said "do not verify beyond what was asked", which was
// written to bound a research agent and read, to an implementer, as permission
// to ship unrun code. It did exactly that: an agent reported "pnpm check
// passes" for an application that never started. Self-verification is now
// carved out of the stop-early rule explicitly, and the old phrasing is
// asserted absent because its return would bring the behaviour back.
check("no instruction to skip verification", SUBAGENT_PREAMBLE.includes("do not verify beyond what was asked"), false);
check("checking your own work is not scope creep", SUBAGENT_PREAMBLE.includes("is NOT widening the scope"), true);
check("and observation beats intention", SUBAGENT_PREAMBLE.includes("Report what you observed, not what you intended"), true);

// The other half: the SCRIPT has to name a check the agent cannot satisfy by
// writing the checker.
// The prose-only version of this ("name a finish line the agent cannot move")
// was itself the weaker fix: it asked the model to pick a better criterion
// while leaving the VERDICT with the agent. shell() moves the verdict to the
// host, so the description must point at it and must not regress to prose.
check("description gates on facts, not claims", description.includes("**Gating on facts, not on claims.**"), true);
check("and names the mechanism", description.includes("Only shell() gives you a number the model never touched"), true);
check("with the null-exit gotcha", description.includes("exitCode === 0"), true);
check("shell() is in the globals list", description.includes("shell(command, opts?)"), true);
check("and names the closed loop by name", description.includes("are a closed loop"), true);
check("the measured failure is kept as evidence", description.includes("an application that did not start"), true);
// The other half of the same measurement. Bounding depth stops one agent
// grinding; it does not by itself make the run wide, and on this machine every
// implement phase came out one agent deep — 53 minutes and 177 turns for a
// prompt whose own bullet list was the fan-out — while discovery and review
// phases fanned out to three or four. Every pattern in the description reads or
// judges, so "workflow" read as "a way to review things". These assert the
// implementation half is present and says how to keep concurrent writers apart.
check("description says building fans out too", description.includes("**Implementing is fan-out too.**"), true);
check("and splits by file ownership", description.includes("ONE AGENT PER DELIVERABLE"), true);
check("ownership is stated in the prompt, not just the script", description.includes("Stating the ownership IN THE PROMPT"), true);
check("a bulleted prompt is named as the fan-out", description.includes("that list IS the fan-out"), true);
// The fan-out guidance briefly told the model to pass isolation: 'worktree' for
// agents sharing a file. No such option exists — AgentOptions has no isolation
// field, nothing reads one, and an unknown key is silently ignored rather than
// rejected — so two agents "isolated" that way would overwrite each other while
// the run reported done.
check("no invented isolation option", description.includes("isolation: 'worktree'"), false);
check("and the real constraint is stated", description.includes("There is NO worktree isolation"), true);
// Context budgeting was removed; buildContextBundle passes Infinity everywhere.
// The forking section promised trimming that no longer happens, which would have
// a script seed a 2MB bundle and fail every agent on the first request.
check("no promise of context budgeting", description.includes("Context is budgeted"), false);
check("and the absence is stated", description.includes("Nothing here is truncated"), true);
check("/ultracode registered", commands.has("ultracode"), true);
check("/workflows registered", commands.has("workflows"), true);
check("shift+down registered", shortcuts.has("shift+down"), true);
// /hotkeys prints this string; an empty one would list the key with no meaning.
check("the gesture describes itself", (shortcuts.get("shift+down")?.description?.length ?? 0) > 0, true);
check("entry renderer", entryRenderers, ["ultracode"]);
check("result message renderer", messageRenderers.includes("workflow-result"), true);
for (const name of ["session_start", "input", "before_agent_start", "thinking_level_select", "session_shutdown"]) {
	check(`hooks ${name}`, events.has(name), true);
}

console.log("\n--- routing named in the triggering prompt ---");
writeSettings({});
{
	const REGISTRY = [
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "anthropic", id: "claude-fable-5", name: "Fable 5" },
		{ provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
	];
	const { ctx } = makeCtx({ model: MODEL, registryModels: REGISTRY });
	events.get("session_start")!({}, ctx);

	const routed = await turn("ultracode, use sonnet for implementation and fable to review", "interactive", ctx);
	const content = routed?.message?.content as string;
	check("keyword reminder still first", content.startsWith(`<system-reminder>\n${KEYWORD_REMINDER}`), true);
	check("routing reminder rides the same turn", content.includes(`<system-reminder>\n${routingReminder(["sonnet", "fable"])}`), true);

	check(
		"no models named -> no routing reminder",
		(await turn("ultracode refactor the auth module", "interactive", ctx))?.message?.content,
		`<system-reminder>\n${KEYWORD_REMINDER}\n</system-reminder>`,
	);
	check("models named without a trigger -> nothing", await turn("is sonnet better than fable?", "interactive", ctx), undefined);
}

console.log("\n--- routing while the session mode is on ---");
{
	const REGISTRY = [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" }];
	const { ctx } = makeCtx({ model: MODEL, registryModels: REGISTRY });
	events.get("session_start")!({}, ctx);
	thinkingLevel = "medium";
	await commands.get("ultracode")!.handler("on", ctx);
	await turn("start working", "interactive", ctx); // consumes the full enter reminder
	const routed = await turn("audit the parser with haiku", "interactive", ctx);
	check(
		"mode turns pick up routing without the keyword",
		routed?.message?.content,
		`<system-reminder>\n${routingReminder(["haiku"])}\n</system-reminder>`,
	);
	await commands.get("ultracode")!.handler("off", ctx);
	await turn("done", "interactive", ctx); // drain the exit reminder
}

// -------------------------------------------------------------- keyword turns

console.log("\n--- keyword reminder ---");
writeSettings({});
{
	const { ctx } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	const result = await turn("ultracode review this repo");
	check("keyword -> hidden custom message", result?.message?.display, false);
	check("keyword -> customType", result?.message?.customType, "ultracode");
	check("keyword -> verbatim reminder", result?.message?.content, `<system-reminder>\n${KEYWORD_REMINDER}\n</system-reminder>`);
	check("plain turn -> nothing", await turn("now fix the tests"), undefined);
	check("rpc source -> nothing", await turn("ultracode this too", "rpc"), undefined);
	check("slash-led -> nothing", await turn("/effort ultracode"), undefined);
	check("quoted -> nothing", await turn('what does "ultracode" mean?'), undefined);
}

console.log("\n--- keyword trigger disabled in settings ---");
writeSettings({ keywordTrigger: false });
{
	const { ctx } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	check("keyword suppressed", await turn("ultracode review this"), undefined);
}

// ------------------------------------------------------------- session mode

console.log("\n--- /ultracode on: cadence ---");
writeSettings({});
{
	const { ctx, notices, statuses } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	thinkingLevel = "medium";
	thinkingLog.length = 0;
	appended.length = 0;

	await commands.get("ultracode")!.handler("on", ctx);
	check("thinking raised to xhigh", thinkingLog, ["xhigh"]);
	check("toggle entry appended", appended, [{ customType: "ultracode", data: { action: "on", previousLevel: "medium" } }]);
	check("badge set", statuses.at(-1), { key: "ultracode", text: "✦ ultracode" });
	check(
		"the success wording",
		notices.at(-1)?.message,
		"Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration",
	);

	const first = await turn("build the feature");
	check("first turn -> full reminder", first?.message?.content, `<system-reminder>\n${ENTER_FULL}\n</system-reminder>`);
	let quiet = true;
	for (let i = 0; i < 9; i++) quiet = quiet && (await turn(`turn ${i}`)) === undefined;
	check("turns 2-10 quiet", quiet, true);
	const eleventh = await turn("keep going");
	check("turn 11 -> sparse reminder", eleventh?.message?.content, `<system-reminder>\n${ENTER_SPARSE}\n</system-reminder>`);

	const keywordOnQuietTurn = await turn("ultracode audit everything");
	check(
		"keyword alone on a quiet-cadence turn",
		keywordOnQuietTurn?.message?.content,
		`<system-reminder>\n${KEYWORD_REMINDER}\n</system-reminder>`,
	);
	// Walk the cadence to the next sparse turn and land the keyword on it: the
	// combined message carries both reminders, keyword first.
	for (let i = 0; i < 8; i++) await turn(`quiet ${i}`);
	const combined = await turn("ultracode audit everything again");
	check(
		"keyword + sparse combine, keyword first",
		combined?.message?.content,
		`<system-reminder>\n${KEYWORD_REMINDER}\n</system-reminder>\n<system-reminder>\n${ENTER_SPARSE}\n</system-reminder>`,
	);

	await commands.get("ultracode")!.handler("status", ctx);
	check(
		"status wording",
		notices.at(-1)?.message,
		"Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)",
	);

	await commands.get("ultracode")!.handler("off", ctx);
	check("thinking restored", thinkingLevel, "medium");
	check("off entry appended", appended.at(-1), { customType: "ultracode", data: { action: "off" } });
	check("badge cleared", statuses.at(-1), { key: "ultracode", text: undefined });
	const exitTurn = await turn("continue");
	check("exit reminder delivered once", exitTurn?.message?.content, `<system-reminder>\n${EXIT}\n</system-reminder>`);
	check("then quiet", await turn("continue again"), undefined);
}

console.log("\n--- /ultracode guards ---");
{
	// pi clamps xhigh below the bar on this model: refuse and revert.
	clampLevel = (level) => (level === "xhigh" ? "high" : level);
	thinkingLevel = "medium";
	thinkingLog.length = 0;
	const { ctx, notices } = makeCtx({ model: NO_REASONING });
	events.get("session_start")!({}, ctx);
	await commands.get("ultracode")!.handler("on", ctx);
	check("clamped-below-xhigh model refused", notices.at(-1)?.message.includes("doesn't support"), true);
	check("level reverted", thinkingLevel, "medium");
	check("mode not entered", await turn("hello"), undefined);
	clampLevel = (level) => level;
}
{
	// pi clamps xhigh UP to max on models that go that high: accepted, reported honestly.
	clampLevel = (level) => (level === "xhigh" ? "max" : level);
	thinkingLevel = "medium";
	const { ctx, notices } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	await commands.get("ultracode")!.handler("on", ctx);
	check(
		"clamp-to-max accepted with honest wording",
		notices.at(-1)?.message,
		"Set effort level to ultracode (this session only): max + dynamic workflow orchestration",
	);
	// Deliver the enter reminder, then change away from the APPLIED level
	// (max): the mode exits and owes one exit notice.
	await turn("announce it");
	await events.get("thinking_level_select")!({ level: "high", previousLevel: "max" }, ctx);
	check("manual change off max exits", await turn("next up"), {
		message: {
			customType: "ultracode",
			content: `<system-reminder>\n${EXIT}\n</system-reminder>`,
			display: false,
		},
	});
	clampLevel = (level) => level;
}
{
	const { ctx, notices } = makeCtx({ model: undefined });
	events.get("session_start")!({}, ctx);
	await commands.get("ultracode")!.handler("on", ctx);
	check("no model refused", notices.at(-1)?.message, "Ultracode needs a model selected.");
}
{
	const { ctx, notices } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	await commands.get("ultracode")!.handler("sideways", ctx);
	check("invalid argument message", notices.at(-1)?.message, "Invalid argument: sideways. Valid options are: on, off, status");
}

console.log("\n--- thinking change exits the mode ---");
{
	const { ctx } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	thinkingLevel = "high";
	await commands.get("ultracode")!.handler("on", ctx);
	await turn("announce it");
	appended.length = 0;
	await events.get("thinking_level_select")!({ level: "low", previousLevel: "xhigh" }, ctx);
	check("exit entry appended", appended, [{ customType: "ultracode", data: { action: "off" } }]);
	const exitTurn = await turn("next");
	check("exit reminder after manual change", exitTurn?.message?.content, `<system-reminder>\n${EXIT}\n</system-reminder>`);
}

console.log("\n--- restore from branch ---");
{
	// Reminders persist as type "custom_message" entries — the shape pi's
	// session manager writes for before_agent_start-injected messages.
	const reminderEntry = (text: string) => ({
		type: "custom_message",
		customType: "ultracode",
		content: `<system-reminder>\n${text}\n</system-reminder>`,
		display: false,
	});
	const userMessage = { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
	const branch = [
		{ type: "custom", customType: "ultracode", data: { action: "on", previousLevel: "low" } },
		userMessage,
		reminderEntry(ENTER_FULL),
		...Array.from({ length: 9 }, () => userMessage),
	];
	const { ctx } = makeCtx({ model: MODEL, branch });
	events.get("session_start")!({}, ctx);
	const next = await turn("resumed turn");
	check("resume continues cadence at sparse", next?.message?.content, `<system-reminder>\n${ENTER_SPARSE}\n</system-reminder>`);

	// previousLevel rides the toggle entry, so restore works across resume.
	thinkingLevel = "xhigh";
	thinkingLog.length = 0;
	await commands.get("ultracode")!.handler("off", ctx);
	check("off after resume restores the pre-ultracode level", thinkingLog, ["low"]);

	// Off-toggle recorded, but the exit notice never went out: deliver on resume.
	const exitPendingBranch = [...branch, { type: "custom", customType: "ultracode", data: { action: "off" } }];
	const pending = makeCtx({ model: MODEL, branch: exitPendingBranch });
	events.get("session_start")!({}, pending.ctx);
	const resumed = await turn("hello again");
	check("pending exit reminder delivered after resume", resumed?.message?.content, `<system-reminder>\n${EXIT}\n</system-reminder>`);

	// Exit already delivered before the session ended: stay quiet.
	const settledBranch = [...exitPendingBranch, reminderEntry(EXIT)];
	const settled = makeCtx({ model: MODEL, branch: settledBranch });
	events.get("session_start")!({}, settled.ctx);
	check("resume after delivered exit stays quiet", await turn("hello"), undefined);

	// Array-form content restores the same way as string content.
	const arrayBranch = [
		{ type: "custom", customType: "ultracode", data: { action: "on" } },
		userMessage,
		{
			type: "custom_message",
			customType: "ultracode",
			content: [{ type: "text", text: `<system-reminder>\n${ENTER_FULL}\n</system-reminder>` }],
			display: false,
		},
	];
	const arrayCase = makeCtx({ model: MODEL, branch: arrayBranch });
	events.get("session_start")!({}, arrayCase.ctx);
	check("array-content reminder restores announced state", await turn("go"), undefined);
}

// ------------------------------------------------------------- workflow tool

console.log("\n--- workflow tool: wait mode ---");
{
	const tool = tools.get("workflow")!;
	const { ctx } = makeCtx({ model: MODEL });
	const script = [
		"export const meta = { name: 'demo', description: 'no agents', phases: [{ title: 'Go' }] }",
		"phase('Go')",
		"log('working')",
		"return { answer: args.n * 2 }",
	].join("\n");
	const result = await tool.execute("t1", { script, args: { n: 21 }, wait: true }, undefined, undefined, ctx);
	const text = result.content[0].text as string;
	check("summary line", /^Workflow "demo" \(wf-[a-z0-9]+-\d+\) finished: 0 agents/.test(text), true);
	check("result JSON in content", text.includes('"answer": 42'), true);
	check("details status done", result.details.status, "done");
	check("phase recorded in details", result.details.phases.map((p: any) => p.title), ["Go"]);
	check("log recorded in details", result.details.logs, ["working"]);
	check("wait mode does not sendMessage", sent.length, 0);

	const bad = await tool.execute("t2", { script: "return 1" }, undefined, undefined, ctx).then(
		() => "no-throw",
		(error: Error) => error.message,
	);
	check("missing meta -> error", bad, "workflow script must begin with `export const meta = {...}`");

	const controller = new AbortController();
	controller.abort();
	const abortScript = `export const meta = { name: 'a', description: 'b' }\nreturn await agent('x')`;
	const abortedRun = await tool.execute("t3", { script: abortScript, wait: true }, controller.signal, undefined, ctx).then(
		() => "no-throw",
		(error: Error) => error.message,
	);
	check("pre-aborted wait -> Workflow aborted", abortedRun, "Workflow aborted");

	// A circular return value must not turn a finished run into a failure.
	const circularScript = [
		"export const meta = { name: 'circ', description: 'circular result' }",
		"const a = { name: 'a' }",
		"a.self = a",
		"return a",
	].join("\n");
	const circular = await tool.execute("t4", { script: circularScript, wait: true }, undefined, undefined, ctx);
	check("circular result still succeeds", circular.details.status, "done");
	check("circular marker in content", circular.content[0].text.includes('"self": "[circular]"'), true);

	// An unresolvable model reference fails that agent before any spawn, and the
	// script is free to return anyway — here it returns the null that agent()
	// handed back. This used to be reported as a successful run with a null
	// result, which is how five runs in the real store recorded total failure as
	// "done": the script returning says nothing about the work happening. With
	// no agent left standing the run is now a failure, and the reason travels
	// with it instead of sitting only in the logs.
	const badModelScript = [
		"export const meta = { name: 'routing', description: 'bad model reference' }",
		"return await agent('x', { model: 'nope' })",
	].join("\n");
	let routedError = "";
	try {
		await tool.execute(
			"t5",
			{ script: badModelScript, wait: true },
			undefined,
			undefined,
			makeCtx({ model: MODEL, registryModels: [MODEL] }).ctx,
		);
	} catch (error) {
		routedError = error instanceof Error ? error.message : String(error);
	}
	check("unresolvable reference -> the run fails", routedError.includes("produced nothing"), true);
	check("resolution error reaches the caller", routedError.includes('"nope" matched no available model'), true);
	check("and it is offered a resume rather than a rewrite", routedError.includes("rather than writing a new workflow"), true);
	const routedId = /\(([a-z0-9-]+)\)/.exec(routedError)?.[1];
	check("recorded on disk as a failure", readMeta(AGENT, routedId ?? "")?.status, "error");
}

console.log("\n--- workflow tool: background ---");
{
	const tool = tools.get("workflow")!;
	const { ctx, notices } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx); // panel announces through this ctx
	sent.length = 0;
	busEmitted.length = 0;
	/** The `lines` payload of every panel announcement so far, in order. */
	const announced = () =>
		busEmitted
			.filter((e) => e.channel === PANEL_CHANNEL)
			.map((e) => (e.data as { lines?: string[] }).lines);
	const script = [
		"export const meta = { name: 'bg', description: 'background demo' }",
		"log('ticking')",
		"await new Promise((resolve) => setTimeout(resolve, 50))",
		"return { ok: true }",
	].join("\n");
	const immediate = await tool.execute("t6", { script }, undefined, undefined, ctx);
	const startText = immediate.content[0].text as string;
	check("returns immediately with run id", /started in the background \(id: wf-[a-z0-9]+-\d+\)/.test(startText), true);
	check("warns against fabricating results", startText.includes("do not fabricate"), true);
	check("background details flag", immediate.details.background, true);
	check("panel announced the run", announced().some((lines) => lines?.some((l) => l.includes("bg"))), true);

	// The result message arrives once the run settles.
	for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	check("result delivered as workflow-result", sent[0]?.message.customType, "workflow-result");
	check("delivery content carries the result", sent[0]?.message.content.includes('"ok": true'), true);
	check("delivered message is visible", sent[0]?.message.display, true);
	check("idle delivery triggers a turn", sent[0]?.options, { triggerTurn: true });
	// Guard the "cleared" check with a non-empty assertion: against an empty log
	// `.at(-1)` is undefined too, so the clear would pass without anything having
	// been announced at all.
	check("panel announced at least once", announced().length > 0, true);
	check("panel cleared when quiet", announced().at(-1), undefined);

	// Spend is announced per subagent turn, for anyone totting up what the
	// session cost — /usage is the subscriber, and it has no other way to learn
	// about background agents, which are separate processes that never touch
	// this transcript. These scripts spawn no agents, so the assertion here is
	// the one that can be made without a live model: nothing is announced for a
	// run that spent nothing, and in particular the settle path does not invent
	// a summary event.
	const spend = () => busEmitted.filter((e) => e.channel === SPEND_CHANNEL);
	check("an agentless run announces no spend", spend().length, 0);

	// A `/new` in the same process must start from zero. Without the registry
	// being cleared on shutdown, the fresh session opens still holding the
	// previous one's runs — its footer lines, and anything else that reads them.
	// Observable through the registry: a run it still knows reports "already
	// finished", one it has forgotten reports "not running in this session".
	busEmitted.length = 0;
	const backgroundId = /id: (wf-[a-z0-9]+-\d+)/.exec(startText)![1]!;
	await commands.get("workflows")!.handler(`pause ${backgroundId}`, ctx);
	check("before shutdown the run is still known", notices.at(-1)?.message.includes("has finished"), true);
	events.get("session_shutdown")!({}, ctx);
	await commands.get("workflows")!.handler(`pause ${backgroundId}`, ctx);
	check("after shutdown it is forgotten", notices.at(-1)?.message.includes("not running in this session"), true);
	check("shutdown announces no spend", spend().length, 0);
	check("the footer's run lines are cleared too", announced().at(-1), undefined);
}

console.log("\n--- workflow tool: a background run announces what it spends ---");
{
	// The one assertion that actually exercises the spend path end to end:
	// engine -> spawn -> JSONL parse -> applyTurn -> onUsage -> announceSpend ->
	// the bus. Everything else stopped short of it — the unit test checks
	// applyTurn in isolation, the other e2e scripts spawn no agents, and the live
	// test reads run.json, which persist() writes regardless. Deleting the emit
	// left all 18 suites green, so the central claim of the whole change was
	// unguarded.
	//
	// A fake `pi` stands in for the real binary: piInvocation() runs
	// process.argv[1] under node, so pointing that at a script which prints one
	// message_end and exits gives a genuine subprocess without a model.
	const fakePi = join(ROOT, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const usage = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, reasoning: 150, totalTokens: 6200, cost: { total: 0.25 } };",
			'const message = { role: "assistant", content: [{ type: "text", text: "done" }], usage, stopReason: "stop" };',
			'process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");',
		].join("\n"),
	);
	const realArgv1 = process.argv[1];
	process.argv[1] = fakePi;

	const tool = tools.get("workflow")!;
	const { ctx } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	busEmitted.length = 0;
	const script = [
		"export const meta = { name: 'spender', description: 'one agent' }",
		"const text = await agent('say something')",
		"return { text }",
	].join("\n");

	try {
		const sync = await tool.execute("t-spend", { script, wait: true }, undefined, undefined, ctx);
		const spend = busEmitted.filter((e) => e.channel === SPEND_CHANNEL).map((e) => e.data as SpendEvent);
		// wait: true attaches usage to the tool result instead, so this path must
		// stay silent or the same tokens get billed twice.
		check("a wait:true run announces nothing", spend.length, 0);
		// ...and the tool result it attaches has to carry every field, reasoning
		// included. Dropping it made the same fleet report different thinking
		// totals depending only on `wait`.
		check("its tool result carries the spend", sync.usage?.cost?.total, 0.25);
		check("including the reasoning tokens", sync.usage?.reasoning, 150);

		busEmitted.length = 0;
		const immediate = await tool.execute("t-spend-bg", { script }, undefined, undefined, ctx);
		const runId = /id: (wf-[a-z0-9]+-\d+)/.exec(immediate.content[0].text)![1]!;
		for (let i = 0; i < 200 && !busEmitted.some((e) => e.channel === SPEND_CHANNEL); i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const bg = busEmitted.filter((e) => e.channel === SPEND_CHANNEL).map((e) => e.data as SpendEvent);
		check("a background run announces its spend", bg.length > 0, true);
		// Against the constant, not a copy of its value. The literal here pinned the
		// old name and failed the suite when the source was deliberately renamed to
		// match the tool — which is the property that keeps /usage showing one
		// workflow row rather than two.
		check("under the shared source name", bg[0]?.source, SPEND_SOURCE);
		check("carrying the flat cost", bg[0]?.usage.cost, 0.25);
		check("and the reasoning tokens", bg[0]?.usage.reasoning, 150);
		check("counted as a call", bg[0]?.calls, 1);
		// Named per run, which is what gives /usage a row per workflow — the only
		// place per-run cost is reported now that no /workflows surface prints one.
		check("and named for the run it came from", bg[0]?.detail?.startsWith("spender ("), true);
		check("the run is real", runId.startsWith("wf-"), true);

		// A wait:true run that FAILS attaches no usage — pi builds the error tool
		// result itself and it carries none — so the spend has to come out the
		// announcement door instead, or four minutes of agents vanish from every
		// total. Exclusive with the success path, which announces nothing.
		busEmitted.length = 0;
		const failing = [
			"export const meta = { name: 'doomed', description: 'spends then fails' }",
			"await agent('say something')",
			"throw new Error('deliberate')",
		].join("\n");
		await tool.execute("t-spend-fail", { script: failing, wait: true }, undefined, undefined, ctx).catch(() => undefined);
		const failed = busEmitted.filter((e) => e.channel === SPEND_CHANNEL).map((e) => e.data as SpendEvent);
		check("a failed wait:true run still reports its spend", failed.length, 1);
		check("as the run's whole total", failed[0]?.usage.cost, 0.25);
		check("named the same way", failed[0]?.detail?.startsWith("doomed ("), true);
	} finally {
		process.argv[1] = realArgv1;
	}
}

console.log("\n--- workflow tool: /workflows, pause, cancel ---");
{
	const tool = tools.get("workflow")!;
	const { ctx, notices, customs } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	sent.length = 0;
	const script = [
		"export const meta = { name: 'sleeper', description: 'cancellable' }",
		"await new Promise((resolve) => setTimeout(resolve, 2000))",
		"return 'slept'",
	].join("\n");
	const immediate = await tool.execute("t7", { script }, undefined, undefined, ctx);
	const runId = /id: (wf-[a-z0-9]+-\d+)/.exec(immediate.content[0].text)![1]!;

	// Bare /workflows takes the editor's place, the way an ask_user question does.
	busEmitted.length = 0;
	await commands.get("workflows")!.handler("", ctx);
	check("/workflows takes the editor's place", customs.at(-1)?.options?.overlay, false);
	check("and does not position itself as an overlay", customs.at(-1)?.options?.overlayOptions, undefined);
	/** Both edges of the "the panel owns the bottom of the screen" announcement. */
	const panelOpenEdges = () =>
		busEmitted.filter((e) => e.channel === PANEL_OPEN_CHANNEL).map((e) => (e.data as { active: boolean }).active);
	check("it announces itself so the footer stands down", panelOpenEdges(), [true, false]);

	// A component that throws must still hand the footer back, or the statusline
	// stays blank for the rest of the session.
	{
		const { ctx: broken } = makeCtx({ model: MODEL, customRejects: true });
		busEmitted.length = 0;
		const outcome = await commands
			.get("workflows")!
			.handler("", broken)
			.then(() => "resolved")
			.catch((error: Error) => error.message);
		check("a panel that blows up propagates", outcome, "the component blew up");
		check("and still hands the footer back", panelOpenEdges(), [true, false]);
	}

	// The run this session started is listed; one from another session is not,
	// even though it is in the same store. `show <id>` still reads it, because
	// you had to type the id and that is how an interrupted run gets inspected
	// before being resumed.
	{
		const foreign = "wf-fromelsewhere-1";
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 };
		createRun(
			AGENT,
			{ runId: foreign, name: "someone-elses", status: "done", cwd: CWD, pid: 1, startedAt: 0, endedAt: 1, agentCount: 0, usage, sessionId: "another" },
			"s",
		);
		await commands.get("workflows")!.handler("list", ctx);
		check("another session's run is not listed", notices.at(-1)?.message.includes("someone-elses"), false);
		await commands.get("workflows")!.handler(`show ${foreign}`, ctx);
		check("but show still reads it", notices.at(-1)?.message.includes("someone-elses"), true);
		check("and says where it came from", notices.at(-1)?.message.includes("from another session"), true);
	}

	await commands.get("workflows")!.handler("list", ctx);
	// Name first — it is the readable part — with the id kept at the end, since
	// this report is where you copy the id the subcommands below want.
	check("/workflows list leads with the name", notices.at(-1)?.message.includes("◆ sleeper —"), true);
	check("and still carries the id to address it by", notices.at(-1)?.message.includes(`[${runId}]`), true);

	// Completing by NAME is the point: the subcommands address runs by id, but
	// nobody knows a run as wf-<base36>. What you read is the name; what gets
	// inserted is the id the handler can resolve.
	{
		const complete = (prefix: string) => commands.get("workflows")!.getArgumentCompletions!(prefix) as Array<{ value: string; label: string }>;
		const byName = complete("cancel sleep");
		check("typing the name finds the run", byName.length, 1);
		// Name plus start time, the same disambiguator the panel rows carry: five
		// runs called `code-review` must not offer five identical entries that
		// each insert a different id.
		check("the label reads as the name", byName[0]?.label.startsWith("cancel sleeper ("), true);
		check("and carries a start time to tell duplicates apart", /\(\d\d:\d\d\)$/.test(byName[0]!.label), true);
		check("but the id is what is inserted", byName[0]?.value, `cancel ${runId}`);
		check("typing the id still works", complete(`cancel ${runId}`).length, 1);
		// The bare verb leads, then one entry per run it could apply to.
		const verbs = complete("pa");
		check("the bare verb still completes first", verbs[0]?.value, "pause");
		check("and every following option is that verb", verbs.every((option) => option.label.startsWith("pause")), true);
	}

	await commands.get("workflows")!.handler(`pause ${runId}`, ctx);
	check("pause acknowledged", notices.at(-1)?.message.startsWith(`${runId} pausing`), true);
	await commands.get("workflows")!.handler(`resume ${runId}`, ctx);
	check("resume acknowledged", notices.at(-1)?.message, `${runId} resumed.`);
	await commands.get("workflows")!.handler("pause", ctx);
	check("pause needs an id", notices.at(-1)?.message, "Usage: /workflows pause <id>");

	await commands.get("workflows")!.handler(`show ${runId}`, ctx);
	check("show reports the store path", notices.at(-1)?.message.includes(`workflow-runs/${runId}`), true);

	await commands.get("workflows")!.handler(`cancel ${runId}`, ctx);
	check("cancel acknowledged", notices.at(-1)?.message, `Cancelling ${runId}`);

	for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	check("cancelled run reports back", sent[0]?.message.content.includes("was cancelled"), true);
	check("cancelled run offers a resume", sent[0]?.message.content.includes(`resumeFromRunId: "${runId}"`), true);

	await commands.get("workflows")!.handler(`cancel ${runId}`, ctx);
	check("cancel after finish", notices.at(-1)?.message, `${runId} already finished.`);
	await commands.get("workflows")!.handler("cancel wf-99", ctx);
	check("cancel unknown", notices.at(-1)?.message, "wf-99 is not running in this session. /workflows list shows every run.");
	await commands.get("workflows")!.handler("show wf-99", ctx);
	check("show unknown", notices.at(-1)?.message, "No run wf-99. /workflows list shows this session's runs.");
	await commands.get("workflows")!.handler("bogus", ctx);
	check("invalid /workflows argument", notices.at(-1)?.message, "Invalid argument: bogus. Usage: /workflows [list|show|pause|resume|cancel [id]]");
}

console.log("\n--- shift+down opens the same panel /workflows does ---");
{
	const gesture = shortcuts.get("shift+down")!.handler;

	// The whole point of two doors: they must reach the identical code path.
	const runDoor = async (open: (ctx: any) => Promise<unknown>) => {
		const { ctx, customs, editorText } = makeCtx({ model: MODEL });
		events.get("session_start")!({}, ctx);
		busEmitted.length = 0;
		await open(ctx);
		return { customs, editorText, bus: busEmitted.map((entry) => entry.channel) };
	};

	const viaKey = await runDoor((ctx) => gesture(ctx));
	check("the gesture mounts one panel", viaKey.customs.length, 1);
	check("in the editor's slot, not as an overlay", viaKey.customs[0]?.options, { overlay: false });
	check(
		"and announces both edges so the footer stands down",
		busEmitted.filter((e) => e.channel === PANEL_OPEN_CHANNEL).map((e) => (e.data as { active: boolean }).active),
		[true, false],
	);

	const viaCommand = await runDoor((ctx) => commands.get("workflows")!.handler("", ctx));
	check("both doors mount the same thing", viaKey.customs, viaCommand.customs);
	check("and emit the same events in the same order", viaKey.bus, viaCommand.bus);

	// `R` hands a resume instruction back as the result rather than writing it
	// from inside the panel, because pi overwrites the prompt on the way out.
	const resumed = { editorText: "resume wf-1", notice: "Resume instruction ready" };
	for (const [label, open] of [
		["the gesture", (ctx: any) => gesture(ctx)],
		["/workflows", (ctx: any) => commands.get("workflows")!.handler("", ctx)],
	] as const) {
		const { ctx, editorText, notices } = makeCtx({ model: MODEL, customResult: resumed });
		events.get("session_start")!({}, ctx);
		await open(ctx);
		check(`${label}: the resume instruction outlives pi's restore`, editorText, [RESTORED_PROMPT, resumed.editorText]);
		check(`${label}: and says so`, notices.at(-1)?.message, resumed.notice);
	}

	// The shortcut's ctx is rebuilt per keypress and has none of the assertActive
	// getters, so storing it as the panel's drawing context would silently retire
	// the panel. Drawing must still go through the session's own context.
	{
		const { ctx: live } = makeCtx({ model: MODEL });
		events.get("session_start")!({}, live);
		let gone = false;
		const { ctx: transient } = makeCtx({ model: MODEL, dead: () => gone });
		await gesture(transient);
		// The keypress context is now the kind pi throws from. Opening again draws
		// the panel — through the session's context if the gesture kept its hands
		// off uiCtx, through nothing at all if it did not.
		gone = true;
		busEmitted.length = 0;
		await gesture(transient);
		check("the gesture's context never becomes the drawing context", busEmitted.some((e) => e.channel === PANEL_CHANNEL), true);
	}
}

console.log("\n--- workflow tool: the run store ---");
{
	const tool = tools.get("workflow")!;
	const { ctx } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	const script = [
		"export const meta = { name: 'stored', description: 'leaves a trail' }",
		"phase('Only')",
		"log('a line')",
		"return { n: 1 }",
	].join("\n");
	const result = await tool.execute("t11", { script, wait: true }, undefined, undefined, ctx);
	const runId = result.details.runId as string;
	const dir = join(AGENT, "workflow-runs", runId);

	check("run directory exists", existsSync(dir), true);
	check("script is stored verbatim", readFileSync(join(dir, "script.js"), "utf8"), script);
	const meta = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
	check("run.json records the outcome", meta.status, "done");
	check("run.json records the owning pid", meta.pid, process.pid);
	const journal = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	check("journal records start and end", [journal[0].event, journal.at(-1).event], ["start", "end"]);
	check("journal records the phase", journal.some((record: any) => record.kind === "phase" && record.title === "Only"), true);
	check("journal records the log line", journal.some((record: any) => record.kind === "log" && record.message === "a line"), true);
	check("journal sequence is monotonic", journal.every((record: any, i: number) => i === 0 || record.seq > journal[i - 1].seq), true);

	// Resuming with no agents to replay still runs and records its lineage.
	const resumed = await tool.execute("t12", { wait: true, resumeFromRunId: runId }, undefined, undefined, ctx);
	check("resume reuses the stored script", resumed.details.name, "stored");
	check("resume records its parent", resumed.details.resumedFrom, runId);
	check("resume reproduced the result", (resumed.content[0].text as string).includes('"n": 1'), true);

	// A saved workflow can be run by name.
	mkdirSync(join(AGENT, "workflows"), { recursive: true });
	writeFileSync(join(AGENT, "workflows", "saved.js"), `export const meta = { name: 'saved', description: 'from disk' }\nreturn 'hi'`);
	const byName = await tool.execute("t13", { name: "saved", wait: true }, undefined, undefined, ctx);
	check("a saved workflow runs by name", (byName.content[0].text as string).includes('"hi"'), true);
	const missing = await tool
		.execute("t14", { name: "nope", wait: true }, undefined, undefined, ctx)
		.then(() => "no-throw", (error: Error) => error.message);
	check("an unknown saved name is an error", missing.includes('no saved workflow named "nope"'), true);

	// A syntax error must fail the CALL, not arrive later as a failed run.
	const broken = await tool
		.execute("t15", { script: `export const meta = { name: 'b', description: 'b' }\nreturn (` }, undefined, undefined, ctx)
		.then(() => "no-throw", (error: Error) => error.message);
	check("a syntax error fails the tool call", broken.startsWith("workflow script does not compile"), true);
}

console.log("\n--- workflow tool: mid-turn delivery and model pinning ---");
{
	const tool = tools.get("workflow")!;
	// Agent busy: the result must ride the current turn as a follow-up.
	const { ctx } = makeCtx({ model: MODEL, idle: false });
	events.get("session_start")!({}, ctx);
	sent.length = 0;
	const script = `export const meta = { name: 'midturn', description: 'busy agent' }\nreturn 'ok'`;
	await tool.execute("t8", { script }, undefined, undefined, ctx);
	for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	check("busy agent gets a follow-up", sent[0]?.options, { deliverAs: "followUp" });

	// A bad configured default fails the run at start, rather than nulling
	// every agent into a success-shaped empty result.
	writeSettings({ model: "sonet" });
	const badDefault = makeCtx({ model: MODEL, registryModels: [MODEL] });
	events.get("session_start")!({}, badDefault.ctx);
	const outcome = await tool
		.execute("t9", { script: `export const meta = { name: 'x', description: 'y' }\nreturn 1` }, undefined, undefined, badDefault.ctx)
		.then(() => "no-throw", (error: Error) => error.message);
	check("unresolvable default fails the run", outcome.includes('model "sonet" matched no available model'), true);
	writeSettings({});

	// A non-string model option is rejected with a routing-specific message.
	// Its only agent dies, so the run is a failure and the message comes back on
	// the error rather than being left for someone to find in the logs.
	const guard = makeCtx({ model: MODEL, registryModels: [MODEL] });
	events.get("session_start")!({}, guard.ctx);
	const guarded = await tool
		.execute(
			"t10",
			{ script: `export const meta = { name: 'g', description: 'h' }\nreturn await agent('x', { model: 42 })`, wait: true },
			undefined,
			undefined,
			guard.ctx,
		)
		.then(() => "no-throw", (error: Error) => error.message);
	check("non-string model reference is named as such", guarded.includes("model must be a string reference, got number"), true);
	check("and the run does not pass as done", guarded.includes("produced nothing"), true);

	// A model that exists but has no credentials. This used to resolve happily,
	// spawn every agent, and kill each one on "No API key found for kimi-coding"
	// — the reason buried in per-agent stderr, discovered three deaths later.
	const KIMI = { provider: "kimi-coding", id: "kimi-for-coding", name: "Kimi for Coding", contextWindow: 1000, maxTokens: 100 };
	const noKey = makeCtx({ model: MODEL, registryModels: [MODEL, KIMI], authedModels: [MODEL] });
	events.get("session_start")!({}, noKey.ctx);
	const unauthed = await tool
		.execute(
			"t11",
			{
				script: `export const meta = { name: 'k', description: 'k' }\nreturn await agent('x', { model: 'kimi-for-coding' })`,
				wait: true,
			},
			undefined,
			undefined,
			noKey.ctx,
		)
		.then(() => "no-throw", (error: Error) => error.message);
	check("an unauthenticated provider fails at resolution", unauthed.includes("no credentials for kimi-coding"), true);
	check("and says how to fix it", unauthed.includes("/login"), true);
	// The failure must arrive before anything is spawned, not after N deaths.
	check("without spawning anything", unauthed.includes("produced nothing"), true);

	// An authenticated model still resolves normally through the same path.
	const fine = await tool
		.execute(
			"t12",
			{ script: `export const meta = { name: 'ok', description: 'ok' }\nreturn 1`, wait: true },
			undefined,
			undefined,
			noKey.ctx,
		)
		.then((r: any) => r.details.status, (error: Error) => error.message);
	check("authenticated models are unaffected", fine, "done");
}

console.log("\n--- panel survives a dead session ---");
{
	const tool = tools.get("workflow")!;
	let dead = false;
	const { ctx } = makeCtx({ model: MODEL, dead: () => dead });
	events.get("session_start")!({}, ctx);
	sent.length = 0;
	const script = [
		"export const meta = { name: 'outlives', description: 'settles after shutdown' }",
		"await new Promise((resolve) => setTimeout(resolve, 60))",
		"return 'late'",
	].join("\n");
	await tool.execute("t11", { script }, undefined, undefined, ctx);

	// The session goes away mid-run: shutdown cancels, then the context dies.
	events.get("session_shutdown")!({}, ctx);
	dead = true;
	// The run settles against the dead session; nothing may throw out of it.
	let escaped: unknown;
	const watcher = (error: unknown) => void (escaped = error);
	process.on("uncaughtException", watcher);
	process.on("unhandledRejection", watcher);
	await new Promise((resolve) => setTimeout(resolve, 250));
	process.removeListener("uncaughtException", watcher);
	process.removeListener("unhandledRejection", watcher);
	check("no error escapes a settle on a dead session", escaped, undefined);
	check("no result delivered to a dead session", sent.length, 0);
}

console.log("\n--- resumed session is told about interrupted runs ---");
{
	// A run left behind by a process that is gone: status "running" on disk with
	// a pid nothing owns. session_start reconciles it and the next turn says so.
	const orphanDir = join(AGENT, "workflow-runs", "wf-orphan-1");
	mkdirSync(orphanDir, { recursive: true });
	writeFileSync(
		join(orphanDir, "run.json"),
		JSON.stringify({
			runId: "wf-orphan-1",
			name: "audit",
			status: "running",
			cwd: CWD,
			pid: 999_999,
			startedAt: Date.now(),
			agentCount: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5, totalTokens: 0, turns: 2 },
		}),
	);

	const { ctx } = makeCtx({ model: MODEL });
	events.get("session_start")!({}, ctx);
	check("the store marks it interrupted", JSON.parse(readFileSync(join(orphanDir, "run.json"), "utf8")).status, "interrupted");

	const correction = await turn("what did the audit find?");
	check(
		"correction injected once",
		correction?.message?.content.includes("wf-orphan-1 did not survive the end of the previous session"),
		true,
	);
	check("and it names the resume path", correction?.message?.content.includes('resumeFromRunId: "wf-orphan-1"'), true);
	check("and not repeated", await turn("anything else?"), undefined);

	// A run owned by a LIVE process belongs to another session: leave it alone.
	const liveDir = join(AGENT, "workflow-runs", "wf-live-1");
	mkdirSync(liveDir, { recursive: true });
	writeFileSync(
		join(liveDir, "run.json"),
		JSON.stringify({
			runId: "wf-live-1",
			name: "other",
			status: "running",
			cwd: CWD,
			pid: process.pid,
			startedAt: Date.now(),
			agentCount: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
		}),
	);
	events.get("session_start")!({}, makeCtx({ model: MODEL }).ctx);
	check("a live run is left alone", JSON.parse(readFileSync(join(liveDir, "run.json"), "utf8")).status, "running");
	// This session_start does produce a notice — wf-orphan-1 is still owed from
	// the block above, and repeating that until something resumes it is the
	// point. What matters is that the LIVE run is not in it: another session is
	// working on it, and reporting it dead would send this one to resume a run
	// that is still going.
	const liveTurn = await turn("still there?");
	const liveContent = liveTurn?.message?.content ?? "";
	check("the live run is not named", liveContent.includes("wf-live-1"), false);
	check("while the run still owed is", liveContent.includes("wf-orphan-1"), true);
	// Repeating across sessions, not within one: the note is set at
	// session_start and cleared once delivered.
	check("and still only once per session", await turn("anything else?"), undefined);
}

rmSync(ROOT, { recursive: true, force: true });
// ---------------------------------------------------------------- orphaning

console.log("\n--- a question raised over the panel does not orphan it ---");
{
	// pi's non-overlay mount just clears the editor container and adds the new
	// component, so an ask_user question drawn over the panel would leave it
	// running with its footer stood down for the rest of the session.
	const handlers = new Map<string, (data: unknown) => void>();
	const emitted: { channel: string; data: unknown }[] = [];
	let resolveCustom: ((v: unknown) => void) | undefined;
	let disposed = false;

	const pi = {
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
				handlers.get(channel)?.(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			},
		},
	} as never;

	const ctx = {
		ui: {
			custom: (factory: (t: unknown, th: unknown, k: unknown, done: (v: unknown) => void) => { dispose(): void }) =>
				new Promise((resolve) => {
					resolveCustom = resolve;
					const component = factory(
						{ requestRender: () => {}, terminal: { rows: 40 } },
						{ fg: (_k: string, t: string) => t, bold: (t: string) => t },
						{},
						(value: unknown) => { component.dispose(); resolve(value); },
					);
				}),
		},
	} as never;

	const { showWorkflows } = await import("./tui.ts");
	const { RunRegistry } = await import("./runs.ts");
	const dir = mkdtempSync(join(tmpdir(), "wf-orphan-"));

	const open = showWorkflows(pi, ctx, { agentDir: dir, registry: new RunRegistry(), notify: () => {} } as never);
	check("the footer is told to stand down", emitted.at(-1), { channel: "ultracode:panel-open", data: { active: true } });

	// The agent asks a question, drawing over the panel.
	handlers.get("ask-user:asking")?.({ active: true, blocking: true });

	// Race a timer: without the fix this promise never settles, and a test that
	// hangs reports nothing at all. Fail fast and say what happened instead.
	const HUNG = Symbol("hung");
	// Deliberately NOT unref'd: an unref'd timer lets node exit before it fires,
	// so a hung panel would end the suite silently instead of failing it. Cleared
	// as soon as the race settles so it cannot hold the process open either.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([open, new Promise((r) => { timer = setTimeout(() => r(HUNG), 2000); })]);
	if (timer) clearTimeout(timer);

	check("the panel resolves rather than hanging", result === HUNG ? "HUNG — the panel was orphaned" : result, undefined);
	if (result === HUNG) {
		rmSync(dir, { recursive: true, force: true });
	} else {
	check("and hands the footer back", emitted.at(-1), { channel: "ultracode:panel-open", data: { active: false } });
	// A closing announcement must NOT close it — only an opening one.
	check("exactly one open and one close", emitted.filter((e) => e.channel === "ultracode:panel-open").length, 2);
		rmSync(dir, { recursive: true, force: true });
	}
	void resolveCustom;
	void disposed;
}

console.log("\n--- a script can return cleanly while every agent died ---");
{
	// The most expensive defect in the run store: five runs whose every agent
	// died on spawn (an ambiguous model reference) were recorded "done", 0
	// turns, $0.00. agent() returns null on failure and the script is free to
	// carry on, so the SCRIPT succeeding says nothing about the work happening.
	// Told a workflow had succeeded, the model wrote a fresh one under a new
	// name and paid for the same discovery three and four times over.
	//
	// The fake pi fails only for prompts carrying BOOM, so one binary drives
	// both the total and the partial case.
	// An earlier block removes ROOT to prove the panel survives a dead session,
	// so this one cannot assume the tree is still there. CWD matters as much as
	// AGENT: a subagent is spawned with the run's cwd, and a missing one fails
	// the spawn with ENOENT before the fake pi is ever reached — which looks
	// exactly like the failure being tested and would have passed for the wrong
	// reason on two of these assertions.
	mkdirSync(AGENT, { recursive: true });
	mkdirSync(CWD, { recursive: true });
	const pickyPi = join(ROOT, "picky-pi.mjs");
	writeFileSync(
		pickyPi,
		[
			"const prompt = process.argv[process.argv.length - 1];",
			"if (prompt.includes('BOOM')) {",
			'  process.stderr.write(\'model "coding" matches several models — use a more specific id\\n\');',
			"  process.exit(1);",
			"}",
			"const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15, cost: { total: 0.01 } };",
			'const message = { role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" };',
			'process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");',
		].join("\n"),
	);
	const realArgv1 = process.argv[1];
	process.argv[1] = pickyPi;

	try {
		const tool = tools.get("workflow")!;
		const { ctx } = makeCtx({ model: MODEL });

		// Exactly the shape that used to report success: failures swallowed,
		// script returns a perfectly valid value.
		const allFail = [
			"export const meta = { name: 'allfail', description: 'every agent dies' }",
			"const out = await parallel([() => agent('BOOM one'), () => agent('BOOM two')])",
			"return { found: out.filter(Boolean).length }",
		].join("\n");

		let thrown = "";
		try {
			await tool.execute("t-allfail", { script: allFail, wait: true }, undefined, undefined, ctx);
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}
		check("a wholly-failed run is an error, not a result", thrown.length > 0, true);
		check("it says nothing was produced", thrown.includes("produced nothing"), true);
		check("it reports the cause once", thrown.includes("matches several models"), true);
		check("it points at resume", thrown.includes("resumeFromRunId:"), true);
		check("and rules out re-authoring", thrown.includes("rather than writing a new workflow"), true);

		const failedId = /\(([a-z0-9-]+)\)/.exec(thrown)?.[1];
		check("the run is on disk as a failure, not done", readMeta(AGENT, failedId ?? "")?.status, "error");

		// One dead verifier out of two has not invalidated the survivor, so the
		// run stays done — but it must not read as unqualified success either.
		const partial = [
			"export const meta = { name: 'partial', description: 'one dies' }",
			"const out = await parallel([() => agent('BOOM one'), () => agent('fine two')])",
			"return { found: out.filter(Boolean).length }",
		].join("\n");
		const mixed = await tool.execute("t-partial", { script: partial, wait: true }, undefined, undefined, ctx);
		const text = mixed.content[0].text as string;
		check("a partial failure still returns its result", text.includes('"found": 1'), true);
		check("but is not reported as clean", text.includes("1 FAILED"), true);
		check("it says the result is incomplete", text.includes("of 2 agents failed"), true);
		check("and offers resume for the dead one", text.includes("resumeFromRunId:"), true);
		check("the run itself is still done", (mixed.details as { status?: string })?.status, "done");
	} finally {
		process.argv[1] = realArgv1;
	}
}

console.log("\n--- workflow agents inherit from subagents.json, then the session ---");
{
	// agents.ts has always parsed subagents.json's { defaults: { model,
	// reasoning } }, and tool.ts only ever read `types` — so a configured
	// default was silently ignored and every agent fell through to whichever
	// model the human happened to be talking to. Worse for reasoning: with no
	// --thinking the child pi reads its OWN defaultThinkingLevel, so a session
	// set to "max" ran every subagent at max.
	mkdirSync(AGENT, { recursive: true });
	mkdirSync(CWD, { recursive: true });
	const FAST = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", contextWindow: 1000, maxTokens: 100 };
	writeFileSync(
		join(AGENT, "subagents.json"),
		JSON.stringify({
			defaults: { model: "gpt-5.6-luna", reasoning: "low" },
			agents: [{ name: "explorer", purpose: "look", tools: ["read"] }, { name: "pinned", model: "gpt-5.4-mini", purpose: "x" }],
		}),
	);

	const argLog = join(ROOT, "inherit-args.txt");
	const argPi = join(ROOT, "arg-pi.mjs");
	writeFileSync(
		argPi,
		[
			'import { appendFileSync } from "node:fs";',
			"const a = process.argv;",
			'const pick = (f) => { const i = a.indexOf(f); return i === -1 ? "-" : a[i + 1]; };',
			`appendFileSync(${JSON.stringify(argLog)}, pick("--model") + " " + pick("--thinking") + "\\n");`,
			"const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2, cost: { total: 0 } };",
			'process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" } }) + "\\n");',
		].join("\n"),
	);
	const realArgv1 = process.argv[1];
	process.argv[1] = argPi;

	try {
		const tool = tools.get("workflow")!;
		writeSettings({});
		const { ctx } = makeCtx({ model: MODEL, registryModels: [MODEL, FAST] });
		events.get("session_start")!({}, ctx);
		const script = [
			"export const meta = { name: 'inherit', description: 'i' }",
			"await agent('a', { agentType: 'explorer' })",
			"await agent('b', { agentType: 'pinned' })",
			"await agent('c', { model: 'gpt-5.4-mini', thinking: 'high' })",
			"return 'done'",
		].join("\n");
		await tool.execute("t-inherit", { script, wait: true }, undefined, undefined, ctx);
		const rows = readFileSync(argLog, "utf8").trim().split("\n");

		// A type with no model of its own now takes the configured default
		// instead of silently becoming whatever the human is using.
		check("an unpinned agentType takes the subagents.json default", rows[0], "openai-codex/gpt-5.6-luna low");
		// A type that pins its own model still wins over the default...
		check("a pinned agentType still wins", rows[1]?.split(" ")[0], "openai-codex/gpt-5.4-mini");
		// ...but inherits the default reasoning it did not set.
		check("while inheriting the default reasoning", rows[1]?.split(" ")[1], "low");
		// And an explicit agent() option beats everything.
		check("agent() options beat both", rows[2], "openai-codex/gpt-5.4-mini high");
	} finally {
		process.argv[1] = realArgv1;
		writeFileSync(join(AGENT, "subagents.json"), JSON.stringify({ defaults: {}, agents: [] }));
	}
}

console.log("\n--- a shared session is one conversation, continued ---");
{
	// The unit tests cover the engine's guard; this covers the wiring, which is
	// where the claim actually lives: the --session-id the child process is
	// handed. pi opens an existing session by id (main.js), so two agents given
	// the same id continue one transcript — and nothing else in the test suite
	// can see what id was passed.
	mkdirSync(AGENT, { recursive: true });
	mkdirSync(CWD, { recursive: true });
	const idLog = join(ROOT, "session-ids.txt");
	const spyPi = join(ROOT, "spy-pi.mjs");
	writeFileSync(
		spyPi,
		[
			'import { appendFileSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"const argv = process.argv;",
			'const id = argv[argv.indexOf("--session-id") + 1] ?? "(none)";',
			`appendFileSync(${JSON.stringify(idLog)}, id + "\\n");`,
			// Write a transcript the way pi names them, <timestamp>_<id>.jsonl in
			// the --session-dir. Without this the spy left agents/ empty and the
			// sessionFile lookup could not be tested at all — which is how it
			// shipped searching for a filename shared-session agents never have.
			'const dir = argv[argv.indexOf("--session-dir") + 1];',
			'if (dir) writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_" + id + ".jsonl"), "{}\\n");',
			"const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2, cost: { total: 0 } };",
			'const message = { role: "assistant", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" };',
			'process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");',
		].join("\n"),
	);
	const realArgv1 = process.argv[1];
	process.argv[1] = spyPi;

	try {
		const tool = tools.get("workflow")!;
		const { ctx } = makeCtx({ model: MODEL });
		const script = [
			"export const meta = { name: 'chain', description: 'two chained and one alone' }",
			"await agent('first', { session: 'explore' })",
			"await agent('second', { session: 'explore', context: { text: 'ignored' } })",
			"await agent('loner')",
			"return 'done'",
		].join("\n");
		const run = await tool.execute("t-chain", { script, wait: true }, undefined, undefined, ctx);
		const ids = readFileSync(idLog, "utf8").trim().split("\n");
		check("every agent was spawned", ids.length, 3);
		// The whole point: two calls, one conversation.
		check("the chained pair share one session", ids[0], ids[1]);
		check("and it is a shared id, not an agent one", /-sexplore-[0-9a-f]{8}$/.test(ids[0]!), true);
		// The unchained agent keeps its own per-index transcript, so a shared
		// session never becomes the default.
		check("the lone agent is on its own", ids[2] !== ids[0], true);
		check("named by index", /-a\d+$/.test(ids[2]!), true);

		// Seeding creates a file. Doing it twice would leave two files claiming
		// one id and let a directory scan decide which pi opens — so the second
		// request is refused, and said out loud rather than silently dropped.
		//
		// WHICH refusal matters. Agent one here passes no context, so nothing was
		// ever seeded; the session holds agent one's own conversation and nothing
		// forked. Saying "already holds the conversation it would have been seeded
		// with" was a positive lie, and it was the same lie a chain got when its
		// first seed FAILED — every later agent was told the context had arrived
		// while no agent in the run ever saw it.
		const logs = (run.details as { logs: string[] }).logs;
		check(
			"a second seed into the same session is refused",
			logs.some((line) => line.includes('context NOT delivered — session "explore" was already started without it')),
			true,
		);
		check(
			"and it does not claim the context is there",
			logs.some((line) => line.includes("already holds")),
			false,
		);

		// Every agent's transcript is findable, including the chained ones. The
		// lookup used to re-derive `<runId>-a<index>` even for a shared session,
		// whose id is `<runId>-s<slug>-<hash>` — a filename pi never writes — so
		// /workflows showed "session none" and refused to open the transcript for
		// exactly the agents whose accumulated conversation is the point.
		const agents = (run.details as { phases: { agents: { label: string; sessionFile?: string }[] }[] }).phases.flatMap((p) => p.agents);
		check("every agent has a transcript", agents.length > 0 && agents.every((a) => typeof a.sessionFile === "string"), true);
		check(
			"and the chained ones point at the shared session file",
			agents.filter((a) => a.sessionFile?.includes("-sexplore-")).length,
			2,
		);
	} finally {
		process.argv[1] = realArgv1;
	}
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
