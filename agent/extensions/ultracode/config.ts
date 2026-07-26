/**
 * Shared constants for the ultracode extension.
 *
 * Numbers that mirror Claude Code 2.1.217 are marked with the constant they
 * came from in the binary; the rest are pi-side choices documented in README.md.
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

export const CONFIG = {
	/** Claude Code K6d.TURNS_BETWEEN_MAINTENANCE: sparse "still on" reminder cadence. */
	turnsBetweenMaintenance: 10,
	/** Claude Code caps concurrent workflow agents at min(16, cores - 2). */
	maxConcurrency: Math.max(1, Math.min(16, cpus().length - 2)),
	/** Claude Code's runaway-loop backstop: total agents per workflow run. */
	maxAgentsPerRun: 1000,
	/** Claude Code's per-call item cap for parallel()/pipeline(). */
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
	/** Claude Code settings key ultracodeKeywordTrigger; default true. */
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
