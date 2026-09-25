/**
 * The schedule rules: reading the words a tool call or a parse gives, the next
 * and the last due time of a schedule, how it reads back in words, and
 * restoring the list from a session branch. All pure; the clock is a
 * parameter, so every rule is testable at a fixed moment.
 *
 * ## Why no cron
 *
 * The requests this has to serve are "in 20 minutes", "at 3pm", "every 2
 * hours" and "every weekday at 9". Three closed rules cover them (config.ts),
 * and each one reads back in plain words without a cron-to-English layer. A
 * cron parser would be the largest file here and would buy "the second Tuesday
 * of the month", which nobody asked for.
 *
 * ## Local time, not offsets
 *
 * A `daily` rule stores the wall-clock time ("09:00"), and every next time is
 * built with the local-time Date constructor on the day in question. So 09:00
 * stays 09:00 across a daylight-saving change, where a stored offset would
 * move it by an hour. On the one night a local time does not exist (the
 * spring-forward gap), Date moves it forward, and the task runs an hour late
 * rather than being skipped.
 */

import { CONFIG, ENTRY_TYPE, type Schedule, type SchedulerSnapshot, type When } from "./config.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WEEKDAY_WORDS: Record<string, number> = {
	sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
	thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const UNIT_MS: Record<string, number> = {
	s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
	m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
	h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
	d: DAY, day: DAY, days: DAY,
};

/** "20m", "1h30m", "2 hours", "1h 15m" to milliseconds; undefined when anything is left over. */
export function parseDuration(text: string): number | undefined {
	const source = text.trim().toLowerCase();
	if (!source) return undefined;
	const token = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/y;
	let total = 0;
	let index = 0;
	while (index < source.length) {
		token.lastIndex = index;
		const match = token.exec(source);
		if (!match) return undefined;
		const unit = UNIT_MS[match[2]];
		if (unit === undefined) return undefined;
		total += Number(match[1]) * unit;
		index = token.lastIndex;
	}
	return total > 0 ? Math.round(total) : undefined;
}

/** "9:05", "09:05", "9am", "9:30pm" to "HH:MM"; a bare "9" is refused, it could mean either half of the day. */
export function parseClock(text: string): string | undefined {
	const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim().toLowerCase());
	if (!match || (match[2] === undefined && match[3] === undefined)) return undefined;
	let hours = Number(match[1]);
	const minutes = match[2] === undefined ? 0 : Number(match[2]);
	if (minutes > 59) return undefined;
	if (match[3]) {
		if (hours < 1 || hours > 12) return undefined;
		hours = (hours % 12) + (match[3] === "pm" ? 12 : 0);
	} else if (hours > 23) {
		return undefined;
	}
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Weekday names, or the groups "weekdays"/"weekends", to sorted day numbers; undefined means every day. */
export function parseWeekdays(input: unknown): Parsed<number[] | undefined> {
	if (input === undefined || input === null) return { ok: true, value: undefined };
	const words = (Array.isArray(input) ? input : [input]).flatMap((item) => String(item).toLowerCase().split(/[\s,]+/)).filter(Boolean);
	const days = new Set<number>();
	for (const word of words) {
		if (word === "weekdays" || word === "weekday") [1, 2, 3, 4, 5].forEach((day) => days.add(day));
		else if (word === "weekends" || word === "weekend") [0, 6].forEach((day) => days.add(day));
		else if (word === "daily" || word === "everyday" || word === "all") [0, 1, 2, 3, 4, 5, 6].forEach((day) => days.add(day));
		else if (WEEKDAY_WORDS[word] !== undefined) days.add(WEEKDAY_WORDS[word]);
		else return { ok: false, error: `"${word}" is not a weekday` };
	}
	if (days.size === 0 || days.size === 7) return { ok: true, value: undefined };
	return { ok: true, value: [...days].sort((a, b) => a - b) };
}

/** The local time `clock` ("HH:MM") on the day of `day`, `offset` days later. */
function onDay(day: number, offset: number, clock: string): number {
	const base = new Date(day);
	const [hours, minutes] = clock.split(":").map(Number);
	return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hours, minutes, 0, 0).getTime();
}

/**
 * The clock time today that is still ahead, if there is one. On the night the
 * clocks go back, an hour happens twice and Date always builds the first one;
 * once that has passed, the second one an hour later may still be ahead.
 */
