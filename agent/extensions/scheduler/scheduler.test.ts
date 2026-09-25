/**
 * Tests for the scheduler extension: reading times and rules (durations, clock
 * times, weekdays, one-time moments), the next and the last due time of each
 * rule — across daylight-saving changes and weekday wraps — how a rule reads
 * back, restoring the list from a branch, the text a due schedule sends, the
 * /schedule parse answer, the runtime against a fake clock (save before send,
 * no double run after a reload, one run for a stretch of missed ones), and the
 * wiring of the tool and the commands against a fake pi.
 *
 * The time zone is fixed to America/New_York before anything reads a date, so
 * the daylight-saving changes fall on known days (2026-03-08, 2026-11-01).
 *
 * Run: jiti agent/extensions/scheduler/scheduler.test.ts
 */
process.env.TZ = "America/New_York";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "scheduler-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { CONFIG, ENTRY_TYPE } = await import("./config.ts");
const state = await import("./state.ts");
const { parseDuration, parseClock, parseWeekdays, parseAt, validateWhen, nextFire, lastDue, describeWhen, formatTime, formatInterval, formatRelative, restoreSnapshot, isCommand } = state;
const { Scheduler, scheduledText } = await import("./timer.ts");
const { readParse, parseRequest } = await import("./parse.ts");
const { selectModel } = await import("./model.ts");
const { install } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A local time in America/New_York. Month is 1-based here, unlike Date. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const clock = (t: number) => {
	const date = new Date(t);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
// Thursday 24 September 2026, 16:05 local.
const NOW = at(2026, 9, 24, 16, 5);

// ------------------------------------------------------------- reading words

console.log("--- durations ---");
for (const [text, want] of [
	["20m", 20 * MIN], ["1h30m", 90 * MIN], ["1h 30m", 90 * MIN], ["2 hours", 2 * HOUR], ["2d", 2 * DAY], ["90s", 90_000], ["1.5h", 90 * MIN],
	["", undefined], ["20", undefined], ["20 parsecs", undefined], ["0m", undefined], ["20m and", undefined],
] as Array<[string, number | undefined]>) check(`duration "${text}"`, parseDuration(text), want);

console.log("\n--- clock times ---");
for (const [text, want] of [
	["09:00", "09:00"], ["9:05", "09:05"], ["9am", "09:00"], ["9:30pm", "21:30"], ["12am", "00:00"], ["12pm", "12:00"], ["23:59", "23:59"],
	["9", undefined], ["24:00", undefined], ["9:60", undefined], ["13pm", undefined], ["noon", undefined],
] as Array<[string, string | undefined]>) check(`clock "${text}"`, parseClock(text), want);

console.log("\n--- weekdays ---");
for (const [input, want] of [
	[undefined, { ok: true, value: undefined }],
	[["mon", "fri"], { ok: true, value: [1, 5] }],
	["weekdays", { ok: true, value: [1, 2, 3, 4, 5] }],
	[["weekends"], { ok: true, value: [0, 6] }],
	[["Friday", "monday", "mon"], { ok: true, value: [1, 5] }],
	["mon, wed", { ok: true, value: [1, 3] }],
	[["weekdays", "weekends"], { ok: true, value: undefined }],
	[["funday"], { ok: false, error: '"funday" is not a weekday' }],
] as Array<[unknown, unknown]>) check(`weekdays ${JSON.stringify(input)}`, parseWeekdays(input), want);

console.log("\n--- one-time moments (now: Thu 24 Sep 2026 16:05) ---");
{
	const moment = (text: string) => {
		const parsed = parseAt(text, NOW);
		return parsed.ok ? clock(parsed.value) : `ERR ${parsed.error}`;
	};
	const cases: Array<[string, string, string]> = [
		["a clock time still ahead today is today", "17:00", "2026-09-24 17:00"],
		["a clock time already past is tomorrow", "15:20", "2026-09-25 15:20"],
		["today, explicitly", "today 18:30", "2026-09-24 18:30"],
		["tomorrow", "tomorrow 9am", "2026-09-25 09:00"],
		["a spaced am/pm is one clock time", "9:30 pm", "2026-09-24 21:30"],
		["a weekday is the next one", "mon 09:00", "2026-09-28 09:00"],
		["today's weekday still ahead is today", "thu 17:00", "2026-09-24 17:00"],
		["today's weekday already past is next week", "thursday 09:00", "2026-10-01 09:00"],
		["a full local date and time", "2026-10-03 08:30", "2026-10-03 08:30"],
		["an ISO time with an offset is that instant", "2026-09-25T13:00:00Z", "2026-09-25 09:00"],
	];
	for (const [label, text, want] of cases) check(label, moment(text), want);
	checkTrue("today at a past time is refused as the past", moment("today 15:00").includes("in the past"));
	checkTrue("a past date is refused", moment("2020-01-01 10:00").includes("in the past"));
	checkTrue("words that are no time are refused, with the forms named", moment("sometime soon").includes('"tomorrow 09:00"'));
	// Date would roll an impossible date on to a real one; it must be refused instead.
	for (const impossible of ["2026-09-31 09:00", "2026-13-01 09:00", "2026-10-00 09:00", "2026-09-25 09:00:75", "2026-09-31T09:00:00+08:00"]) {
		checkTrue(`an impossible date "${impossible}" is refused`, moment(impossible).startsWith("ERR"));
	}
	// The night the clocks go back, 01:00-02:00 happens twice. At 01:10 in the
	// second pass, the next 01:30 is 20 minutes away, not tomorrow.
	const secondPass = at(2026, 11, 1, 1, 10) + HOUR;
	const repeated = parseAt("01:30", secondPass);
	check("in the repeated hour, a clock time still ahead is the second one", repeated.ok ? (repeated.value - secondPass) / MIN : "ERR", 20);
	const repeatedToday = parseAt("today 01:30", secondPass);
	check("and so is \"today\" at that time", repeatedToday.ok ? (repeatedToday.value - secondPass) / MIN : "ERR", 20);
	checkTrue("a bare hour is refused", moment("9").startsWith("ERR"));
}

console.log("\n--- a rule from the fields ---");
{
	const rule = (input: Record<string, unknown>) => {
		const parsed = validateWhen(input, NOW);
		return parsed.ok ? parsed.value : `ERR ${parsed.error}`;
	};
	check("in is once, that long from now", rule({ in: "20m" }), { kind: "once", at: NOW + 20 * MIN });
	check("at is once, at that moment", rule({ at: "tomorrow 9am" }), { kind: "once", at: at(2026, 9, 25, 9) });
	check("every is an interval", rule({ every: "2h" }), { kind: "every", everyMs: 2 * HOUR });
	check("daily is a local clock time", rule({ daily: "9am" }), { kind: "daily", time: "09:00" });
	check("daily with weekdays", rule({ daily: "09:00", weekdays: ["weekdays"] }), { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] });
	check("all seven days is every day", rule({ daily: "09:00", weekdays: ["weekdays", "weekends"] }), { kind: "daily", time: "09:00" });
	checkTrue("two rules are refused", String(rule({ in: "20m", every: "1h" })).includes("exactly one"));
	checkTrue("no rule is refused", String(rule({})).includes("exactly one"));
	checkTrue("an empty field does not count as given", String(rule({ in: " ", every: "1h" })).startsWith("ERR") === false);
	checkTrue("an interval under a minute is refused", String(rule({ every: "30s" })).includes("minimum"));
	checkTrue("weekdays without daily is refused", String(rule({ every: "1h", weekdays: ["mon"] })).includes("only to daily"));
	checkTrue("a bad weekday is refused", String(rule({ daily: "09:00", weekdays: ["someday"] })).includes("not a weekday"));
	checkTrue("a bad clock time is refused", String(rule({ daily: "25:00" })).includes("not a clock time"));
	// A model filling every key of the template leaves the unused ones empty.
	check("an empty weekdays is not given", rule({ in: "20m", at: "", every: "", daily: "", weekdays: [] }), { kind: "once", at: NOW + 20 * MIN });
	check("and on daily it means every day", rule({ daily: "09:00", weekdays: "" }), { kind: "daily", time: "09:00" });
}

