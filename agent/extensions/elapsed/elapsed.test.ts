/**
 * Tests for the elapsed-time extension: the duration format, the end-of-turn
 * line, and the wiring against a fake pi.
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
const { ASK_CHANNEL, CONFIG, PERMISSION_ANSWERED_CHANNEL, PERMISSION_CHANNEL } = await import("./config.ts");
const { WaitClock, workedMs } = await import("./waiting.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------ duration

console.log("--- duration: the full table ---");
// Every row is a fixed expectation; a change here is a change in behaviour.
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
check("the line's shape", turnDurationLine({ durationMs: 64_000, verbIndex: 4 }), "Cooked for 1m 4s");
check("short turn", turnDurationLine({ durationMs: 12_000, verbIndex: 2 }), "Churned for 12s");
check("the verb pool", [...CONFIG.verbs], ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked"]);
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

// ------------------------------------------------------- waiting on a human

console.log("\n--- the clock stops for a question ---");
{
	const waits = new WaitClock();
	check("nothing waited yet", waits.waitedBy(1000), 0);
	check("and the count is the wall clock", workedMs(0, 1000, waits), 1000);

	waits.open(1000);
	check("the count freezes while the question is up", workedMs(0, 5000, waits), 1000);
	check("however long it stays up", workedMs(0, 60_000, waits), 1000);
	check("the wait is visible in progress", waits.waiting, true);

	waits.close(61_000);
	check("and resumes from where it stopped", workedMs(0, 61_000, waits), 1000);
	check("counting again afterwards", workedMs(0, 63_000, waits), 3000);
	check("no longer waiting", waits.waiting, false);

	// Several questions in one turn each take their own bite.
	waits.open(63_000);
	waits.close(64_000);
	check("a second wait is excluded too", workedMs(0, 65_000, waits), 4000);
}
{
	// The bus is not a state machine: a repeated or stray edge must not corrupt
	// the total, or a turn could report a negative or wildly inflated duration.
	const waits = new WaitClock();
	waits.close(500); // never opened
	check("a stray close does nothing", waits.waitedBy(1000), 0);
	waits.open(1000);
	waits.open(2000); // already open
	waits.close(3000);
	check("a repeat open does not restart the wait", waits.waitedBy(4000), 2000);
	waits.close(5000); // already closed
	check("a repeat close does not double-count", waits.waitedBy(6000), 2000);
}
{
	// A clock that jumps backwards (NTP, sleep/wake) must not make time negative.
	const waits = new WaitClock();
	waits.open(5000);
	waits.close(1000);
	check("a backwards clock cannot subtract", waits.waitedBy(6000), 0);
	check("nor can it produce negative work", workedMs(5000, 1000, waits), 0);
}
{
	const waits = new WaitClock();
	waits.open(0);
	waits.close(1000);
	waits.reset();
	check("a new turn starts clean", waits.waitedBy(2000), 0);
}

console.log("\n--- wiring against a fake pi ---");
{
	writeSettings({});
	const bus = new Map<string, (data: unknown) => void>();
	const events = new Map<string, Function>();
	const entries: Array<{ type: string; data: any }> = [];
	const renderers: string[] = [];
	const messages: Array<string | undefined> = [];
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerEntryRenderer: (type: string) => renderers.push(type),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.set(channel, handler);
				return () => bus.delete(channel);
			},
			emit: () => {},
		},
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

	// A question repaints on the spot, both ways: the row should stop and start
	// on the keystroke, not up to a tick later. (What it stops *at* is the
	// WaitClock's arithmetic, covered above without sleeping.)
	check("subscribes to the question channel", bus.has(ASK_CHANNEL), true);
	messages.length = 0;
	bus.get(ASK_CHANNEL)!({ active: true });
	check("opening a question repaints at once", messages.length, 1);
	bus.get(ASK_CHANNEL)!({ active: false });
	check("and answering it repaints again", messages.length, 2);
	check("with the count held across the wait", new Set(messages).size, 1);

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

console.log("\n--- the wait really is subtracted (clock under test control) ---");
{
	// The assertions above cannot fail if the WaitClock is unwired: both edges
	// land in the same millisecond and formatDuration floors to whole seconds.
	// Driving Date.now is what makes the arithmetic observable end to end.
	writeSettings({});
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const bus = new Map<string, (data: unknown) => void>();
		const events = new Map<string, Function>();
		const entries: Array<{ data: any }> = [];
		const messages: Array<string | undefined> = [];
		const pi = {
			on: (event: string, handler: Function) => events.set(event, handler),
			appendEntry: (_type: string, data: any) => entries.push({ data }),
			registerEntryRenderer: () => {},
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					bus.set(channel, handler);
					return () => bus.delete(channel);
				},
				emit: () => {},
			},
		};
		((await import("./index.ts")).default as Function)(pi);
		const ctx = { hasUI: true, ui: { setWorkingMessage: (m?: string) => messages.push(m) } };
		events.get("session_start")!({}, ctx);
		events.get("agent_start")!({}, ctx);

		clock += 10_000; // ten seconds of real work
		bus.get(ASK_CHANNEL)!({ active: true, blocking: true });
		check("the row shows the work done so far", messages.at(-1), "Working... 10s");

		clock += 60_000; // a minute spent deciding
		bus.get(ASK_CHANNEL)!({ active: false, blocking: true });
		check("and holds across the whole wait", messages.at(-1), "Working... 10s");

		clock += 5_000; // five more seconds of work
		events.get("agent_settled")!({}, ctx);
		check("the turn reports work, not wall clock", entries[0]?.data.durationMs, 15_000);

		// The /ask-user test demo puts the same prompt on screen while the agent
		// keeps working, so its seconds must still count.
		entries.length = 0;
		events.get("agent_start")!({}, ctx);
		bus.get(ASK_CHANNEL)!({ active: true, blocking: false });
		clock += 30_000;
		bus.get(ASK_CHANNEL)!({ active: false, blocking: false });
		events.get("agent_settled")!({}, ctx);
		check("a non-blocking prompt is not subtracted", entries[0]?.data.durationMs, 30_000);

		// A permission prompt blocks just as hard, and needs both edges.
		entries.length = 0;
		events.get("agent_start")!({}, ctx);
		check("subscribes to the permission channels", [bus.has(PERMISSION_CHANNEL), bus.has(PERMISSION_ANSWERED_CHANNEL)], [true, true]);
		bus.get(PERMISSION_CHANNEL)!({ tool: "bash", target: "rm -rf /" });
		clock += 45_000;
		bus.get(PERMISSION_ANSWERED_CHANNEL)!({ tool: "bash" });
		clock += 2_000;
		events.get("agent_settled")!({}, ctx);
		check("an approval is subtracted too", entries[0]?.data.durationMs, 2_000);

		// An unrecognised payload must not be read as "the wait ended".
		entries.length = 0;
		events.get("agent_start")!({}, ctx);
		bus.get(ASK_CHANNEL)!({ active: true, blocking: true });
		clock += 20_000;
		bus.get(ASK_CHANNEL)!({ question: "moved to the next one" });
		clock += 10_000;
		bus.get(ASK_CHANNEL)!({ active: false, blocking: true });
		events.get("agent_settled")!({}, ctx);
		check("a payload that is neither edge leaves the clock stopped", entries[0]?.data.durationMs, 0);
	} finally {
		Date.now = realNow;
	}
}

console.log("\n--- a UI that throws on the first paint ---");
{
	// Regression: the painter is published for the ask-channel to call, and
	// stopTicker() clears it. If the first paint throws, setInterval must not be
	// handed the cleared reference.
	writeSettings({});
	const events = new Map<string, Function>();
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		appendEntry: () => {},
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	((await import("./index.ts")).default as Function)(pi);
	const ctx = {
		hasUI: true,
		ui: {
			setWorkingMessage: (message?: string) => {
				if (message !== undefined) throw new Error("session went away");
			},
		},
	};
	events.get("session_start")!({}, ctx);
	let threw = "";
	try {
		events.get("agent_start")!({}, ctx);
	} catch (error) {
		threw = String(error);
	}
	check("agent_start survives a throwing working row", threw, "");
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
		events: { on: () => () => {}, emit: () => {} },
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
	const pi = {
		on: (e: string, h: Function) => events.set(e, h),
		appendEntry: () => {},
		registerEntryRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
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
