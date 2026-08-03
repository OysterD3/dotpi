/**
 * Shared constants for the ultracode extension.
 *
 * Everything here is documented in README.md; the comments say what each number
 * is protecting against.
 *
 * There used to be a `limits` settings block over most of this — a concurrency
 * cap, an agent cap, a per-agent wall-clock ceiling, context truncation — and it
 * is gone on purpose. Measured on this machine, the caps never bound anything
 * that was going well: the runs that hurt were one agent deep for an hour, which
 * no ceiling shortens, and the ceiling itself had been raised to ten hours to
 * stop it killing work in progress. What is left here is plumbing (how many run
 * directories to keep, how many times to re-ask for malformed JSON), not a
 * budget, and none of it is configurable.
 *
 * Concurrency is now unbounded: parallel() and pipeline() start every agent they
 * are given at once. A script that fans out to fifty items launches fifty pi
 * processes, so breadth is the script's decision to make and its consequence to
 * carry.
 */

export const ENTRY_TYPE = "ultracode";

export const SETTINGS_KEY = "ultracode";

/** Saved workflow scripts, addressable by `name`. */
export const WORKFLOW_DIR = "workflows";

/** The on-disk run store: one directory per run. */
export const RUN_STORE_DIR = "workflow-runs";

/**
 * pi.events channel carrying the active-run lines for whoever wants to draw
 * them. ultracode does not know where they end up — the statusline appends them
 * to the footer; anything else (a notifier, a widget) can subscribe too. The
 * payload is `{ lines: string[] | undefined }`, undefined meaning "nothing
 * running, clear it".
 */
export const PANEL_CHANNEL = "ultracode:panel";

/**
 * pi.events channel saying whether the /workflows panel is holding the editor's
 * slot. Payload: `{ active: boolean }`.
 *
 * Separate from PANEL_CHANNEL, which carries the run lines a footer draws: this
 * one says "the panel has taken the editor's place, stand down" — a different
 * fact with a different lifetime. ultracode cannot blank the footer itself,
 * because `ui.setFooter(undefined)` restores pi's *built-in* footer and would
 * retire the statusline's for the rest of the session (the same trap written
 * out in statusline/config.ts).
 *
 * Not ASK_CHANNEL either, though the presentation is the same: that channel's
 * documented meaning is "a human decision is pending", so `elapsed` would stop
 * the turn clock and cmux-notify would ring the pane bell — for a panel the
 * user opened themselves, with the agent still working.
 */
export const PANEL_OPEN_CHANNEL = "ultracode:panel-open";

/**
 * pi.events channel for announcing model spend — shared by every extension that
 * bills money, not owned by this one, which is why it is not `ultracode:*`.
 *
 * Payload is an INCREMENT: `{ source: SPEND_SOURCE, detail, usage: { …, cost:
 * number }, calls }`. Announced per subagent turn from the same hook that folds
 * usage into the run, so a subscriber sees spend as it happens without
 * ultracode keeping a second tally to hand out.
 *
 * `detail` names the individual run ("code-review (16:01)"), which is what lets
 * /usage answer "which of these five cost $40" — the question that has no other
 * home now that no /workflows surface prints a price.
 *
 * Workflow agents are separate pi processes, so none of their spend appears in
 * this session's own messages — an accounting that reads only the transcript is
 * blind to the most expensive thing in it. Announcing rather than being read
 * keeps that one-directional: ultracode does not know who subscribes (today,
 * /usage), and with no subscriber the events go nowhere.
 *
 * `wait: true` runs are deliberately NOT announced. pi already attaches their
 * spend to the tool result as `usage`, which a reader picks up from the
 * transcript; announcing as well would bill the same tokens twice.
 */
export const SPEND_CHANNEL = "usage:spend";

/**
 * The `source` this extension announces under.
 *
 * Deliberately the tool's own name, singular, and not "workflows". A reader
 * merges an announcement into the row of the tool it names, and this extension
 * reaches a spend report by two routes — `wait: true` runs on the tool result,
 * background ones on the channel. Under two names they showed up as two rows in
 * two sections of /usage, and which one you got depended on a parameter the
 * report never displayed. Sharing the tool name makes them one row.
 */
export const SPEND_SOURCE = "workflow";

/**
 * Floor on how often live spend is written to run.json, in ms.
 *
 * Only for the streamed per-turn updates; every settled agent persists
 * regardless. See persistThrottled in tool.ts for what this is protecting.
 */
export const USAGE_PERSIST_MS = 5_000;

export const CONFIG = {
	/** Sparse "still on" reminder cadence, in user turns. */
	turnsBetweenMaintenance: 10,
	/** Retries when a schema-constrained agent returns unparsable output. */
	schemaRetries: 1,
	/**
	 * Run directories kept on disk; the oldest settled ones are pruned past this.
	 * Disk housekeeping, not a limit on a run: without it the store grows without
	 * bound, and no workflow is made worse by an old run being swept up.
	 */
	retainRuns: 50,
	/**
	 * Process-wide ceiling on concurrent subagents, across ALL runs.
	 *
	 * Not the per-run throttle that was removed — that capped one run and made
	 * breadth expensive; thirty agents in a single fan-out still start together.
	 * This bounds the aggregate, because /workflows runs several workflows at
	 * once and N runs × M agents with nothing counting is N×M pi processes.
	 *
	 * Set high on purpose. Peers use 8-16, copied from Claude Code with no
	 * recorded evidence; the number here is a backstop against a fork bomb, not
	 * an opinion about the right width for a fleet.
	 */
	maxConcurrentAgents: 32,
	/** Log lines kept in memory per run (the journal on disk keeps them all). */
	memoryLogLines: 200,
	/**
	 * Rows of transcript kept above the /workflows panel while it holds the
	 * editor slot. Six rather than ask-user's eight: a panel is opened on
	 * purpose and may claim a little more of the screen than an interruption.
	 */
	screenReserve: 6,
	/** Row count assumed when the host cannot report one (tests, odd terminals). */
	assumedRows: 24,
} as const;

export interface UltracodeSettings {
	/** Whether the "ultracode" keyword opts a turn in; default true. */
	keywordTrigger: boolean;
	/**
	 * Default model reference for workflow subagents when a request does not
	 * name one; falls back to the session model. Per-workflow routing is said
	 * in the triggering request, not configured here — see routing.ts.
	 */
	model?: string;
}

export const DEFAULT_SETTINGS: UltracodeSettings = {
	keywordTrigger: true,
};
