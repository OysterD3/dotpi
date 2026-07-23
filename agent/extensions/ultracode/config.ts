/**
 * Shared constants for the ultracode extension.
 *
 * Numbers that mirror Claude Code 2.1.217 are marked with the constant they
 * came from in the binary; the rest are pi-side choices documented in README.md.
 */
import { cpus } from "node:os";

export const ENTRY_TYPE = "ultracode";

export const SETTINGS_KEY = "ultracode";

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
} as const;

export interface UltracodeSettings {
	/** Claude Code settings key ultracodeKeywordTrigger; default true. */
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