function laterToday(now: number, clock: string): number | undefined {
	const first = onDay(now, 0, clock);
	if (first > now) return first;
	const second = new Date(first + HOUR);
	const same = `${String(second.getHours()).padStart(2, "0")}:${String(second.getMinutes()).padStart(2, "0")}` === clock;
	return same && second.getTime() > now ? second.getTime() : undefined;
}

/** Whether a year, month (1-12) and day name a real date: Date would roll 31 September on to 1 October. */
function realDate(year: number, month: number, day: number): boolean {
	const date = new Date(year, month - 1, day);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * A one-time moment from the forms a model can write without knowing today's
 * date (pi's system prompt does not carry it): "15:20" (the next 15:20),
 * "today 15:20", "tomorrow 9am", "mon 09:00" (the next Monday at 09:00, today
 * if still ahead), and a full "YYYY-MM-DD HH:MM" in local time or ISO 8601 with
 * an offset. The moment must be in the future.
 */
export function parseAt(text: string, now: number): Parsed<number> {
	const source = text.trim();
	// "9:30 pm" is one clock time, not two words.
	const words = source.toLowerCase().replace(/(\d)\s+(am|pm)\b/g, "$1$2").split(/\s+/);
	let at: number | undefined;

	const dated = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2})(?::(\d{2}))?$/.exec(source);
	const offsetIso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(source);
	if (dated) {
		const clock = parseClock(dated[4]);
		const [year, month, day, seconds] = [Number(dated[1]), Number(dated[2]), Number(dated[3]), Number(dated[5] ?? 0)];
		if (clock && realDate(year, month, day) && seconds <= 59) {
			const [hours, minutes] = clock.split(":").map(Number);
			at = new Date(year, month - 1, day, hours, minutes, seconds, 0).getTime();
		}
	} else if (offsetIso) {
		const [year, month, day, hours, minutes, seconds] = offsetIso.slice(1, 7).map((part) => Number(part ?? 0));
		if (realDate(year, month, day) && hours <= 23 && minutes <= 59 && seconds <= 59) {
			const parsed = Date.parse(source);
			if (!Number.isNaN(parsed)) at = parsed;
		}
	} else if (words.length === 1 || words.length === 2) {
		const clock = parseClock(words[words.length - 1]);
		const day = words.length === 2 ? words[0] : undefined;
		if (clock && day === undefined) {
			at = laterToday(now, clock) ?? onDay(now, 1, clock);
		} else if (clock && day === "today") {
			at = laterToday(now, clock) ?? onDay(now, 0, clock);
		} else if (clock && day === "tomorrow") {
			at = onDay(now, 1, clock);
		} else if (clock && day !== undefined && WEEKDAY_WORDS[day] !== undefined) {
			const ahead = (WEEKDAY_WORDS[day] - new Date(now).getDay() + 7) % 7;
			at = onDay(now, ahead, clock);
			if (at <= now) at = onDay(now, ahead + 7, clock);
		}
	}

	if (at === undefined || Number.isNaN(at)) {
		return { ok: false, error: `"${text}" is not a time — use "15:20", "tomorrow 09:00", "mon 9am" or "YYYY-MM-DD HH:MM"` };
	}
	if (at <= now) return { ok: false, error: `"${text}" is ${formatTime(at, now)}, which is in the past` };
	return { ok: true, value: at };
}

/** The fields a tool call or a parse may give; exactly one of in / at / every / daily. */
export interface WhenInput {
	in?: unknown;
	at?: unknown;
	every?: unknown;
	daily?: unknown;
	weekdays?: unknown;
}

