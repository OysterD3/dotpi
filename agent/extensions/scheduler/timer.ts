/**
 * The running side: the open session's schedule list, one timer, and sending
 * what is due.
 *
 * One timer for the whole list, set for the nearest due time but never longer
 * than CONFIG.maxTimerMs. A timer counts time the machine is awake, so after a
 * sleep or a clock change it would be late by the time it was asleep; waking
 * at least once a minute and reading the wall clock (`lastDue`) keeps a task
 * at most a minute late whatever happened. Timers are unref'd, so they never
 * hold a process open.
 *
 * ## Save, then send
 *
 * A run is written to the session (the new lastDueAt, or the one-time schedule
 * removed) BEFORE its prompt goes out. pi re-runs every extension factory on
 * /reload, /resume and /new, and the new instance restores the list from the
 * session. If the send came first, a reload between the two would restore a
 * list that still says "due", and the task would run twice.
 *
 * ## Sending: only when idle, one at a time, and checked
 *
 * Due prompts go into an outbox, and the outbox sends one prompt only while
 * the agent is idle, then waits for that prompt to finish before the next.
 * Three things in pi make every shortcut here wrong:
 *   - two sendUserMessage calls in a row both start a run before pi marks the
 *     first one as running; the second fails with "already processing" and
 *     leaves pi's own running flag wrong for the rest of the turn;
 *   - an extension command (/recap) runs at once even mid-turn — `followUp`
 *     queues only plain prompts — so it would summarise a half-finished turn;
 *   - a send pi refuses (during /compact, with no model, with an expired
 *     login) fails asynchronously, out of reach of any try/catch here.
 * So a plain prompt counts as delivered only when its run starts
 * (agent_start). One that starts no run within CONFIG.acceptWaitMs goes back
 * to the head of the outbox and is tried again CONFIG.retryMs later, up to
 * CONFIG.maxAttempts times, and then the user is told it was skipped. A
 * command has no run to watch, so it counts as delivered once the agent has
 * been idle for CONFIG.commandSettleMs after it.
 *
 * ## What the prompt carries
 *
 * A prompt that starts with "/" is sent exactly as written, so pi runs it as
 * the extension command, skill or template it names (`expandPromptTemplates`
 * — see index.ts; tool.ts refuses pi's built-in commands, which only the
 * editor can run). Anything else gets one header line saying it is a
 * scheduled task and that the user may be away: without it, the model answers
 * a task it did not see arrive with a question into an empty room.
 */

import { CONFIG, ENTRY_TYPE, type Schedule, type SchedulerSnapshot, type When } from "./config.ts";
import { describeWhen, formatTime, isCommand, lastDue, nextFire } from "./state.ts";

export interface Clock {
	now(): number;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimer: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		handle.unref?.();
		return handle;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The options a scheduled send uses. `expandPromptTemplates` is untyped in pi's API; index.ts says why it is safe. */
export type SendOptions = { deliverAs: "followUp"; expandPromptTemplates: true };

const SEND_OPTIONS: SendOptions = { deliverAs: "followUp", expandPromptTemplates: true };

/** The parts of pi the runtime uses; loose so tests can fake them. */
export interface SchedulerHost {
	appendEntry(customType: string, data: SchedulerSnapshot): void;
	sendUserMessage(text: string, options: SendOptions): void;
	/** Whether the agent is idle: no run streaming. */
	isIdle(): boolean;
	/** Say something to the user, when there is a UI to say it in. */
	notify(message: string): void;
}

/** The text a due schedule sends. Exported for tests. */
export function scheduledText(schedule: Schedule, dueAt: number, now: number): string {
	if (isCommand(schedule.prompt)) return schedule.prompt.trim();
	const missed = now - dueAt > CONFIG.lateMs;
	const when = describeWhen(schedule.when, now);
	const late = missed ? `; it was due ${formatTime(dueAt, now)} and was missed while pi was closed or asleep` : "";
	return [
		`[Scheduled task ${schedule.id}, ${when}${late}]`,
		"This runs on a schedule and the user may be away: do the work, then report the result. Do not ask questions.",
		"",
		schedule.prompt.trim(),
	].join("\n");
}

/** One prompt waiting to go out. */
interface Outgoing {
	id: string;
	text: string;
	command: boolean;
	attempts: number;
	/** Not before this time: a retry waits CONFIG.retryMs. */
	notBefore: number;
}

export class Scheduler {
	private schedules: Schedule[] = [];
	private nextId = 1;
	private timer: unknown;
	private pumpTimer: unknown;
	private running = false;
	private outbox: Outgoing[] = [];
	/** The prompt sent last, until it is known to have finished. */
	private awaiting: { item: Outgoing; sentAt: number; started: boolean } | undefined;

