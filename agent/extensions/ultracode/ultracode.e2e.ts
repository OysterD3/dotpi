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
const { PANEL_CHANNEL, PANEL_OPEN_CHANNEL, SPEND_CHANNEL } = await import("./config.ts");

/** What ultracode puts on SPEND_CHANNEL. */
type SpendEvent = { source: string; calls?: number; usage: { cost?: number; reasoning?: number } };
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
		idle?: boolean;
		dead?: () => boolean;
		/** Make ui.custom reject, to check the panel hands the footer back anyway. */
		customRejects?: boolean;
		/** Resolve the panel with a PanelResult, as `R` (resume) does. */
		customResult?: { editorText: string; notice: string };
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
		sessionManager: { getBranch: () => options.branch ?? [], getSessionFile: () => join(CWD, "session.jsonl") },
		modelRegistry: { getAll: () => options.registryModels ?? [] },
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
	tools.get("workflow")?.description.includes("in the request that triggers the workflow"),
	true,
);
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

	// An unresolvable model reference fails that agent (before any spawn), not
	// the run — and the failure reason lands in the logs.
	const badModelScript = [
		"export const meta = { name: 'routing', description: 'bad model reference' }",
		"return await agent('x', { model: 'nope' })",
	].join("\n");
	const routed = await tool.execute(
		"t5",
		{ script: badModelScript, wait: true },
		undefined,
		undefined,
		makeCtx({ model: MODEL, registryModels: [MODEL] }).ctx,
	);
	check("unresolvable reference -> agent null", routed.content[0].text.includes("Result:\nnull"), true);
	check("resolution error logged", routed.details.logs.some((l: string) => l.includes('"nope" matched no available model')), true);
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
		check("under the shared source name", bg[0]?.source, "workflows");
		check("carrying the flat cost", bg[0]?.usage.cost, 0.25);
		check("and the reasoning tokens", bg[0]?.usage.reasoning, 150);
		check("counted as a call", bg[0]?.calls, 1);
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
	check("show unknown", notices.at(-1)?.message, "No run wf-99. /workflows list shows every run.");
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
	const guard = makeCtx({ model: MODEL, registryModels: [MODEL] });
	events.get("session_start")!({}, guard.ctx);
	const guarded = await tool.execute(
		"t10",
		{ script: `export const meta = { name: 'g', description: 'h' }\nreturn await agent('x', { model: 42 })`, wait: true },
		undefined,
		undefined,
		guard.ctx,
	);
	check(
		"non-string model reference is named as such",
		guarded.details.logs.some((l: string) => l.includes("model must be a string reference, got number")),
		true,
	);
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
	check("and no correction is raised for it", await turn("still there?"), undefined);
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

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