/** Tool-call or parse fields to a rule, or the reason they do not make one. */
export function validateWhen(input: WhenInput, now: number): Parsed<When> {
	const given = (["in", "at", "every", "daily"] as const).filter((key) => input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== "");
	if (given.length !== 1) {
		return { ok: false, error: `give exactly one of in, at, every or daily${given.length > 1 ? ` (got ${given.join(", ")})` : ""}` };
	}
	const key = given[0];
	const value = String(input[key]).trim();
	// An empty weekdays is not given, the same as an empty in/at/every/daily: a
	// model that fills every key of the template leaves the unused ones empty.
	const hasWeekdays = input.weekdays !== undefined && input.weekdays !== null && !(Array.isArray(input.weekdays) && input.weekdays.length === 0) && String(input.weekdays).trim() !== "";
	if (key !== "daily" && hasWeekdays) {
		return { ok: false, error: "weekdays applies only to daily" };
	}
	if (key === "in") {
		const ms = parseDuration(value);
		if (ms === undefined) return { ok: false, error: `in "${value}" is not a duration — use "20m", "1h30m" or "2d"` };
		return { ok: true, value: { kind: "once", at: now + ms } };
	}
	if (key === "at") {
		const at = parseAt(value, now);
		return at.ok ? { ok: true, value: { kind: "once", at: at.value } } : at;
	}
	if (key === "every") {
		const ms = parseDuration(value);
		if (ms === undefined) return { ok: false, error: `every "${value}" is not a duration — use "30m", "2h" or "1d"` };
		if (ms < CONFIG.minEveryMs) return { ok: false, error: `every "${value}" is shorter than the minimum of 1 minute` };
		return { ok: true, value: { kind: "every", everyMs: ms } };
	}
	const time = parseClock(value);
	if (!time) return { ok: false, error: `daily "${value}" is not a clock time — use "09:00" or "9am"` };
	const weekdays = parseWeekdays(hasWeekdays ? input.weekdays : undefined);
	if (!weekdays.ok) return weekdays;
	return { ok: true, value: weekdays.value ? { kind: "daily", time, weekdays: weekdays.value } : { kind: "daily", time } };
}

function allowed(when: Extract<When, { kind: "daily" }>, time: number): boolean {
	return !when.weekdays || when.weekdays.includes(new Date(time).getDay());
}

/** The first time the schedule is due strictly after `after`, or undefined when it never is again. */
export function nextFire(schedule: Schedule, after: number): number | undefined {
	const { when } = schedule;
	if (when.kind === "once") return schedule.lastDueAt === undefined && when.at > after ? when.at : undefined;
	if (when.kind === "every") {
		const k = Math.max(1, Math.floor((after - schedule.createdAt) / when.everyMs) + 1);
		return schedule.createdAt + k * when.everyMs;
	}
	// Eight days always holds an allowed weekday; the eighth covers today's time already passed.
	for (let offset = 0; offset <= 7; offset++) {
		const candidate = onDay(after, offset, when.time);
		if (candidate > after && allowed(when, candidate)) return candidate;
	}
	return undefined;
}

/**
 * The due time that should fire at `now`: the LAST occurrence after the
 * previous run (or after creation) and not after now. Only the last one, so a
 * schedule missed three times while pi was closed runs once, not three times.
 */
