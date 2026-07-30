/**
 * Shared constants for the ultracode extension.
 *
 * Everything here is documented in README.md; the comments say what each number
 * is protecting against.
 *
 * Everything under `limits` is a DEFAULT: the `ultracode` settings block can
 * override each one, so a workflow's shape is configurable without editing the
 * engine (resolveLimits below).
 */
import { cpus } from "node:os";

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
 * Payload is an INCREMENT: `{ source: "workflows", detail, usage: { …, cost:
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

/** The `source` this extension announces under. */
export const SPEND_SOURCE = "workflows";

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
	/** Cap on concurrent workflow agents. */
	maxConcurrency: Math.max(1, Math.min(16, cpus().length - 2)),
	/** Runaway-loop backstop: total agents per workflow run. */
	maxAgentsPerRun: 1000,
	/** Per-call item cap for parallel()/pipeline(). */
	maxItemsPerCall: 4096,
	/** Wall-clock ceiling for one subagent, so a hung spawn cannot wedge a run. */
	agentTimeoutMs: 10 * 60_000,
	/** Retries when a schema-constrained agent returns unparsable output. */
	schemaRetries: 1,
	/** Run directories kept on disk; the oldest settled ones are pruned past this. */
	retainRuns: 50,
	/** Characters of forked context one agent may be seeded with. */
	contextBudgetChars: 60_000,
	/** Characters of a single forked file before it is truncated. */
	fileBudgetChars: 20_000,
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

/** The subset of CONFIG a workflow run reads, after settings are applied. */
export interface Limits {
	maxConcurrency: number;
	maxAgentsPerRun: number;
	maxItemsPerCall: number;
	agentTimeoutMs: number;
	schemaRetries: number;
	retainRuns: number;
	contextBudgetChars: number;
	fileBudgetChars: number;
}

export const DEFAULT_LIMITS: Limits = {
	maxConcurrency: CONFIG.maxConcurrency,
	maxAgentsPerRun: CONFIG.maxAgentsPerRun,
	maxItemsPerCall: CONFIG.maxItemsPerCall,
	agentTimeoutMs: CONFIG.agentTimeoutMs,
	schemaRetries: CONFIG.schemaRetries,
	retainRuns: CONFIG.retainRuns,
	contextBudgetChars: CONFIG.contextBudgetChars,
	fileBudgetChars: CONFIG.fileBudgetChars,
};

export interface UltracodeSettings {
	/** Whether the "ultracode" keyword opts a turn in; default true. */
	keywordTrigger: boolean;
	/**
	 * Default model reference for workflow subagents when a request does not
	 * name one; falls back to the session model. Per-workflow routing is said
	 * in the triggering request, not configured here — see routing.ts.
	 */
	model?: string;
	/** Overrides for DEFAULT_LIMITS; absent keys keep the default. */
	limits: Limits;
}

export const DEFAULT_SETTINGS: UltracodeSettings = {
	keywordTrigger: true,
	limits: DEFAULT_LIMITS,
};

/**
 * Apply a settings `limits` block over the defaults. A value that is not a
 * positive finite number is ignored rather than fatal — one bad key should not
 * disable workflows.
 */
export function resolveLimits(raw: unknown): Limits {
	const limits: Limits = { ...DEFAULT_LIMITS };
	if (!raw || typeof raw !== "object") return limits;
	const block = raw as Record<string, unknown>;
	for (const key of Object.keys(limits) as Array<keyof Limits>) {
		const value = block[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			limits[key] = Math.floor(value);
		}
	}
	return limits;
}
