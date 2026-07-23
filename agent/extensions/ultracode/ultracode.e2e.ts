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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { KEYWORD_REMINDER, ENTER_FULL, ENTER_SPARSE, EXIT } = await import("./reminders.ts");
const ultracode = (await import("./index.ts")).default;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------- fake pi

const events = new Map<string, Function>();
const commands = new Map<string, { description?: string; handler: Function }>();
const tools = new Map<string, any>();
const entryRenderers: string[] = [];
const appended: Array<{ customType: string; data: any }> = [];
let thinkingLevel = "medium";
const thinkingLog: string[] = [];
// Mimics pi: the applied level is the requested one clamped to what the model
// supports. Tests swap this to exercise the clamp paths.
let clampLevel: (level: string) => string = (level) => level;

const pi = {
	on: (event: string, handler: Function) => events.set(event, handler),
	registerCommand: (name: string, options: any) => commands.set(name, options),
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerEntryRenderer: (type: string, _renderer: Function) => entryRenderers.push(type),
	appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	getThinkingLevel: () => thinkingLevel,
	setThinkingLevel: (level: string) => {
		thinkingLevel = clampLevel(level);
		thinkingLog.push(level);
	},
};

ultracode(pi as any);

function makeCtx(options: { model?: any; branch?: any[]; trusted?: boolean } = {}) {
	const notices: Array<{ message: string; type: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		cwd: CWD,
		hasUI: true,
		model: options.model,
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
		},
	};
	return { ctx, notices, statuses };
}

const MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", name: "mini", reasoning: true, contextWindow: 200_000 };
const NO_REASONING = { provider: "x", id: "plain-model", name: "plain", reasoning: false, contextWindow: 32_000 };

const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ ultracode: block }));

async function turn(text: string, source = "interactive") {
	await events.get("input")!({ type: "input", text, source });
	return events.get("before_agent_start")!({ type: "before_agent_start", prompt: text });
}

// --------------------------------------------------------------- registration

console.log("--- registration ---");
check("workflow tool registered", tools.has("workflow"), true);
check("workflow is sequential", tools.get("workflow")?.executionMode, "sequential");
check("workflow has prompt snippet", typeof tools.get("workflow")?.promptSnippet, "string");
check("description carries Ultracode section", tools.get("workflow")?.description.includes("**Ultracode.**"), true);
check("/ultracode registered", commands.has("ultracode"), true);
check("entry renderer", entryRenderers, ["ultracode"]);
for (const name of ["session_start", "input", "before_agent_start", "thinking_level_select"]) {
	check(`hooks ${name}`, events.has(name), true);
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
		"Claude Code's success wording",
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
	// combined message carries both reminders, keyword first (Claude Code's
	// attachment order).
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
	// pi clamps xhigh UP to max (Claude models): accepted, reported honestly.
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

console.log("\n--- workflow tool: no-agent paths ---");
{
	const tool = tools.get("workflow")!;
	const { ctx } = makeCtx({ model: MODEL });
	const updates: any[] = [];
	const script = [
		"export const meta = { name: 'demo', description: 'no agents', phases: [{ title: 'Go' }] }",
		"phase('Go')",
		"log('working')",
		"return { answer: args.n * 2 }",
	].join("\n");
	const result = await tool.execute("t1", { script, args: { n: 21 } }, undefined, (u: any) => updates.push(u), ctx);
	const text = result.content[0].text as string;
	check("summary line", text.startsWith('Workflow "demo" finished: 0 agents'), true);
	check("result JSON in content", text.includes('"answer": 42'), true);
	check("details status done", result.details.status, "done");
	check("streamed updates emitted", updates.length > 0, true);
	check("phase recorded in details", result.details.phases.map((p: any) => p.title), ["Go"]);
	check("log recorded in details", result.details.logs, ["working"]);

	const bad = await tool.execute("t2", { script: "return 1" }, undefined, undefined, ctx).then(
		() => "no-throw",
		(error: Error) => error.message,
	);
	check("missing meta -> error", bad, "Workflow failed: workflow script must begin with `export const meta = {...}`");

	const controller = new AbortController();
	controller.abort();
	const abortScript = `export const meta = { name: 'a', description: 'b' }\nreturn await agent('x')`;
	const abortedRun = await tool.execute("t3", { script: abortScript }, controller.signal, undefined, ctx).then(
		() => "no-throw",
		(error: Error) => error.message,
	);
	check("pre-aborted -> Workflow aborted", abortedRun, "Workflow aborted");

	// A circular return value must not turn a finished run into a failure.
	const circularScript = [
		"export const meta = { name: 'circ', description: 'circular result' }",
		"const a = { name: 'a' }",
		"a.self = a",
		"return a",
	].join("\n");
	const circular = await tool.execute("t4", { script: circularScript }, undefined, undefined, ctx);
	check("circular result still succeeds", circular.details.status, "done");
	check("circular marker in content", circular.content[0].text.includes('"self": "[circular]"'), true);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
