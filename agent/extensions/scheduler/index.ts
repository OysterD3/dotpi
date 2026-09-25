/**
 * scheduler — run a prompt later in this session, once or on a repeat, from a
 * sentence.
 *
 * Two ways in, one list:
 *
 *   - in chat: "remind me in 20 minutes to check the deploy", "every weekday at
 *     9 run /recap". The model calls the `schedule` tool (tool.ts), which checks
 *     the time and reads it back;
 *   - `/schedule <sentence>`: one model call reads the sentence (parse.ts), you
 *     confirm, and it is saved — no agent turn.
 *
 * `/schedules` lists them and cancels one, or all.
 *
 * When a schedule is due, its prompt goes into the session as a user message
 * (timer.ts): a slash command runs as the command, anything else arrives with
 * one line saying it is a scheduled task. A turn in progress is never
 * interrupted — due prompts wait until the agent is idle, and go one at a time.
 *
 * ## Where schedules live, and the limits that follow
 *
 * The list is saved in the session file (one snapshot entry per change) and
 * restored at session_start from the newest snapshot in the file — not from
 * the branch; state.ts restoreSnapshot says why. The timer runs in this pi
 * process, and only with a UI (interactive or RPC): in `pi -p` the list can be
 * read and changed, but nothing fires. So:
 *   - schedules run only while this session is open in pi;
 *   - a run missed while pi was closed (or the machine asleep) happens once
 *     when the session opens again, saying it was missed — once, not once per
 *     missed occurrence;
 *   - a schedule belongs to its session: /new starts with none, and a fork or
 *     clone starts with none too — it copies the old session's entries, and
 *     restoring them would run the same schedule in two sessions.
 *
 * pi re-runs this factory on /reload, /resume and /new; session_shutdown stops
 * the old instance's timer, and session_start restores the list for the new
 * one. timer.ts saves each run before it sends it, so that cycle cannot run a
 * task twice.
 *
 * The /schedule parse call uses `scheduler.model` from agent/settings.json, or
 * the session model when that is not set. No status-bar chip: /schedules is
 * where the list is shown.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG, SPEND_CHANNEL } from "./config.ts";
import { modelSetting, parseSchedule } from "./parse.ts";
import { describeWhen, formatRelative, formatTime, nextFire, restoreSnapshot, validateWhen } from "./state.ts";
import { type Clock, Scheduler, type SendOptions, systemClock } from "./timer.ts";
import { commandProblem, listText, registerScheduleTool, scheduleLine } from "./tool.ts";

const USAGE = 'Usage: /schedule <when and what> — for example "/schedule every weekday at 9 run /recap" or "/schedule in 20m check the deploy".';

/** Wire the extension with a given clock. Exported so the tests can drive time. */
export function install(pi: ExtensionAPI, clock: Clock): Scheduler {
	const agentDir = getAgentDir();
	let ui: ExtensionContext["ui"] | undefined;
	let current: ExtensionContext | undefined;

	const scheduler = new Scheduler(
		{
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			// `expandPromptTemplates` is the switch pi's own input path uses to run
			// "/recap" as a command. The extension type declares only `deliverAs`,
			// but the runtime hands the whole options object to AgentSession.prompt
			// (core/extensions/loader.js → agent-session.js sendUserMessage) — a
			// probe extension confirmed a scheduled "/probe-cmd" ran as the command.
			sendUserMessage: (text, options) => (pi.sendUserMessage as (text: string, options: SendOptions) => void)(text, options),
			isIdle: () => current?.isIdle() ?? false,
			notify: (message) => ui?.notify(message, "info"),
		},
		clock,
	);

	registerScheduleTool(pi, () => scheduler);

	pi.on("session_start", (event, ctx) => {
		current = ctx;
		ui = ctx.hasUI ? ctx.ui : undefined;
		// A fork copies the old session's entries, schedule snapshots included.
		// Its list starts empty, and saying so in the fork's own file keeps a
		// later reload there from finding the copied one.
		if ((event as { reason?: string }).reason === "fork") {
			scheduler.start({ schedules: [], nextId: 1 }, ctx.hasUI);
			if (restoreSnapshot(ctx.sessionManager.getEntries() as never).schedules.length > 0) scheduler.save();
			return;
		}
		scheduler.start(restoreSnapshot(ctx.sessionManager.getEntries() as never), ctx.hasUI);
	});

	pi.on("session_shutdown", () => {
		scheduler.stop();
		ui = undefined;
		current = undefined;
	});

	// The outbox sends one prompt at a time: agent_start says a sent prompt was
	// accepted, agent_settled that the agent is free for the next one.
	pi.on("agent_start", () => scheduler.onAgentStart());
	pi.on("agent_settled", () => scheduler.onAgentSettled());

	/** Whether pi has written this session to disk yet: it does not until the first reply. */
	const saved = (ctx: ExtensionContext) =>
		ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "assistant");

	pi.registerCommand("schedule", {
		description: "Schedule a prompt from a sentence (/schedule <when and what>)",
		handler: async (args: string, ctx) => {
			const text = args.trim();
			if (!text) return void ctx.ui.notify(USAGE, "info");
			if (!ctx.hasUI) return void ctx.ui.notify("/schedule needs the interactive TUI to confirm; in chat, ask for the schedule instead.", "error");

			ctx.ui.notify(`Reading "${text}"…`, "info");
			const now = clock.now();
			const outcome = await parseSchedule(ctx as never, text, now, modelSetting(agentDir), CONFIG.parseTimeoutMs, (spend) =>
				pi.events.emit(SPEND_CHANNEL, { source: "scheduler", usage: spend, calls: 1 }),
			);
			if (!outcome.ok) return void ctx.ui.notify(`Could not schedule that: ${outcome.error}`, "warning");
			const commands = pi.getCommands?.();
			const problem = commands ? commandProblem(outcome.prompt, commands) : undefined;
			if (problem) return void ctx.ui.notify(`Could not schedule that: ${problem}`, "warning");

			const next = nextFire({ id: "new", prompt: outcome.prompt, when: outcome.when, createdAt: now }, now);
			const timing = `${describeWhen(outcome.when, now)}${outcome.when.kind !== "once" && next !== undefined ? `; first ${formatTime(next, now)}` : ""}${next !== undefined ? ` (${formatRelative(next, now)})` : ""}`;
			if (!(await ctx.ui.confirm("Schedule this?", `${timing}\n"${outcome.prompt}"`))) return void ctx.ui.notify("Cancelled.", "info");

			// The dialog can take minutes: read the time again now, so "in 20m"
			// means 20 minutes from the confirm, and a time that passed meanwhile
			// is refused instead of firing at once as "missed".
			const when = validateWhen(outcome.fields, clock.now());
			if (!when.ok) return void ctx.ui.notify(`Could not schedule that: ${when.error}`, "warning");
			const added = scheduler.add(outcome.prompt, when.value);
			if (!added.ok) return void ctx.ui.notify(added.error, "error");
			ctx.ui.notify(`Scheduled: ${scheduleLine(added.schedule, scheduler.nextFor(added.schedule), clock.now())}`, "info");
			if (!saved(ctx)) {
				ctx.ui.notify("pi saves a session to disk only after its first reply. Until this one has a reply, the schedule is lost if you quit.", "warning");
			}
		},
	});

	pi.registerCommand("schedules", {
		description: "List schedules in this session, or cancel one (/schedules [list | cancel <id> | cancel all])",
		getArgumentCompletions: (prefix: string) => {
			const options = ["list", "cancel", "cancel all", ...scheduler.list().map((schedule) => `cancel ${schedule.id}`)];
			return options.filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args: string, ctx) => {
			const [verb, ...rest] = args.trim().split(/\s+/);
			const sub = (verb ?? "").toLowerCase();
			if (sub === "" || sub === "list") return void ctx.ui.notify(listText(scheduler), "info");
			if (sub !== "cancel") return void ctx.ui.notify("Usage: /schedules [list | cancel <id> | cancel all]", "error");

			let id = rest.join(" ").trim();
			if (!id) {
				if (!ctx.hasUI) return void ctx.ui.notify("Give the id: /schedules cancel <id>", "error");
				const now = clock.now();
				const lines = scheduler.list().map((schedule) => scheduleLine(schedule, scheduler.nextFor(schedule), now));
				if (lines.length === 0) return void ctx.ui.notify("No schedules in this session.", "info");
				const picked = await ctx.ui.select("Cancel which schedule?", lines);
				if (!picked) return;
				id = picked.split(/\s+/)[0];
			}
			if (id.toLowerCase() === "all" && ctx.hasUI) {
				const count = scheduler.list().length;
				if (count === 0) return void ctx.ui.notify("No schedules in this session.", "info");
				if (!(await ctx.ui.confirm(`Cancel all ${count} schedules?`, "They stop running in this session."))) return void ctx.ui.notify("Kept.", "info");
			}
			const removed = scheduler.cancel(id);
			if (removed.length === 0) return void ctx.ui.notify(`No schedule "${id}". /schedules lists them.`, "error");
			ctx.ui.notify(`Cancelled ${removed.map((schedule) => schedule.id).join(", ")}.`, "info");
		},
	});

	return scheduler;
}

export default function (pi: ExtensionAPI) {
	install(pi, systemClock);
}