// ---------------------------------------------------------- next and last due

console.log("\n--- next due time ---");
{
	const s = (when: any, createdAt = NOW, lastDueAt?: number) => ({ id: "s1", prompt: "p", when, createdAt, ...(lastDueAt !== undefined ? { lastDueAt } : {}) });
	const next = (schedule: any, after: number) => {
		const t = nextFire(schedule, after);
		return t === undefined ? undefined : clock(t);
	};
	const cases: Array<[string, any, number, string | undefined]> = [
		["once, ahead", s({ kind: "once", at: at(2026, 9, 25, 9) }), NOW, "2026-09-25 09:00"],
		["once, already run", s({ kind: "once", at: at(2026, 9, 25, 9) }, NOW, at(2026, 9, 25, 9)), NOW, undefined],
		["every 2h counts from its creation", s({ kind: "every", everyMs: 2 * HOUR }), NOW + 3 * HOUR, clock(NOW + 4 * HOUR)],
		["daily, later today", s({ kind: "daily", time: "17:00" }), NOW, "2026-09-24 17:00"],
		["daily, already past today, is tomorrow", s({ kind: "daily", time: "09:00" }), NOW, "2026-09-25 09:00"],
		["weekdays wrap from Friday to Monday", s({ kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }), at(2026, 9, 25, 10), "2026-09-28 09:00"],
		["a weekday rule on its day, before the time, is today", s({ kind: "daily", time: "09:00", weekdays: [1] }), at(2026, 9, 28, 8), "2026-09-28 09:00"],
		["a weekday rule on its day, after the time, is next week", s({ kind: "daily", time: "09:00", weekdays: [1] }), at(2026, 9, 28, 10), "2026-10-05 09:00"],
		// Daylight saving: 09:00 stays 09:00, on both sides of each change.
		["09:00 on the spring-forward day is still 09:00", s({ kind: "daily", time: "09:00" }), at(2026, 3, 7, 10), "2026-03-08 09:00"],
		["09:00 on the fall-back day is still 09:00", s({ kind: "daily", time: "09:00" }), at(2026, 10, 31, 10), "2026-11-01 09:00"],
		// 02:30 does not exist on 8 March: it runs at 03:30 rather than being skipped.
		["a time lost to spring-forward runs an hour late", s({ kind: "daily", time: "02:30" }), at(2026, 3, 7, 10), "2026-03-08 03:30"],
	];
	for (const [label, schedule, after, want] of cases) check(label, next(schedule, after), want);
	const spring = nextFire(s({ kind: "daily", time: "09:00" }), at(2026, 3, 7, 10))!;
	check("across spring-forward the gap is 23 hours, not 24", (spring - at(2026, 3, 7, 9)) / HOUR, 23);
}

