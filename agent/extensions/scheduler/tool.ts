/**
 * The `schedule` tool: how "remind me in 20 minutes to check the deploy" in
 * chat becomes a schedule. The model reads the words and fills the fields;
 * validateWhen (state.ts) checks them; the result reads the resolved local
 * time back, so a wrong date is visible in the transcript at once.
 *
 * pi's system prompt carries no date, so the `at` forms the tool accepts need
 * none: "15:20", "tomorrow 9am", "mon 09:00". Every result, and every error,
 * starts with today's date and the local time (nowLine), which gives the model
 * the date for its next call.
 */

import { Type } from "typebox";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { type Schedule, TOOL_NAME } from "./config.ts";
import { describeWhen, formatRelative, formatTime, isCommand, validateWhen } from "./state.ts";
import type { Scheduler } from "./timer.ts";

export const TOOL_DESCRIPTION = [
	"Schedule a prompt to run later in this session, once or on a repeat. When it is due and you are idle, the prompt is sent to you as a user message; a prompt that starts with \"/\" runs as that extension command, skill or prompt template (for example \"/recap\") — pi's built-in commands such as /compact or /new cannot be scheduled. Schedules run only while this pi session is open; a run missed while pi was closed happens once when the session opens again.",
	"",
	'action "add": give prompt and exactly one of',
	'- in: a delay — "20m", "1h30m", "2d"',
	'- at: one moment in local time — "15:20" (the next 15:20), "today 15:20", "tomorrow 9am", "mon 09:00", or "YYYY-MM-DD HH:MM"',
	'- every: an interval of at least 1 minute — "30m", "2h", "1d"',
	'- daily: a local clock time — "09:00" or "9am"; add weekdays (["mon","wed"], "weekdays" or "weekends") to limit the days',
	"Write prompt as a complete instruction to yourself: the user may be away when it runs. Keep a slash command exactly as the user wrote it.",
	'action "list": the schedules, with the current local time. action "cancel": id (such as "s2") or "all".',
	"The result states the resolved local time. Check it against what the user asked, and correct it if it is wrong.",
].join("\n");

/** "Now: Thu 24 Sep 2026 16:05 (America/New_York)." — the date the model has no other way to know. */
export function nowLine(now: number): string {
	const date = new Date(now);
	const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const [weekday, month, day, year] = date.toDateString().split(" ");
	return `Now: ${weekday} ${Number(day)} ${month} ${year} ${clock} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;
}

/**
 * Why a prompt that starts with "/" cannot run from a schedule, or undefined
 * when it can. pi runs extension commands, skills and prompt templates for a
 * message an extension sends; its built-in commands (/compact, /new, /model)
 * run only from the editor, so a scheduled "/compact" would reach the model
 * as the plain text "/compact". `commands` is pi.getCommands().
 */
export function commandProblem(prompt: string, commands: readonly Pick<SlashCommandInfo, "name">[]): string | undefined {
	if (!isCommand(prompt)) return undefined;
	const name = prompt.trim().slice(1).split(/\s+/)[0] ?? "";
	if (commands.some((command) => command.name === name)) return undefined;
	return `"/${name}" is not a command a schedule can run. A schedule runs extension commands, skills (/skill:name) and prompt templates; pi's built-in commands (/compact, /new, /model, …) run only from the editor. Describe the task in words instead.`;
}

/** What a tool result records besides its text. */
type ScheduleDetails = { action: string; id?: string; cancelled?: string[] };

/** One schedule on one line: id, rule, next run, prompt. */
export function scheduleLine(schedule: Schedule, next: number | undefined, now: number): string {
	const when = describeWhen(schedule.when, now);
	const upcoming = next === undefined ? "" : schedule.when.kind === "once" ? ` (${formatRelative(next, now)})` : `; next ${formatTime(next, now)} (${formatRelative(next, now)})`;
	const prompt = schedule.prompt.length > 80 ? `${schedule.prompt.slice(0, 79)}…` : schedule.prompt;
	return `${schedule.id}  ${when}${upcoming}  "${prompt}"`;
}