	constructor(
		private readonly host: SchedulerHost,
		private readonly clock: Clock,
	) {}

	/**
	 * Take the list the session restored. With `live`, start the timer too:
	 * anything due now, including a run missed while pi was closed, goes out
	 * on the first tick. Without it (print mode), the list can be read and
	 * changed, but nothing fires — a `pi -p` run must print the answer to its
	 * own prompt, not to a scheduled one that slipped in first.
	 */
	start(snapshot: SchedulerSnapshot, live: boolean): void {
		this.stop();
		this.schedules = snapshot.schedules.map((schedule) => ({ ...schedule }));
		this.nextId = snapshot.nextId;
		this.running = live;
		this.arm(0);
	}

	/** Stop the timers and drop anything not yet sent. The list stays in the session for the next start. */
	stop(): void {
		this.running = false;
		if (this.timer !== undefined) this.clock.clearTimer(this.timer);
		if (this.pumpTimer !== undefined) this.clock.clearTimer(this.pumpTimer);
		this.timer = undefined;
		this.pumpTimer = undefined;
		this.outbox = [];
		this.awaiting = undefined;
	}

	/** Save the current list. index.ts uses this to give a forked session a list of its own. */
	save(): void {
		this.persist();
	}

	list(): readonly Schedule[] {
		return this.schedules;
	}

	now(): number {
		return this.clock.now();
	}

	add(prompt: string, when: When): { ok: true; schedule: Schedule } | { ok: false; error: string } {
		const now = this.clock.now();
		if (this.schedules.length >= CONFIG.maxSchedules) {
			return { ok: false, error: `this session already has ${CONFIG.maxSchedules} schedules; cancel one first` };
		}
		if (when.kind === "once" && when.at <= now) return { ok: false, error: `${formatTime(when.at, now)} has already passed` };
		const schedule: Schedule = { id: `s${this.nextId++}`, prompt: prompt.trim(), when, createdAt: now };
		this.schedules.push(schedule);
		this.persist();
		this.arm();
		return { ok: true, schedule };
	}

	/** Cancel one schedule by id, or all of them with "all". Returns what was cancelled. */
	cancel(id: string): Schedule[] {
		const key = id.trim().toLowerCase();
		const removed = key === "all" ? this.schedules : this.schedules.filter((schedule) => schedule.id === key);
		if (removed.length === 0) return [];
		this.schedules = this.schedules.filter((schedule) => !removed.includes(schedule));
		this.outbox = this.outbox.filter((item) => !removed.some((schedule) => schedule.id === item.id));
		this.persist();
		this.arm();
		return removed;
	}

	/** When this schedule is next due, for the list and the tool result. */
	nextFor(schedule: Schedule): number | undefined {
		return nextFire(schedule, this.clock.now());
	}

