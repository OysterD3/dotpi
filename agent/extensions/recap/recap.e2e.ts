/**
 * End-to-end for /recap against the real extension, with fakes for the model so
 * nothing hits the network. The actual recap text (the "ok" path) is exercised by
 * recap.live.ts; this covers registration, the settings warnings surfaced at
 * session start, the idle stamp, every input-handler guard, and the manual
 * command outcomes that resolve before any model call.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/recap/recap.e2e.ts
 *
 * It reads settings from a scratch agent dir via PI_CODING_AGENT_DIR — the same
 * variable pi uses — and never writes anything, so it cannot touch real config.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "recap-e2e-"));
const AGENT = join(ROOT, "agent");
const CWD = join(ROOT, "project");
mkdirSync(AGENT, { recursive: true });
mkdirSync(CWD, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const recap = (await import("./index.ts")).default;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

const AGENT_SETTINGS = join(AGENT, "settings.json");
const writeSettings = (recapBlock: unknown) => writeFileSync(AGENT_SETTINGS, JSON.stringify({ recap: recapBlock }));

// ------------------------------------------------------------- register + wire

const events = new Map<string, Function>();
const commands = new Map<string, { description?: string; handler: Function }>();
const entryRenderers: string[] = [];
const entries: Array<{ type: string; customType: string; data: any }> = [];

const pi = {
	on: (event: string, handler: Function) => events.set(event, handler),
	registerCommand: (name: string, options: any) => commands.set(name, options),
	registerEntryRenderer: (type: string, _r: Function) => entryRenderers.push(type),
	appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
};

recap(pi as any);

console.log("--- registration ---");
check("registers /recap", [...commands.keys()], ["recap"]);
check("description", commands.get("recap")?.description, "Summarise where the session stands");
check("renders recap entries", entryRenderers, ["recap"]);
check("hooks session_start", events.has("session_start"), true);
check("hooks agent_settled", events.has("agent_settled"), true);
check("hooks input", events.has("input"), true);

// ------------------------------------------------------------------- fake ctx

let authCalls = 0;
function makeCtx(options: {
	branch?: any[];
	model?: any;
	authOk?: boolean;
	hasUI?: boolean;
	hasPending?: boolean;
}) {
	const notices: Array<{ message: string; type: string }> = [];
	const ctx = {
		cwd: CWD,
		hasUI: options.hasUI ?? true,
		isProjectTrusted: () => true,
		hasPendingMessages: () => options.hasPending ?? false,
		signal: undefined as AbortSignal | undefined,
		model: options.model,
		sessionManager: { getBranch: () => options.branch ?? [] },
		modelRegistry: {
			getAll: () => [],
			getApiKeyAndHeaders: async () => {
				authCalls++;
				return options.authOk ? { ok: true, apiKey: "x" } : { ok: false, error: "no key" };
			},
		},
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
		},
	};
	return { ctx, notices };
}

const userMsg = { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
const asstMsg = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
const model = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku", contextWindow: 200_000 };

// --------------------------------------------------------------- session_start

console.log("\n--- session_start surfaces settings warnings ---");
writeSettings({ idleThresholdMs: -5 }); // invalid -> warning
{
	const { ctx, notices } = makeCtx({});
	events.get("session_start")!({}, ctx);
	check("bad setting warned at startup", notices.some((n) => n.message.includes("idleThresholdMs") && n.type === "warning"), true);
}

// ------------------------------------------------------------- manual outcomes

console.log("\n--- manual /recap: no model ---");
writeSettings({});
{
	authCalls = 0;
	const { ctx, notices } = makeCtx({ branch: [userMsg, asstMsg], model: undefined });
	events.get("session_start")!({}, ctx);
	await commands.get("recap")!.handler("", ctx);
	check("no model -> failed notice", notices.at(-1)?.message, "Couldn't generate a recap: no model selected");
	check("no model -> nothing appended", entries.length, 0);
	check("no model -> auth never consulted", authCalls, 0);
}

console.log("\n--- manual /recap: nothing to recap ---");
{
	const { ctx, notices } = makeCtx({ branch: [], model, authOk: true });
	events.get("session_start")!({}, ctx);
	await commands.get("recap")!.handler("", ctx);
	check("empty branch -> Claude Code's exact wording", notices.at(-1)?.message, "Nothing to recap yet — send a message first.");
	check("empty branch -> nothing appended", entries.length, 0);
}

console.log("\n--- manual /recap: reentrancy ---");
{
	const { ctx, notices } = makeCtx({ branch: [], model, authOk: true });
	events.get("session_start")!({}, ctx);
	// Two overlapping invocations: the second must be refused, not run in parallel.
	const first = commands.get("recap")!.handler("", ctx);
	const second = commands.get("recap")!.handler("", ctx);
	await Promise.all([first, second]);
	check("overlapping recap refused", notices.some((n) => n.message === "A recap is already being generated."), true);
}

// ------------------------------------------------------------ input guards

console.log("\n--- auto-recap input guards (none should reach the model) ---");

async function fireInput(
	settings: unknown,
	event: { source?: string; streamingBehavior?: string },
	ctxOptions: Parameters<typeof makeCtx>[0],
	settle = true,
) {
	writeSettings(settings);
	authCalls = 0;
	const { ctx } = makeCtx(ctxOptions);
	events.get("session_start")!({}, ctx);
	if (settle) events.get("agent_settled")!({}, ctx); // stamps idle = now (gap ~0)
	await events.get("input")!({ source: "interactive", streamingBehavior: undefined, ...event }, ctx);
	return authCalls;
}

const enoughTurns = [userMsg, asstMsg, userMsg, asstMsg, userMsg, asstMsg];

check("non-interactive source is ignored", await fireInput({ autoOnReturn: true }, { source: "rpc" }, { branch: enoughTurns, model, authOk: true }), 0);
check("mid-stream input is ignored", await fireInput({ autoOnReturn: true }, { streamingBehavior: "steer" }, { branch: enoughTurns, model, authOk: true }), 0);
check("no UI is ignored", await fireInput({ autoOnReturn: true }, {}, { branch: enoughTurns, model, authOk: true, hasUI: false }), 0);
check("auto disabled is ignored", await fireInput({ autoOnReturn: false }, {}, { branch: enoughTurns, model, authOk: true }), 0);
check("gap too small is ignored", await fireInput({ autoOnReturn: true }, {}, { branch: enoughTurns, model, authOk: true }), 0);
check("never-settled is ignored", await fireInput({ autoOnReturn: true }, {}, { branch: enoughTurns, model, authOk: true }, false), 0);
check("nothing appended by any guarded input", entries.length, 0);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