console.log("\n--- last due time (what fires now) ---");
{
	const s = (when: any, createdAt: number, lastDueAt?: number) => ({ id: "s1", prompt: "p", when, createdAt, ...(lastDueAt !== undefined ? { lastDueAt } : {}) });
	const last = (schedule: any, now: number) => {
		const t = lastDue(schedule, now);
		return t === undefined ? undefined : clock(t);
	};
	const created = at(2026, 9, 21, 8); // Monday 08:00
	const daily = { kind: "daily", time: "09:00" };
	const cases: Array<[string, any, number, string | undefined]> = [
		["once, due", s({ kind: "once", at: NOW }, created), NOW + MIN, clock(NOW)],
		["once, not yet", s({ kind: "once", at: NOW + HOUR }, created), NOW, undefined],
		["once, already run", s({ kind: "once", at: NOW }, created, NOW), NOW + MIN, undefined],
		["every, before its first run", s({ kind: "every", everyMs: 2 * HOUR }, NOW), NOW + HOUR, undefined],
		["every, three runs missed: only the last one fires", s({ kind: "every", everyMs: 2 * HOUR }, NOW, NOW + 2 * HOUR), NOW + 9 * HOUR, clock(NOW + 8 * HOUR)],
		["every, already served", s({ kind: "every", everyMs: 2 * HOUR }, NOW, NOW + 8 * HOUR), NOW + 9 * HOUR, undefined],
		["daily, missed Mon to Thu: only Thursday fires", s(daily, created), at(2026, 9, 24, 12), "2026-09-24 09:00"],
		["daily, today's run already served", s(daily, created, at(2026, 9, 24, 9)), at(2026, 9, 24, 12), undefined],
		["daily, made after today's time: not due until tomorrow", s(daily, at(2026, 9, 24, 10)), at(2026, 9, 24, 11), undefined],
		["weekdays, on Saturday: Friday's run is the one", s({ kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, created, at(2026, 9, 24, 9)), at(2026, 9, 26, 12), "2026-09-25 09:00"],
	];
	for (const [label, schedule, now, want] of cases) check(label, last(schedule, now), want);
}

// --------------------------------------------------------------- reading back

console.log("\n--- reading a rule back ---");
{
	check("once", describeWhen({ kind: "once", at: at(2026, 9, 25, 9) }, NOW), "once, tomorrow 09:00");
	check("every, in whole hours", describeWhen({ kind: "every", everyMs: 2 * HOUR }, NOW), "every 2 hours");
	check("every, in minutes", describeWhen({ kind: "every", everyMs: 90 * MIN }, NOW), "every 90 minutes");
	check("every, one day", formatInterval(DAY), "1 day");
	check("daily", describeWhen({ kind: "daily", time: "09:00" }, NOW), "every day at 09:00");
	check("weekdays", describeWhen({ kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, NOW), "every weekday at 09:00");
	check("weekends", describeWhen({ kind: "daily", time: "10:00", weekdays: [0, 6] }, NOW), "every Saturday and Sunday at 10:00");
	check("chosen days", describeWhen({ kind: "daily", time: "09:00", weekdays: [1, 3] }, NOW), "every Mon, Wed at 09:00");
	check("a moment today", formatTime(at(2026, 9, 24, 17), NOW), "today 17:00");
	check("a moment next week", formatTime(at(2026, 9, 28, 9), NOW), "Mon 28 Sep 09:00");
	check("a moment next year says the year", formatTime(at(2027, 1, 4, 9), NOW), "Mon 4 Jan 2027 09:00");
	check("relative, minutes", formatRelative(NOW + 20 * MIN, NOW), "in 20 min");
	check("relative, hours and minutes", formatRelative(NOW + 3 * HOUR + 5 * MIN, NOW), "in 3 h 5 min");
	check("relative, days and hours", formatRelative(NOW + 2 * DAY + 4 * HOUR, NOW), "in 2 d 4 h");
	check("relative, past", formatRelative(NOW - MIN, NOW), "now");
	check("relative, rounding carries into the hour", formatRelative(NOW + 2 * HOUR - 15_000, NOW), "in 2 h");
	check("relative, and into the day", formatRelative(NOW + DAY - 10_000, NOW), "in 1 d");
	checkTrue("a slash command is a command", isCommand("  /recap"));
	checkTrue("a sentence is not", !isCommand("run the tests"));
}

// -------------------------------------------------------------------- restore

console.log("\n--- restoring the list from a branch ---");
{
	const entry = (data: unknown) => ({ type: "custom", customType: ENTRY_TYPE, data });
	check("no entry is an empty list", restoreSnapshot([{ type: "message" }]), { schedules: [], nextId: 1 });
	const good = { id: "s2", prompt: "check the deploy", when: { kind: "every", everyMs: HOUR }, createdAt: NOW, lastDueAt: NOW + HOUR };
	const restored = restoreSnapshot([
		entry({ schedules: [{ ...good, id: "s1" }], nextId: 2 }),
		{ type: "message" },
		entry({
			schedules: [
				good,
				{ id: "s3", prompt: "", when: { kind: "once", at: NOW }, createdAt: NOW },
				{ id: "s4", prompt: "p", when: { kind: "every", everyMs: 1000 }, createdAt: NOW },
				{ id: "s5", prompt: "p", when: { kind: "daily", time: "9am" }, createdAt: NOW },
				{ id: "s6", prompt: "p", when: { kind: "daily", time: "09:00", weekdays: [1, 9, "x"] }, createdAt: NOW },
				"junk",
			],
			nextId: 3,
		}),
	]);
	check("the newest entry wins, bad schedules are dropped", restored.schedules.map((schedule) => schedule.id), ["s2", "s6"]);
	check("a schedule reads back whole", restored.schedules[0], good);
	check("bad weekdays are dropped, good ones kept", restored.schedules[1].when, { kind: "daily", time: "09:00", weekdays: [1] });
	check("the next id is never below one already used", restored.nextId, 7);
}

// ------------------------------------------------------------- what is sent

console.log("\n--- the text a due schedule sends ---");
{
	const schedule = { id: "s4", prompt: "check the deploy", when: { kind: "every" as const, everyMs: HOUR }, createdAt: NOW };
	const onTime = scheduledText(schedule, NOW, NOW + 30_000);
	checkTrue("it says it is scheduled, with its rule", onTime.startsWith("[Scheduled task s4, every 1 hour]"));
	checkTrue("it tells the model the user may be away", onTime.includes("the user may be away") && onTime.includes("Do not ask questions"));
	checkTrue("and ends with the prompt", onTime.endsWith("\n\ncheck the deploy"));
	const missed = scheduledText(schedule, NOW, NOW + 3 * HOUR);
	checkTrue("a missed run says when it was due", missed.includes("it was due today 16:05 and was missed"));
	check("a slash command is sent exactly as written", scheduledText({ ...schedule, prompt: " /recap " }, NOW, NOW), "/recap");
}

// ----------------------------------------------------------------- the parse

console.log("\n--- reading the /schedule model answer ---");
{
	const read = (raw: string) => {
		const parsed = readParse(raw, NOW);
		return parsed.ok ? { prompt: parsed.prompt, when: parsed.when } : `ERR ${parsed.error}`;
	};
	check("a delay", read('{"prompt":"check the deploy","in":"20m"}'), { prompt: "check the deploy", when: { kind: "once", at: NOW + 20 * MIN } });
	const kept = readParse('{"prompt":"x","in":"20m","weekdays":[]}', NOW);
	check("the raw time fields come back, to be checked again after the confirm", kept.ok ? kept.fields : kept.error, { in: "20m", weekdays: [] });
	check("weekdays at a time", read('{"prompt":"/recap","daily":"9am","weekdays":"weekdays"}'), { prompt: "/recap", when: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
	check("a fenced answer with prose around it", read('Sure:\n```json\n{"prompt":"x","every":"2h"}\n```'), { prompt: "x", when: { kind: "every", everyMs: 2 * HOUR } });
	check("the model's own error is passed on", read('{"error":"no time given"}'), "ERR no time given");
	check("no prompt", read('{"in":"20m"}'), "ERR the request says nothing to do");
	checkTrue("two rules go through the same check as the tool", String(read('{"prompt":"x","in":"20m","every":"1h"}')).includes("exactly one"));
	check("not JSON", read("I cannot"), "ERR the model did not answer with JSON");
	const request = parseRequest("in 20m check", NOW);
	checkTrue("the request carries now, the weekday and the zone", request.startsWith("Now: Thu 2026-09-24 16:05 (America/New_York)\nRequest: in 20m check"));
}

console.log("\n--- the parse model: scheduler.model, else the session model ---");
{
	const MODELS = [
		{ provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", contextWindow: 272_000 },
		{ provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", contextWindow: 400_000 },
	];
	const session = { provider: "anthropic", id: "claude-opus-5", name: "Opus" };
	check("nothing configured is the session model", selectModel(undefined, session, MODELS), { ok: true, model: session });
	check("a listed name resolves", selectModel("openai-codex/gpt-5.6-sol", session, MODELS), { ok: true, model: MODELS[1] });
	check("a full name pi does not list is a custom model of its provider", selectModel("openai-codex/gpt-6-luna", session, MODELS), { ok: true, model: { ...MODELS[0], id: "gpt-6-luna", name: "gpt-6-luna" } });
	check("a partial name inside the provider is the listed model", selectModel("openai-codex/sol", session, MODELS), { ok: true, model: MODELS[1] });
	check("an unknown provider is an error", selectModel("nobody/x", session, MODELS), { ok: false, error: 'scheduler.model "nobody/x" matched no available model' });
	check("no session model and nothing configured is an error", selectModel(undefined, undefined, MODELS), { ok: false, error: "no model selected" });
}

// -------------------------------------------------------- runtime, fake clock

/**
 * A clock the test moves by hand, and the timers set on it. Like a real
 * machine it has two clocks: timers count awake time (`mono`), while now() is
 * the wall clock. advance() moves both; sleep() moves only the wall clock, the
 * way a closed laptop does.
 */
function fakeClock(start: number) {
	let wall = start;
	let mono = 0;
	let nextHandle = 1;
	const timers = new Map<number, { due: number; callback: () => void }>();
	return {
		clock: {
			now: () => wall,
			setTimer: (callback: () => void, ms: number) => {
				const handle = nextHandle++;
				timers.set(handle, { due: mono + ms, callback });
				return handle;
			},
			clearTimer: (handle: unknown) => void timers.delete(handle as number),
		},
		/** Move time forward awake, running every timer that comes due on the way, in order. */
		advance(ms: number) {
			const end = mono + ms;
			for (;;) {
				const [handle, timer] = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
				if (!timer || timer.due > end) break;
				timers.delete(handle!);
				wall += Math.max(0, timer.due - mono);
				mono = Math.max(mono, timer.due);
				timer.callback();
			}
			wall += end - mono;
			mono = end;
		},
		/** The machine sleeps: the wall clock moves, timers do not. */
		sleep: (ms: number) => void (wall += ms),
		pending: () => timers.size,
	};
}

/**
 * A fake pi around the runtime: it saves and sends like the host, and plays
 * the agent — a sent plain prompt starts a run 100 ms later and settles 1 s
 * after that, the way agent_start and agent_settled follow a prompt in pi. A
 * command starts no run. With `refuse`, every send is refused and starts
 * nothing, as during a /compact.
 */
function fakeHost(time: ReturnType<typeof fakeClock>) {
	const log: string[] = [];
	const saved: any[] = [];
	const sent: Array<{ text: string; options: unknown; at: number }> = [];
	const notices: string[] = [];
	const agent = { busy: false, refuse: false, scheduler: undefined as any, overlaps: 0 };
	return {
		host: {
			appendEntry: (_type: string, data: any) => {
				log.push("save");
				saved.push(JSON.parse(JSON.stringify(data)));
			},
			sendUserMessage: (text: string, options: unknown) => {
				log.push("send");
				if (agent.busy) agent.overlaps++;
				sent.push({ text, options, at: time.clock.now() });
				if (agent.refuse || text.startsWith("/")) return;
				agent.busy = true;
				time.clock.setTimer(() => agent.scheduler?.onAgentStart(), 100);
				time.clock.setTimer(() => {
					agent.busy = false;
					agent.scheduler?.onAgentSettled();
				}, 1_100);
			},
			isIdle: () => !agent.busy,
			notify: (message: string) => void notices.push(message),
		},
		agent,
		log,
		saved,
		sent,
		notices,
		last: () => saved[saved.length - 1],
		/** The user runs a turn of their own for `ms`. */
		userTurn(ms: number) {
			agent.busy = true;
			time.clock.setTimer(() => {
				agent.busy = false;
				agent.scheduler?.onAgentSettled();
			}, ms);
		},
	};
}

function runtime(start: number, live = true, snapshot = { schedules: [] as any[], nextId: 1 }) {
	const time = fakeClock(start);
	const h = fakeHost(time);
	const scheduler = new Scheduler(h.host, time.clock);
	h.agent.scheduler = scheduler;
	scheduler.start(snapshot, live);
	return { time, h, scheduler };
}

console.log("\n--- runtime: once, every, save before send ---");
{
	const { time, h, scheduler } = runtime(NOW);
	const once = scheduler.add("check the deploy", { kind: "once", at: NOW + 20 * MIN });
	checkTrue("add returns the schedule", once.ok && once.schedule.id === "s1");
	check("adding saved the list", h.last().schedules.map((schedule: any) => schedule.id), ["s1"]);
	check("a one-time time that has passed is refused", scheduler.add("late", { kind: "once", at: NOW - MIN }).ok, false);
	time.advance(19 * MIN);
	check("nothing runs before it is due", h.sent.length, 0);
	time.advance(2 * MIN);
	check("it runs once when due", h.sent.length, 1);
	check("as a follow-up, with commands expanded", h.sent[0].options, { deliverAs: "followUp", expandPromptTemplates: true });
	checkTrue("with the scheduled-task header", h.sent[0].text.startsWith("[Scheduled task s1, once, today 16:25]"));
	check("the run was saved before it was sent", h.log.slice(-2), ["save", "send"]);
	check("a one-time schedule is gone once it ran", h.last().schedules, []);

	scheduler.add("run the tests", { kind: "every", everyMs: 30 * MIN });
	time.advance(95 * MIN);
	check("every 30 minutes, over 95 minutes, runs three times", h.sent.length, 4);
	check("each run records the due time it served", h.last().schedules[0].lastDueAt, time.clock.now() - 5 * MIN);
	check("no send ever went out while the agent was busy", h.agent.overlaps, 0);

	scheduler.stop();
	time.advance(DAY);
	check("after stop nothing runs", h.sent.length, 4);
}

console.log("\n--- runtime: one at a time, only when idle ---");
{
	// Two schedules due at the same moment. Sent together, the second failed
	// in pi with "already processing" and left pi's running flag wrong.
	const { time, h, scheduler } = runtime(NOW);
	scheduler.add("task one", { kind: "once", at: NOW + 10 * MIN });
	scheduler.add("task two", { kind: "once", at: NOW + 10 * MIN });
	time.advance(10 * MIN);
	check("only the first goes out at once", h.sent.length, 1);
	time.advance(2 * 1_000);
	check("the second follows when the first run has settled", h.sent.map((item) => item.text.split("\n").pop()), ["task one", "task two"]);
	checkTrue("never both at once", h.agent.overlaps === 0 && h.sent[1].at - h.sent[0].at >= 1_100);
	scheduler.stop();
}
{
	// A turn of the user's own is running when a prompt and a command come due.
	const { time, h, scheduler } = runtime(NOW);
	scheduler.add("check the deploy", { kind: "once", at: NOW + MIN });
	scheduler.add("/recap", { kind: "once", at: NOW + MIN });
	h.userTurn(5 * MIN);
	time.advance(4 * MIN);
	check("nothing interrupts the user's turn, not even a command", h.sent.length, 0);
	time.advance(MIN + 10_000);
	check("both go once the turn is over, the prompt first", h.sent.map((item) => item.text.split("\n").pop()), ["check the deploy", "/recap"]);
	check("still never while busy", h.agent.overlaps, 0);
	scheduler.stop();
}

console.log("\n--- runtime: a refused send is tried again, then reported ---");
{
	const { time, h, scheduler } = runtime(NOW);
	h.agent.refuse = true;
	scheduler.add("check the deploy", { kind: "once", at: NOW + MIN });
	time.advance(MIN);
	check("the first try goes out", h.sent.length, 1);
	time.advance(CONFIG.acceptWaitMs + CONFIG.retryMs);
	check("no run started, so it is tried again", h.sent.length, 2);
	h.agent.refuse = false;
	time.advance(CONFIG.acceptWaitMs + CONFIG.retryMs);
	check("the third try is accepted", h.sent.length, 3);
	time.advance(10 * MIN);
	check("and it is not sent again", h.sent.length, 3);
	check("nothing was reported skipped", h.notices, []);
	scheduler.stop();
}
{
	const { time, h, scheduler } = runtime(NOW);
	h.agent.refuse = true;
	scheduler.add("check the deploy", { kind: "once", at: NOW + MIN });
	time.advance(MIN + CONFIG.maxAttempts * (CONFIG.acceptWaitMs + CONFIG.retryMs));
	check(`after ${CONFIG.maxAttempts} tries it stops`, h.sent.length, CONFIG.maxAttempts);
	checkTrue("and the user is told it was skipped", h.notices.some((notice) => notice.includes("could not be sent after 5 tries")));
	scheduler.stop();
}

console.log("\n--- runtime: a reload between save and send cannot run a task twice ---");
{
	const a = runtime(NOW);
	a.scheduler.add("run the tests", { kind: "every", everyMs: HOUR });
	a.time.advance(HOUR + 10_000);
	check("the first instance ran it", a.h.sent.length, 1);
	a.scheduler.stop();
	// /reload: a new instance restores what the session holds, at the same moment.
	const b = runtime(a.time.clock.now(), true, a.h.last());
	b.time.advance(0);
	check("the restored instance does not run it again", b.h.sent.length, 0);
	b.time.advance(HOUR);
	check("but runs the next one", b.h.sent.length, 1);
	b.scheduler.stop();
}

console.log("\n--- runtime: missed while pi was closed ---");
{
	const monday = at(2026, 9, 21, 8);
	const snapshot = {
		schedules: [
			{ id: "s1", prompt: "standup notes", when: { kind: "daily" as const, time: "09:00" }, createdAt: monday, lastDueAt: at(2026, 9, 21, 9) },
			{ id: "s2", prompt: "/recap", when: { kind: "once" as const, at: at(2026, 9, 23, 12) }, createdAt: monday },
		],
		nextId: 3,
	};
	// pi opens again on Thursday at noon: Tue, Wed and Thu 09:00 were missed.
	const { time, h, scheduler } = runtime(at(2026, 9, 24, 12), true, snapshot);
	time.advance(5_000);
	check("each schedule runs once, not once per missed day", h.sent.length, 2);
	checkTrue("the daily one says it was missed", h.sent.some((item) => item.text.includes("standup notes") && item.text.includes("it was due today 09:00 and was missed")));
	checkTrue("the missed command is sent as the command", h.sent.some((item) => item.text === "/recap"));
	checkTrue("and the user is told it was missed", h.notices.some((notice) => notice.includes("s2 was due") && notice.includes("missed")));
	check("the daily one now waits for tomorrow", clock(scheduler.nextFor(scheduler.list()[0])!), "2026-09-25 09:00");
	time.advance(DAY);
	check("and runs then", h.sent.length, 3);
	scheduler.stop();
}

console.log("\n--- runtime: print mode keeps the list but fires nothing ---");
{
	const due = { schedules: [{ id: "s1", prompt: "late", when: { kind: "once" as const, at: NOW - HOUR }, createdAt: NOW - DAY }], nextId: 2 };
	const { time, h, scheduler } = runtime(NOW, false, due);
	time.advance(DAY);
	check("an overdue schedule does not fire in a pi -p run", h.sent.length, 0);
	check("it is still listed", scheduler.list().map((schedule) => schedule.id), ["s1"]);
	checkTrue("and the list can still change", scheduler.add("x", { kind: "every", everyMs: HOUR }).ok && h.last().schedules.length === 2);
	check("with no timer set", time.pending(), 0);
}

console.log("\n--- runtime: cancel, the cap, a sleeping machine ---");
{
	const { time, h, scheduler } = runtime(NOW);
	scheduler.add("a", { kind: "every", everyMs: HOUR });
	scheduler.add("b", { kind: "every", everyMs: HOUR });
	check("cancel one", scheduler.cancel("S1").map((schedule) => schedule.id), ["s1"]);
	check("an unknown id cancels nothing", scheduler.cancel("s9"), []);
	check("ids are not reused", (scheduler.add("c", { kind: "every", everyMs: HOUR }) as any).schedule.id, "s3");
	check("cancel all", scheduler.cancel("all").length, 2);
	check("and the list is saved empty", h.last().schedules, []);
	for (let i = 0; i < CONFIG.maxSchedules; i++) scheduler.add(`x${i}`, { kind: "every", everyMs: HOUR });
	checkTrue("past the cap, add is refused", !scheduler.add("one too many", { kind: "every", everyMs: HOUR }).ok);
	scheduler.cancel("all");

	// A timer never waits longer than a minute, so a machine that sleeps past a
	// due time runs it within a minute of waking, whatever the timer thought.
	scheduler.add("far off", { kind: "once", at: NOW + 10 * DAY });
	time.advance(0);
	time.sleep(10 * DAY + 5 * MIN);
	check("while asleep past the due time, nothing has run", h.sent.length, 0);
	time.advance(CONFIG.maxTimerMs);
	check("the due task runs within a minute of waking", h.sent.length, 1);
	scheduler.stop();
}

// ------------------------------------------------------------- wiring, fake pi

console.log("\n--- wiring: the tool and the commands against a fake pi ---");
{
	const time = fakeClock(NOW);
	const entries: any[] = [];
	const makePi = () => {
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		const handlers = new Map<string, Function>();
		const sent: Array<{ text: string; options: unknown }> = [];
		const pi = {
			registerTool: (tool: any) => tools.set(tool.name, tool),
			registerCommand: (name: string, command: any) => commands.set(name, command),
			on: (event: string, handler: Function) => handlers.set(event, handler),
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
			// Like pi, a plain prompt starts a run (agent_start) and settles; a command does not.
			sendUserMessage: (text: string, options: unknown) => {
				sent.push({ text, options });
				if (text.startsWith("/")) return;
				time.clock.setTimer(() => handlers.get("agent_start")?.({}), 100);
				time.clock.setTimer(() => handlers.get("agent_settled")?.({}), 1_100);
			},
			getCommands: () => [{ name: "recap", source: "extension" }, { name: "skill:pptx", source: "skill" }],
			events: { emit: () => {} },
		};
		return { pi, tools, commands, handlers, sent };
	};
	const notices: Array<[string, string]> = [];
	// The branch view pi would give after /tree back to before a run: only the
	// entries up to the first snapshot. restoreSnapshot must not use it.
	let branchCut = Infinity;
	const ctx: any = {
		hasUI: true,
		cwd: ROOT,
		isIdle: () => true,
		ui: { notify: (message: string, level: string) => notices.push([level, message]) },
		sessionManager: { getEntries: () => entries, getBranch: () => entries.slice(0, branchCut) },
	};

	const first = makePi();
	install(first.pi as never, time.clock);
	first.handlers.get("session_start")!({ reason: "startup" }, ctx);
	const tool = first.tools.get("schedule");
	checkTrue("the tool is registered, and its description needs no date", !!tool && tool.description.includes("tomorrow 9am"));

	const added = await tool.execute("t1", { action: "add", prompt: "check the deploy", in: "20m" });
	checkTrue("add starts with the full date", added.content[0].text.startsWith("Now: Thu 24 Sep 2026 16:05 (America/New_York)."));
	checkTrue("and reads the time back", added.content[0].text.includes("once, today 16:25 (in 20 min)"));
	checkTrue("and says where it runs", added.content[0].text.includes("while pi is open"));
	branchCut = entries.length;
	await tool.execute("t2", { action: "add", prompt: "/recap", daily: "09:00", weekdays: ["weekdays"] });
	const listed = await tool.execute("t3", { action: "list" });
	checkTrue("list gives the date and both schedules", listed.content[0].text.startsWith("Now: Thu 24 Sep 2026 16:05") && listed.content[0].text.includes("s1") && listed.content[0].text.includes("every weekday at 09:00; next tomorrow 09:00"));

	const refused = async (params: any) => {
		try {
			await tool.execute("t", params);
			return "";
		} catch (error) {
			return (error as Error).message;
		}
	};
	checkTrue("two rules are refused", (await refused({ action: "add", prompt: "x", in: "5m", at: "17:00" })).includes("exactly one"));
	checkTrue("an error carries the date too", (await refused({ action: "add", prompt: "x", in: "5m", at: "17:00" })).includes("Now: Thu 24 Sep 2026"));
	checkTrue("a missing prompt is refused", (await refused({ action: "add", in: "5m" })).includes("needs a prompt"));
	checkTrue("an unknown action is refused", (await refused({ action: "snooze" })).includes("Use add, list or cancel"));
	checkTrue("cancelling an unknown id lists what there is", (await refused({ action: "cancel", id: "s9" })).includes("s2"));
	// pi's built-ins run only from the editor; a scheduled "/compact" would reach the model as text.
	checkTrue("a built-in command is refused", (await refused({ action: "add", prompt: "/compact", every: "2h" })).includes("not a command a schedule can run"));
	check("a skill is allowed", (await refused({ action: "add", prompt: "/skill:pptx make the deck", in: "1h" })), "");
	checkTrue("an empty weekdays does not block a one-time schedule", (await refused({ action: "add", prompt: "x", in: "30m", weekdays: [] })) === "");

	time.advance(21 * MIN);
	check("the one-time schedule ran through pi", first.sent.length, 1);

	// /tree back to before that run, then /reload: the list comes from the
	// newest snapshot in the file, so the task that ran does not come back.
	first.handlers.get("session_shutdown")!({}, ctx);
	const second = makePi();
	install(second.pi as never, time.clock);
	second.handlers.get("session_start")!({ reason: "reload" }, ctx);
	time.advance(5_000);
	check("after /tree and a reload nothing runs twice", second.sent.length + first.sent.length, 1);
	const secondTool = second.tools.get("schedule");
	checkTrue("the restored list still has the daily one", (await secondTool.execute("t4", { action: "list" })).content[0].text.includes("s2"));

	await second.commands.get("schedules").handler("cancel s2", ctx);
	checkTrue("/schedules cancel <id> cancels", notices.some(([, message]) => message === "Cancelled s2."));
	await second.commands.get("schedule").handler("", ctx);
	checkTrue("/schedule with no words shows the usage", notices.some(([, message]) => message.startsWith("Usage: /schedule")));
	await second.commands.get("schedule").handler("in 5m say hi", { ...ctx, hasUI: false });
	checkTrue("/schedule without a UI says to ask in chat, with no model call", notices.some(([level, message]) => level === "error" && message.includes("in chat")));
	second.handlers.get("session_shutdown")!({}, ctx);

	// A fork copies the old session's entries, a pending schedule included.
	const forkEntries = [{ type: "custom", customType: ENTRY_TYPE, data: { schedules: [{ id: "s1", prompt: "copied", when: { kind: "every", everyMs: HOUR }, createdAt: NOW - DAY }], nextId: 2 } }];
	const forked = makePi();
	const forkCtx = { ...ctx, sessionManager: { getEntries: () => forkEntries, getBranch: () => forkEntries } };
	forked.pi.appendEntry = (customType: string, data: unknown) => void forkEntries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) });
	install(forked.pi as never, time.clock);
	forked.handlers.get("session_start")!({ reason: "fork" }, forkCtx);
	time.advance(5_000);
	check("a fork does not run the copied schedule", forked.sent.length, 0);
	check("it starts with an empty list of its own, saved", (forkEntries[forkEntries.length - 1].data as any).schedules, []);
	forked.handlers.get("session_shutdown")!({}, forkCtx);

	// pi -p: no UI, so the list is kept but nothing fires into the one-shot run.
	const printed = makePi();
	const due = [{ type: "custom", customType: ENTRY_TYPE, data: { schedules: [{ id: "s1", prompt: "late", when: { kind: "once", at: NOW - HOUR }, createdAt: NOW - DAY }], nextId: 2 } }];
	install(printed.pi as never, time.clock);
	printed.handlers.get("session_start")!({ reason: "startup" }, { ...ctx, hasUI: false, sessionManager: { getEntries: () => due, getBranch: () => due } });
	time.advance(HOUR);
	check("in print mode an overdue schedule does not fire", printed.sent.length, 0);
	printed.handlers.get("session_shutdown")!({}, ctx);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
