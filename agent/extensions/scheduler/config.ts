/**
 * Shared constants and types for the scheduler extension.
 *
 * A schedule is a prompt and a time rule. When it is due, the prompt goes into
 * the open session as a user message, the same as if you had typed it. There
 * are three rules, a closed set on purpose (state.ts says why no cron):
 *
 *   once    at one moment                 "in 20 minutes", "tomorrow at 9"
 *   every   at a fixed interval           "every 2 hours"
 *   daily   at a local clock time, on     "every day at 9", "every weekday at 9",
 *           every day or chosen weekdays  "every Monday at 9"
 *
 * Schedules belong to one session: they are stored in its session file and run
 * only while that session is open in pi (index.ts).
 */

/** customType of the session entry that holds the whole schedule list. */
export const ENTRY_TYPE = "scheduler_state";

/** The tool the model calls; pi has no built-in `schedule`. */
export const TOOL_NAME = "schedule";

/** settings.json key of this extension's block. Only `model` is read. */
export const SETTINGS_KEY = "scheduler";

/**
 * pi.events channel for announcing model spend — the shared string contract, so
 * the /schedule parse call shows up in /usage.
 */
export const SPEND_CHANNEL = "usage:spend";

export const CONFIG = {
	/**
	 * The longest a timer waits before it reads the wall clock again. A timer
	 * counts time the machine is awake; after sleep, or a clock change, only the
	 * wall clock knows what is due. One minute keeps a task at most that late.
	 */
	maxTimerMs: 60_000,
	/** The shortest `every` interval. Shorter would fill the session with turns. */
	minEveryMs: 60_000,
	/** A due time older than this when it fires counts as missed (pi closed or asleep). */
	lateMs: 2 * 60_000,
	/**
	 * How long a sent plain prompt has to start its run before it counts as
	 * refused and is tried again. Generous on purpose: another extension's input
	 * handler can hold a prompt for seconds before its run starts (recap makes a
	 * model call there), and too short a wait would send the prompt twice.
	 */
	acceptWaitMs: 30_000,
	/** A command starts no run to watch; after this long with the agent idle, it counts as done. */
	commandSettleMs: 2_000,
	/** How long a refused prompt waits before it is tried again (a /compact takes a while). */
	retryMs: 15_000,
	/** Tries per due prompt before the user is told it was skipped. */
	maxAttempts: 5,
	/** Upper bound on schedules in one session, so a loop in the model cannot flood it. */
	maxSchedules: 50,
	/** Wall-clock ceiling for the model call behind `/schedule <text>`. */
	parseTimeoutMs: 45_000,
} as const;

/** When a schedule fires. Times are epoch ms; `daily` is local wall-clock time. */
export type When =
	| { kind: "once"; at: number }
	| { kind: "every"; everyMs: number }
	/** `time` is "HH:MM"; `weekdays` are 0 (Sunday) to 6, absent for every day. */
	| { kind: "daily"; time: string; weekdays?: number[] };

export interface Schedule {
	/** "s1", "s2", … — never reused within a session. */
	id: string;
	/** Sent as the user message. A leading "/" runs as a command. */
	prompt: string;
	when: When;
	createdAt: number;
	/**
	 * The due time the last run served; absent until the first run. The due
	 * time, not the moment it ran: a run a minute late must not push the
	 * next due time of a short interval past the one it should serve.
	 */
	lastDueAt?: number;
}

/** What one session entry stores: the whole list, and the next id number. */
export interface SchedulerSnapshot {
	schedules: Schedule[];
	nextId: number;
}