export function lastDue(schedule: Schedule, now: number): number | undefined {
	const { when } = schedule;
	const floor = schedule.lastDueAt ?? schedule.createdAt;
	if (when.kind === "once") return schedule.lastDueAt === undefined && when.at <= now ? when.at : undefined;
	if (when.kind === "every") {
		const k = Math.floor((now - schedule.createdAt) / when.everyMs);
		const candidate = schedule.createdAt + k * when.everyMs;
		return k >= 1 && candidate > floor ? candidate : undefined;
	}
	for (let offset = 0; offset >= -7; offset--) {
		const candidate = onDay(now, offset, when.time);
		if (candidate <= now && allowed(when, candidate)) return candidate > floor ? candidate : undefined;
	}
	return undefined;
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** An interval in the largest whole unit: "2 hours", "90 minutes", "1 day". */
export function formatInterval(ms: number): string {
	if (ms % DAY === 0) return plural(ms / DAY, "day");
	if (ms % HOUR === 0) return plural(ms / HOUR, "hour");
	if (ms % MINUTE === 0) return plural(ms / MINUTE, "minute");
	return plural(Math.round(ms / 1000), "second");
}

/** How far away `time` is: "in 20 min", "in 3 h 5 min", "in 2 d 4 h", or "now". */
export function formatRelative(time: number, now: number): string {
	const delta = time - now;
	if (delta < MINUTE) return delta <= 0 ? "now" : "in under a minute";
	// Round once, to whole minutes, then split: rounding the minutes alone
	// would give "1 h 60 min" for 1 h 59 min 45 s.
	const total = Math.round(delta / MINUTE);
	const days = Math.floor(total / (24 * 60));
	const hours = Math.floor((total % (24 * 60)) / 60);
	const minutes = total % 60;
	if (days > 0) return `in ${days} d${hours > 0 ? ` ${hours} h` : ""}`;
	if (hours > 0) return `in ${hours} h${minutes > 0 ? ` ${minutes} min` : ""}`;
	return `in ${minutes} min`;
}

/** A local moment for reading back: "today 15:20", "tomorrow 09:00", "Mon 29 Sep 09:00". */
export function formatTime(time: number, now: number): string {
	const date = new Date(time);
	const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	const dayDiff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
	if (dayDiff === 0) return `today ${clock}`;
	if (dayDiff === 1) return `tomorrow ${clock}`;
	if (dayDiff === -1) return `yesterday ${clock}`;
	const year = date.getFullYear() === today.getFullYear() ? "" : ` ${date.getFullYear()}`;
	return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${year} ${clock}`;
}

/** The rule in words: "once, today 15:20", "every 2 hours", "every weekday at 09:00". */
export function describeWhen(when: When, now: number): string {
	if (when.kind === "once") return `once, ${formatTime(when.at, now)}`;
	if (when.kind === "every") return `every ${formatInterval(when.everyMs)}`;
	const days = when.weekdays;
	let which = "day";
	if (days && days.join() === "1,2,3,4,5") which = "weekday";
	else if (days && days.join() === "0,6") which = "Saturday and Sunday";
	else if (days) which = days.map((day) => DAY_NAMES[day]).join(", ");
	return `every ${which} at ${when.time}`;
}

/** A prompt that pi runs as a command (or skill, or template) rather than sending to the model. */
export function isCommand(prompt: string): boolean {
	return prompt.trimStart().startsWith("/");
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A stored When, re-checked: a session file is input, not a promise. */
function readWhen(raw: unknown): When | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const when = raw as Record<string, unknown>;
	if (when.kind === "once" && asNumber(when.at) !== undefined) return { kind: "once", at: when.at as number };
	if (when.kind === "every" && (asNumber(when.everyMs) ?? 0) >= CONFIG.minEveryMs) return { kind: "every", everyMs: when.everyMs as number };
	if (when.kind === "daily" && typeof when.time === "string" && parseClock(when.time) === when.time) {
		const days = Array.isArray(when.weekdays) ? when.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6) : undefined;
		return days && days.length > 0 && days.length < 7 ? { kind: "daily", time: when.time, weekdays: days } : { kind: "daily", time: when.time };
	}
	return undefined;
}

type BranchEntry = { type: string; customType?: string; data?: unknown };

/**
 * The schedule list as the session last saved it: the newest scheduler entry
 * holds the whole list. index.ts passes EVERY entry of the session file, in
 * the order they were written, not just the current branch. pi's advice is to
 * rebuild state from the branch, and that is right for state that is part of
 * the conversation; a schedule is not — it is a promise about the real clock.
 * Rebuilt from the branch, /tree back to before a one-time task ran, then
 * /reload, restored the list from before it ran, and it ran again. Entries
 * that do not read back as a schedule are dropped rather than trusted.
 */
export function restoreSnapshot(entries: readonly BranchEntry[]): SchedulerSnapshot {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = (entry.data ?? {}) as { schedules?: unknown; nextId?: unknown };
		const schedules: Schedule[] = [];
		for (const raw of Array.isArray(data.schedules) ? data.schedules : []) {
			const item = raw as Record<string, unknown>;
			const when = readWhen(item?.when);
			const createdAt = asNumber(item?.createdAt);
			if (!when || typeof item.id !== "string" || typeof item.prompt !== "string" || !item.prompt.trim() || createdAt === undefined) continue;
			const lastDueAt = asNumber(item.lastDueAt);
			schedules.push({ id: item.id, prompt: item.prompt, when, createdAt, ...(lastDueAt !== undefined ? { lastDueAt } : {}) });
		}
		const stored = asNumber(data.nextId) ?? 1;
		const highest = Math.max(0, ...schedules.map((schedule) => Number(schedule.id.replace(/^s/, "")) || 0));
		return { schedules, nextId: Math.max(stored, highest + 1) };
	}
	return { schedules: [], nextId: 1 };
}
