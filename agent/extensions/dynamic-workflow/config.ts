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

export const SETTINGS_KEY = "dynamicWorkflow";

/**
 * The pre-rename settings block, still read.
 *
 * The extension is presented as "dynamic workflow" now, but the keyword that
 * opts a turn in is still `ultracode` and a settings file written before the
 * rename is still on disk. Reading both — new key winning per-field — is what
 * stops a rename from silently reverting someone's `keywordTrigger: false` to
 * the default, which is the failure mode a settings rename has: nothing errors,
 * the old block is simply never looked at again.
 */
export const LEGACY_SETTINGS_KEY = "ultracode";

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
 * Payload is a keyed SNAPSHOT: `{ source: SPEND_SOURCE, key: runId, detail,
 * usage: { …, cost: number }, calls }`. Keyed, so it replaces rather than adds
 * to whatever was last said about that run — which is what lets the same run be
 * reported over and over (it is reported on demand, see COLLECT_CHANNEL) without
 * the total growing each time.
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
 * It used to be announced as an increment per subagent turn, which was correct
 * and unrecoverable: the tally lived in the subscriber's memory, so terminating
 * pi and running `pi -c` reported a session with two completed fleets and none
 * of their $15. Now nothing is announced while a run is in flight — the answer
 * is assembled at report time from run.json, which every settled agent writes.
 */
export const SPEND_CHANNEL = "usage:spend";

/**
 * pi.events channel a spend report fires before it adds anything up, and the
 * reason nothing here is announced as it happens any more.
 *
 * ultracode already keeps a durable record of every run — run.json, written
 * throughout the fleet's life and final when it settles — so it does not need to
 * push. It answers, from the store plus whatever is still live in memory, and
 * the answer is the same whether the run finished a minute ago in this process
 * or two hours ago in one that has since been killed.
 *
 * The answer must be given SYNCHRONOUSLY. pi's bus invokes handlers in place and
 * does not await them, so anything reported after a first `await` reaches a
 * report that has already been built.
 */
export const COLLECT_CHANNEL = "usage:collect";

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
	/**
	 * Consecutive main-session edit/write tool calls, with no Workflow call
	 * between them, before the model is told it is grinding alone.
	 *
	 * The keyword's opt-in is per-turn and a background workflow's result is
	 * delivered on a turn before_agent_start never fires for (see index.ts's
	 * before_agent_start and mode.ts's hasMessageSinceLastUserTurn) — so once
	 * that reminder decayed, nothing else was watching. The measured run hit
	 * 360 solo edit/write calls across 69 files with no nudge at any point.
	 * Twenty is not tuned against a second measurement; it is "clearly past
	 * the last file of a small fix", the same order of magnitude as the
	 * deepestAgentTurns >= 40 threshold this mirrors in tool.ts.
	 */
	editStreakNudge: 20,
	/**
	 * Cap on edit-streak nudges delivered within one turn.
	 *
	 * An unattended streak keeps incrementing forever; without this, a run
	 * that never stops to read anything would get the same reminder every
	 * twentieth call indefinitely — the tenth copy no more likely to be read
	 * than the first. Two lets the model notice a repeat before the message
	 * is muted for the rest of the turn.
	 */
	editStreakMaxNudgesPerTurn: 2,
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
