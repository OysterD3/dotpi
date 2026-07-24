/**
 * Tests for the elapsed-time extension: the duration format transcribed from
 * Claude Code, the end-of-turn line, and the wiring against a fake pi.
 *
 * Run with jiti from a directory where pi's packages resolve (they are not
 * dependencies of this repo):
 *     jiti agent/extensions/elapsed/elapsed.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "elapsed-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { formatDuration } = await import("./duration.ts");
const { pickVerbIndex, turnDurationLine, verbFor } = await import("./render.ts");
const { CONFIG } = await import("./config.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------ duration

console.log("--- duration: Claude Code's table, verbatim ---");
// Each row was produced by running Claude Code's own transcribed function.
const TABLE: Array<[number, string, string, string]> = [
	// ms, default, mostSignificantOnly, hideTrailingZeros
	[0, "0s", "0s", "0s"],
	[0.5, "0.0s", "0.0s", "0.0s"],
	[999, "0s", "0s", "0s"],
	[1000, "1s", "1s", "1s"],
	[59_999, "59s", "59s", "59s"],
	[60_000, "1m 0s", "1m", "1m"],
	[64_000, "1m 4s", "1m", "1m 4s"],
	[599_000, "9m 59s", "9m", "9m 59s"],
	[3_600_000, "1h 0m 0s", "1h", "1h"],
	[3_661_000, "1h 1m 1s", "1h", "1h 1m 1s"],
	[90_000_000, "1d 1h 0m", "1d", "1d 1h"],
	[183_840_000, "2d 3h 4m", "2d", "2d 3h 4m"],
];
for (const [ms, plain, significant, hidden] of TABLE) {
	check(`${ms}ms`, formatDuration(ms), plain);
	check(`${ms}ms mostSignificantOnly`, formatDuration(ms, { mostSignificantOnly: true }), significant);
	check(`${ms}ms hideTrailingZeros`, formatDuration(ms, { hideTrailingZeros: true }), hidden);
}

console.log("\n--- duration: the seconds boundary ---");
check("under a minute floors", formatDuration(45_900), "45s");
check("one second short of a minute", formatDuration(59_999), "59s");
check("at a minute switches shape", formatDuration(60_000), "1m 0s");
check("over a minute rounds up", formatDuration(60_500), "1m 1s");
check("over a minute rounds down", formatDuration(60_499), "1m 0s");
check("rounding carries into minutes", formatDuration(119_600), "2m 0s");
check("rounding carries into hours", formatDuration(3_599_600), "1h 0m 0s");

// ---------------------------------------------------------- end-of-turn line

console.log("\n--- the end-of-turn line ---");
check("Claude Code's shape", turnDurationLine({ durationMs: 64_000, verbIndex: 4 }), "Cooked for 1m 4s");
check("short turn", turnDurationLine({ durationMs: 12_000, verbIndex: 2 }), "Churned for 12s");
check("verb pool is Claude Code's", [...CONFIG.verbs], ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"]);
check("index wraps rather than breaking", verbFor(CONFIG.verbs.length), "Baked");
check("negative index is still a verb", verbFor(-1), "Worked");
check("lowest random picks the first", pickVerbIndex(() => 0), 0);
check("highest random stays in range", pickVerbIndex(() => 0.999999), CONFIG.verbs.length - 1);

// ------------------------------------------------------------------ settings

console.log("\n--- settings ---");
const { loadSettings, workingText } = await import("./index.ts");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ elapsed: block }));

writeSettings({});
check("defaults", loadSettings(AGENT), { workingTimer: true, showTurnDuration: true, minTurnMs: 0 });
writeSettings({ showTurnDuration: false, workingTimer: false, minTurnMs: 5000 });
check("all overridden", loadSettings(AGENT), { workingTimer: false, showTurnDuration: false, minTurnMs: 5000 });
writeSettings({ minTurnMs: -1 });
check("negative threshold ignored", loadSettings(AGENT).minTurnMs, 0);
writeSettings({ showTurnDuration: "yes" });
check("wrong type falls back", loadSettings(AGENT).showTurnDuration, true);
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unreadable settings fall back", loadSettings(AGENT), { workingTimer: true, showTurnDuration: true, minTurnMs: 0 });

console.log("\n--- the working row's text ---");
check("starts at zero", workingText(0), "Working... 0s");
check("seconds", workingText(12_000), "Working... 12s");
check("past a minute", workingText(64_000), "Working... 1m 4s");

// ------------------------------------------------------------------- wiring

console.log("\n--- wiring against a fake pi ---");
{
	writeSettings({});
	const events = new Map<string, Function>();
	const entries: Array<{ type: string; data: any }> = [];
	const renderers: string[] = [];
	const messages: Array<string | undefined> = [];
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerEntryRenderer: (type: string) => renderers.push(type),
	};
	const extension = (await import("./index.ts")).default;
	extension(pi as never);

	const ctx = { hasUI: true, ui: { setWorkingMessage: (m?: string) => messages.push(m) } };
	check("registers the entry renderer", renderers, ["turn-duration"]);
	for (const name of ["session_start", "agent_start", "agent_settled"]) {
		check(`hooks ${name}`, events.has(name), true);
	}

	events.get("session_start")!({}, ctx);
	messages.length = 0;

	events.get("agent_start")!({}, ctx);
	check("paints immediately, no waiting a second", messages, ["Working... 0s"]);

	// A retry re-enters the loop; the clock must not restart.
	events.get("agent_start")!({}, ctx);
	check("re-entry does not repaint or restart", messages, ["Working... 0s"]);

	events.get("agent_settled")!({}, ctx);
	check("working message restored to pi's default", messages.at(-1), undefined);
	check("one duration entry appended", entries.length, 1);
	check("entry type", entries[0]?.type, "turn-duration");
	check("entry carries a duration", typeof entries[0]?.data.durationMs, "number");
	check("entry carries a verb", typeof entries[0]?.data.verbIndex, "number");

	// Settling without a start (e.g. loaded mid-run) must not invent a turn.
	entries.length = 0;
	events.get("agent_settled")!({}, ctx);
	check("no start, no entry", entries.length, 0);
}

console.log("\n--- disabled by settings ---");
{
	writeSettings({ workingTimer: false, showTurnDuration: false });
	const events = new Map<string, Function>();
	const entries: unknown[] = [];
	const messages: Array<string | undefined> = [];
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		appendEntry: (_type: string, data: unknown) => entries.push(data),
		registerEntryRenderer: () => {},
	};
	((await import("./index.ts")).default as Function)(pi);
	const ctx = { hasUI: true, ui: { setWorkingMessage: (m?: string) => messages.push(m) } };
	events.get("session_start")!({}, ctx);
	messages.length = 0;
	events.get("agent_start")!({}, ctx);
	check("no timer painted", messages, []);
	events.get("agent_settled")!({}, ctx);
	check("no entry appended", entries.length, 0);
	check("but the message is still cleared", messages.at(-1), undefined);
}

console.log("\n--- headless: no UI to paint ---");
{
	writeSettings({});
	const events = new Map<string, Function>();
	const pi = { on: (e: string, h: Function) => events.set(e, h), appendEntry: () => {}, registerEntryRenderer: () => {} };
	((await import("./index.ts")).default as Function)(pi);
	let threw = false;
	try {
		const ctx = { hasUI: false, ui: {} }; // no setWorkingMessage at all
		events.get("session_start")!({}, ctx);
		events.get("agent_start")!({}, ctx);
		events.get("agent_settled")!({}, ctx);
	} catch {
		threw = true;
	}
	check("headless runs do not throw", threw, false);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
