/**
 * Constants and settings for the self-update extension.
 *
 * This repo IS ~/.pi, so keeping a machine current is a `git pull` in the repo
 * root. The extension does that in the background at session start, throttled,
 * and only speaks up when something actually changed. Because it lives in the
 * repo, a machine that has cloned once keeps itself updated with no extra setup.
 */

/** settings.json key for the self-update block (per-machine; not synced). */
export const SETTINGS_KEY = "selfUpdate";

/** Local throttle bookkeeping; gitignored, never synced. */
export const STATE_FILE = ".self-update.json";

export const CONFIG = {
	/** Default gap between update checks. */
	defaultIntervalHours: 6,
	/** Ceiling for any one git call, so a hung network cannot wedge startup. */
	gitTimeoutMs: 60_000,
} as const;

export interface SelfUpdateSettings {
	/** Master switch. Default true. */
	enabled: boolean;
	/** Minimum hours between checks. Default 6; 0 means check every start. */
	intervalHours: number;
}

export const DEFAULT_SETTINGS: SelfUpdateSettings = {
	enabled: true,
	intervalHours: CONFIG.defaultIntervalHours,
};