/** The list as text, for the tool and for /schedules. */
export function listText(scheduler: Scheduler): string {
	const now = scheduler.now();
	const lines = [nowLine(now)];
	const schedules = scheduler.list();
	if (schedules.length === 0) lines.push("No schedules in this session.");
	for (const schedule of schedules) lines.push(scheduleLine(schedule, scheduler.nextFor(schedule), now));
	return lines.join("\n");
}

export function registerScheduleTool(pi: ExtensionAPI, scheduler: () => Scheduler): void {
	const fail = (reason: string, now: number): never => {
		throw new Error(`${reason}\n${nowLine(now)}`);
	};
	pi.registerTool({
		name: TOOL_NAME,
		label: "Schedule",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Run a prompt later in this session, once or on a repeat",
		promptGuidelines: [
			'Use schedule when the user asks for something to happen later or on a repeat ("in 20 minutes", "at 3pm", "every weekday at 9"), and to list or cancel schedules.',
		],
		parameters: Type.Object({
			action: Type.String({ description: 'add, list or cancel' }),
			prompt: Type.Optional(Type.String({ description: "add: what to run when it is due" })),
			in: Type.Optional(Type.String({ description: 'add, once after a delay: "20m", "1h30m"' })),
			at: Type.Optional(Type.String({ description: 'add, once at a moment: "15:20", "tomorrow 9am", "mon 09:00", "YYYY-MM-DD HH:MM"' })),
			every: Type.Optional(Type.String({ description: 'add, repeat by interval: "30m", "2h"' })),
			daily: Type.Optional(Type.String({ description: 'add, repeat at a local time: "09:00"' })),
			weekdays: Type.Optional(Type.Array(Type.String(), { description: 'with daily: ["mon","fri"], ["weekdays"] or ["weekends"]' })),
			id: Type.Optional(Type.String({ description: 'cancel: the schedule id, or "all"' })),
		}),

		async execute(_toolCallId, params) {
			const runtime = scheduler();
			const action = String(params.action ?? "").trim().toLowerCase();
			const now = runtime.now();

			if (action === "list") return { content: [{ type: "text" as const, text: listText(runtime) }], details: { action } as ScheduleDetails };

			if (action === "cancel") {
				const id = String(params.id ?? "").trim();
				if (!id) fail('cancel needs an id, such as "s2", or "all"', now);
				const removed = runtime.cancel(id);
				if (removed.length === 0) throw new Error(`No schedule "${id}".\n${listText(runtime)}`);
				const text = `${nowLine(now)}\nCancelled ${removed.map((schedule) => `${schedule.id} ("${schedule.prompt}")`).join(", ")}.`;
				return { content: [{ type: "text" as const, text }], details: { action, cancelled: removed.map((schedule) => schedule.id) } as ScheduleDetails };
			}

			if (action !== "add") fail(`Unknown action "${params.action}". Use add, list or cancel.`, now);
			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) fail("add needs a prompt: what to run when it is due", now);
			// An older pi without getCommands cannot be asked; the check is skipped then.
			const commands = pi.getCommands?.();
			const problem = commands ? commandProblem(prompt, commands) : undefined;
			if (problem) fail(problem, now);
			const when = validateWhen(params, now);
			if (!when.ok) return fail(when.error, now);
			const added = runtime.add(prompt, when.value);
			if (!added.ok) return fail(added.error, now);
			const line = scheduleLine(added.schedule, runtime.nextFor(added.schedule), now);
			const text = `${nowLine(now)}\nScheduled:\n${line}\nIt runs in this session while pi is open.`;
			return { content: [{ type: "text" as const, text }], details: { action, id: added.schedule.id } as ScheduleDetails };
		},
	});
}
