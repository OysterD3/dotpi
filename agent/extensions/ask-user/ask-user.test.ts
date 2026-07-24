/**
 * Tests for the ask-user extension: option normalization, the interactive flow
 * (single- and multi-select, "Other", decline, notes, dismissal — driven by a
 * scripted fake ui), outcome rendering, settings, and the wiring against a fake
 * pi (tool + command registration, active-tool sync, and the tool's headless
 * and interactive execute paths).
 *
 * Everything runs offline: pi's dialogs are faked, so no TUI or network.
 *
 * Run: jiti agent/extensions/ask-user/ask-user.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "ask-user-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { DECLINE, DONE, formatEntry, otherLabel, renderOutcomeText, runAsk } = await import("./interaction.ts");
const { normalizeOptions, registerAskUserTool } = await import("./tool.ts");
const { loadSettings } = await import("./index.ts");
const extension = (await import("./index.ts")).default;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

// A fake ui: each method reads its next scripted response in order.
function fakeUI(script: { select?: (string | undefined)[]; confirm?: boolean[]; input?: (string | undefined)[] }) {
	const s = [...(script.select ?? [])];
	const c = [...(script.confirm ?? [])];
	const i = [...(script.input ?? [])];
	const calls = { select: 0, confirm: 0, input: 0 };
	const ui = {
		async select(_title: string, _options: string[]) {
			calls.select++;
			return s.shift();
		},
		async confirm(_title: string, _message: string) {
			calls.confirm++;
			return c.shift() ?? false;
		},
		async input(_title: string, _placeholder?: string) {
			calls.input++;
			return i.shift();
		},
	};
	return { ui, calls };
}

const OPTS = [
	{ label: "Looks good", description: "The selector, notes, and decline all work" },
	{ label: "Needs tweaks", description: "Something feels off" },
];
const req = (over: Partial<Parameters<typeof runAsk>[1]> = {}) => ({
	question: "How does it look?",
	options: OPTS,
	multiSelect: false,
	allowNotes: true,
	...over,
});

// --------------------------------------------------------------- normalize

console.log("--- normalizeOptions ---");
check("undefined -> empty", normalizeOptions(undefined), []);
check("non-array -> empty", normalizeOptions("nope"), []);
check(
	"labels trimmed, empties/dupes dropped, descriptions carried",
	normalizeOptions([{ label: " A " }, { label: "A" }, { label: "" }, { label: "B", description: "  " }, { label: "C", description: " see " }]),
	[{ label: "A", description: undefined }, { label: "B", description: undefined }, { label: "C", description: "see" }],
);
check("capped at 8", normalizeOptions(Array.from({ length: 12 }, (_, n) => ({ label: `opt${n}` }))).length, 8);

// --------------------------------------------------------------- formatting

console.log("\n--- formatting ---");
check("entry with description", formatEntry(OPTS[0]), "Looks good — The selector, notes, and decline all work");
check("entry without description", formatEntry({ label: "Bare" }), "Bare");
checkTrue("long description truncated with ellipsis", formatEntry({ label: "L", description: "x".repeat(200) }).endsWith("…"));
check("otherLabel with options", otherLabel(true), "✎ Other (type my own answer)");
check("otherLabel without options", otherLabel(false), "✎ Type an answer");

// --------------------------------------------------------- single-select flow

console.log("\n--- runAsk: single-select ---");
{
	const { ui, calls } = fakeUI({ select: [formatEntry(OPTS[0])], confirm: [false] });
	check("pick an option, decline the note", await runAsk(ui, req()), { kind: "answer", labels: ["Looks good"], note: undefined });
	check("note was offered once", calls.confirm, 1);
}
{
	const { ui } = fakeUI({ select: [formatEntry(OPTS[1])], confirm: [true], input: ["ship it"] });
	check("pick an option, add a note", await runAsk(ui, req()), { kind: "answer", labels: ["Needs tweaks"], note: "ship it" });
}
{
	const { ui } = fakeUI({ select: [otherLabel(true)], input: ["my own thing"], confirm: [false] });
	check("Other -> custom answer", await runAsk(ui, req()), { kind: "answer", labels: [], freeform: "my own thing", note: undefined });
}
{
	const { ui } = fakeUI({ select: [otherLabel(true)], input: ["   "] });
	check("Other with empty text -> dismissed", await runAsk(ui, req()), { kind: "dismissed" });
}
{
	const { ui } = fakeUI({ select: [DECLINE], confirm: [true], input: ["not my call"] });
	check("decline with a reason note", await runAsk(ui, req()), { kind: "declined", note: "not my call" });
}
{
	const { ui } = fakeUI({ select: [undefined] });
	check("Esc at the selector -> dismissed", await runAsk(ui, req()), { kind: "dismissed" });
}
{
	const { ui, calls } = fakeUI({ select: [formatEntry(OPTS[0])] });
	check("allowNotes=false skips the note step", await runAsk(ui, req({ allowNotes: false })), { kind: "answer", labels: ["Looks good"], note: undefined });
	check("no confirm when notes are off", calls.confirm, 0);
}

// --------------------------------------------------------- multi-select flow

console.log("\n--- runAsk: multi-select ---");
{
	// Picking every option auto-submits (nothing left to choose).
	const { ui } = fakeUI({ select: [formatEntry(OPTS[0]), formatEntry(OPTS[1])], confirm: [false] });
	check("pick both -> answer with both", await runAsk(ui, req({ multiSelect: true })), { kind: "answer", labels: ["Looks good", "Needs tweaks"], freeform: undefined, note: undefined });
}
{
	// Pick one, then finish via "Done".
	const { ui } = fakeUI({ select: [formatEntry(OPTS[0]), DONE], confirm: [false] });
	check("pick one then Done", await runAsk(ui, req({ multiSelect: true })), { kind: "answer", labels: ["Looks good"], freeform: undefined, note: undefined });
}
{
	// Esc after a pick finishes with what's chosen.
	const { ui } = fakeUI({ select: [formatEntry(OPTS[0]), undefined], confirm: [false] });
	check("Esc after a pick submits it", await runAsk(ui, req({ multiSelect: true })), { kind: "answer", labels: ["Looks good"], freeform: undefined, note: undefined });
}
{
	const { ui } = fakeUI({ select: [undefined] });
	check("Esc with nothing picked -> dismissed", await runAsk(ui, req({ multiSelect: true })), { kind: "dismissed" });
}
{
	const { ui } = fakeUI({ select: [formatEntry(OPTS[0]), DECLINE], confirm: [false] });
	check("decline mid-multi overrides picks", await runAsk(ui, req({ multiSelect: true })), { kind: "declined", note: undefined });
}
{
	// Other in multi collects a custom answer, then Done.
	const { ui } = fakeUI({ select: [otherLabel(true), DONE], input: ["extra idea"], confirm: [false] });
	check("multi Other + Done", await runAsk(ui, req({ multiSelect: true })), { kind: "answer", labels: [], freeform: "extra idea", note: undefined });
}

// --------------------------------------------------------------- rendering

console.log("\n--- renderOutcomeText ---");
check("single choice", renderOutcomeText({ kind: "answer", labels: ["A"] }), 'The user chose: "A".');
check("multi choice", renderOutcomeText({ kind: "answer", labels: ["A", "B"] }), 'The user chose: "A", "B".');
check("freeform only", renderOutcomeText({ kind: "answer", labels: [], freeform: "x" }), 'The user answered: "x" (custom answer).');
check("choice with note", renderOutcomeText({ kind: "answer", labels: ["A"], note: "later" }), 'The user chose: "A".\nTheir note: later');
check("declined", renderOutcomeText({ kind: "declined" }), "The user declined to answer.");
check("declined with note", renderOutcomeText({ kind: "declined", note: "busy" }), "The user declined to answer.\nTheir note: busy");
checkTrue("dismissed text", renderOutcomeText({ kind: "dismissed" }).startsWith("The user dismissed the question"));

// --------------------------------------------------------------- settings

console.log("\n--- settings ---");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ askUser: block }));
writeSettings({});
check("defaults", loadSettings(AGENT), { enabled: true, allowNotes: true });
writeSettings({ enabled: false, allowNotes: false });
check("overrides", loadSettings(AGENT), { enabled: false, allowNotes: false });
writeSettings({ enabled: "yes", allowNotes: 1 });
check("bad types fall back to defaults", loadSettings(AGENT), { enabled: true, allowNotes: true });

// --------------------------------------------------------------- wiring

console.log("\n--- wiring against a fake pi ---");
function makePi(active: string[] = []) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	let activeTools = [...active];
	return {
		pi: {
			registerTool: (def: any) => tools.set(def.name, def),
			on: (event: string, h: Function) => handlers.set(event, h),
			registerCommand: (name: string, def: any) => commands.set(name, def),
			getActiveTools: () => activeTools,
			setActiveTools: (list: string[]) => {
				activeTools = list;
			},
		},
		tools,
		handlers,
		commands,
		active: () => activeTools,
	};
}
const uiStub = { setStatus: () => {}, notify: () => {}, select: async () => undefined, confirm: async () => false, input: async () => undefined };

{
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	checkTrue("registers the ask_user tool", h.tools.has("ask_user"));
	checkTrue("registers /ask-user", h.commands.has("ask-user"));

	const tool = h.tools.get("ask_user");
	check("tool runs sequentially", tool.executionMode, "sequential");
	checkTrue("ships guideline bullets", Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);

	// enabled + interactive -> the tool is offered.
	h.handlers.get("session_start")!({}, { hasUI: true, ui: uiStub });
	checkTrue("active when enabled and interactive", h.active().includes("ask_user"));
}
{
	// Headless -> not offered.
	writeSettings({});
	const h = makePi(["ask_user"]);
	extension(h.pi as never);
	h.handlers.get("session_start")!({}, { hasUI: false, ui: uiStub });
	checkTrue("inactive in a headless session", !h.active().includes("ask_user"));
}
{
	// Disabled -> not offered even with a UI.
	writeSettings({ enabled: false });
	const h = makePi(["ask_user"]);
	extension(h.pi as never);
	h.handlers.get("session_start")!({}, { hasUI: true, ui: uiStub });
	checkTrue("inactive when disabled", !h.active().includes("ask_user"));
}
{
	// /ask-user off removes it for the session; on restores it.
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	const ctx = { hasUI: true, ui: uiStub };
	h.handlers.get("session_start")!({}, ctx);
	const cmd = h.commands.get("ask-user");
	await cmd.handler("off", ctx);
	checkTrue("/ask-user off deactivates", !h.active().includes("ask_user"));
	await cmd.handler("on", ctx);
	checkTrue("/ask-user on reactivates", h.active().includes("ask_user"));
}

// -------------------------------------------------------------- tool.execute

console.log("\n--- tool.execute ---");
{
	const h = makePi();
	registerAskUserTool(h.pi as never, { settings: () => ({ enabled: true, allowNotes: true }) });
	const tool = h.tools.get("ask_user");

	// Headless: graceful message, no hang.
	const headless = await tool.execute("t1", { question: "Pick one?" }, undefined, undefined, { hasUI: false, ui: uiStub });
	checkTrue("headless returns a graceful message", headless.content[0].text.includes("headless"));
	check("headless details record the mode", headless.details.mode, "headless");

	// Interactive: pick the first option, no note.
	const scripted = { ...uiStub, select: async () => formatEntry(OPTS[0]), confirm: async () => false };
	const answered = await tool.execute("t2", { question: "How does it look?", options: OPTS }, undefined, undefined, { hasUI: true, ui: scripted });
	check("interactive answer text", answered.content[0].text, 'The user chose: "Looks good".');
	check("interactive details", [answered.details.kind, answered.details.choices], ["answer", ["Looks good"]]);

	// Empty question is rejected.
	let threw = false;
	try {
		await tool.execute("t3", { question: "   " }, undefined, undefined, { hasUI: true, ui: scripted });
	} catch {
		threw = true;
	}
	checkTrue("empty question throws", threw);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