	/** Queue everything due now, send what can go, then set the timer again. Public so tests can drive it. */
	tick(): void {
		const now = this.clock.now();
		const due = this.schedules
			.map((schedule) => ({ schedule, dueAt: lastDue(schedule, now) }))
			.filter((item): item is { schedule: Schedule; dueAt: number } => item.dueAt !== undefined)
			.sort((a, b) => a.dueAt - b.dueAt);
		if (due.length > 0) {
			for (const { schedule, dueAt } of due) {
				if (schedule.when.kind === "once") this.schedules = this.schedules.filter((item) => item !== schedule);
				else schedule.lastDueAt = dueAt;
			}
			this.persist();
			for (const { schedule, dueAt } of due) {
				if (isCommand(schedule.prompt) && now - dueAt > CONFIG.lateMs) {
					this.host.notify(`Scheduled ${schedule.id} was due ${formatTime(dueAt, now)} and missed while pi was closed or asleep; running it now.`);
				}
				this.outbox.push({ id: schedule.id, text: scheduledText(schedule, dueAt, now), command: isCommand(schedule.prompt), attempts: 0, notBefore: now });
			}
		}
		this.pump();
		this.arm();
	}

	/** pi started an agent run. If it is ours, the prompt was accepted. */
	onAgentStart(): void {
		if (this.awaiting) this.awaiting.started = true;
	}

	/** pi finished a run and nothing else is queued: the next prompt may go. */
	onAgentSettled(): void {
		if (this.awaiting?.started) this.awaiting = undefined;
		this.pump();
	}

	/** Send the next prompt if the agent is idle and the last one is known to be done. */
	private pump(): void {
		if (!this.running) return;
		const now = this.clock.now();
		if (this.awaiting) {
			const { item, sentAt, started } = this.awaiting;
			// A run started: agent_settled says when it is over.
			if (started) return;
			const wait = item.command ? CONFIG.commandSettleMs : CONFIG.acceptWaitMs;
			if (now - sentAt < wait || !this.host.isIdle()) return void this.pumpLater(Math.max(CONFIG.commandSettleMs, sentAt + wait - now));
			this.awaiting = undefined;
			// A command starts no run; idle again means it is done. A plain
			// prompt that started no run was refused: it goes back to the head.
			if (!item.command) {
				if (item.attempts < CONFIG.maxAttempts) {
					this.outbox.unshift({ ...item, notBefore: now + CONFIG.retryMs });
				} else {
					this.host.notify(`Scheduled ${item.id} could not be sent after ${item.attempts} tries and was skipped.`);
				}
			}
		}
		const next = this.outbox[0];
		if (!next) return;
		if (next.notBefore > now) return void this.pumpLater(next.notBefore - now);
		// A busy agent sends agent_settled when it is done, and that pumps again.
		if (!this.host.isIdle()) return void this.pumpLater(CONFIG.maxTimerMs);
		this.outbox.shift();
		next.attempts++;
		this.awaiting = { item: next, sentAt: now, started: false };
		try {
			this.host.sendUserMessage(next.text, SEND_OPTIONS);
		} catch (error) {
			this.host.notify(`Scheduled ${next.id} could not be sent: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.pumpLater(next.command ? CONFIG.commandSettleMs : CONFIG.acceptWaitMs);
	}

	private pumpLater(ms: number): void {
		if (this.pumpTimer !== undefined) this.clock.clearTimer(this.pumpTimer);
		this.pumpTimer = this.clock.setTimer(() => {
			this.pumpTimer = undefined;
			this.pump();
		}, Math.max(0, ms));
	}

	private persist(): void {
		this.host.appendEntry(ENTRY_TYPE, { schedules: this.schedules.map((schedule) => ({ ...schedule })), nextId: this.nextId });
	}

	private arm(delay?: number): void {
		if (this.timer !== undefined) this.clock.clearTimer(this.timer);
		this.timer = undefined;
		if (!this.running || this.schedules.length === 0) return;
		let wait = delay;
		if (wait === undefined) {
			const now = this.clock.now();
			// Something already due (a one-time time that has just passed) goes now.
			const overdue = this.schedules.some((schedule) => lastDue(schedule, now) !== undefined);
			const next = Math.min(...this.schedules.map((schedule) => nextFire(schedule, now) ?? Number.POSITIVE_INFINITY));
			wait = overdue ? 0 : Number.isFinite(next) ? next - now : CONFIG.maxTimerMs;
		}
		this.timer = this.clock.setTimer(() => {
			this.timer = undefined;
			this.tick();
		}, Math.max(0, Math.min(wait, CONFIG.maxTimerMs)));
	}
}
