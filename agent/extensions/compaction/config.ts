/**
 * Settings for compaction steering.
 *
 * These live in the SAME `compaction` block pi reads for its own
 * enabled/reserveTokens/keepRecentTokens, because they are the same subject and
 * splitting them across two blocks made the tuning impossible to find. pi reads
 * exactly those three keys by name (SettingsManager.getCompactionSettings) and
 * ignores the rest, so the extra keys below are safe to sit alongside them.
 */

export const SETTINGS_KEY = "compaction";

/**
 * Thinking levels this extension will accept for the summarization call.
 * Mirrors pi's ThinkingLevel; kept as data so a typo in settings falls back to
 * the default rather than reaching the provider.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingChoice = (typeof THINKING_LEVELS)[number];

export interface CompactionSettings {
	/** Master switch. When false, pi's own compaction runs untouched. */
	steer: boolean;
	/**
	 * Thinking level for the summarization call.
	 *
	 * pi passes the SESSION's level here, so a session set to "max" pays max
	 * reasoning to write a summary — a task that is transcription, not
	 * deduction. "low" is the default because summaries do need to judge what
	 * still matters, which "off" tends to get wrong.
	 */
	thinking: ThinkingChoice;
	/** Soft ceiling given to the summarizer, in words. */
	maxWords: number;
	/**
	 * Compact once context reaches this percent of the window; 0 disables.
	 *
	 * 80 leaves room to finish the turn in progress without firing so often
	 * that the session is repeatedly trading detail for space. It is still a
	 * large change from pi's own trigger, which on a million-token window does
	 * not fire until ~984k — in practice, never.
	 */
	compactAtPercent: number;
	/**
	 * Compact once context reaches this many tokens, whatever the window;
	 * 0 disables. Off by default: this is a cost preference, not a correctness
	 * one, and the right number depends on what the session is worth to you.
	 */
	compactAtTokens: number;
}

export const DEFAULT_SETTINGS: CompactionSettings = {
	steer: true,
	thinking: "low",
	maxWords: 700,
	compactAtPercent: 80,
	compactAtTokens: 0,
};

/**
 * Read the `compaction` block. Every field falls back independently: a single
 * bad value must not disable steering, because the alternative is a session
 * that silently reverts to unbounded summaries.
 */
export function resolveSettings(raw: unknown): CompactionSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
	const block = raw as Record<string, unknown>;
	const thinking = block.thinking;
	// 0 is meaningful for the two thresholds (it disables them) but not for
	// maxWords, so they cannot share one coercion.
	// This used to range-check the RAW value and floor afterwards, so anything in
	// (0, 1) passed and then became 0. For the thresholds 0 means "disabled", so
	// `compactAtPercent: 0.8` — the obvious way to write "80%" — silently switched
	// auto-compaction off for the entire session; for maxWords it produced the
	// zero that `allowZero: false` exists to reject, and the summarizer was then
	// told to "aim for under 0 words".
	//
	// Flooring first is not enough on its own, because 0 remains a legitimate
	// value for the thresholds. The distinction that matters is between a literal
	// 0 (disable this) and a positive number that merely rounds down to 0 (a
	// mistyped fraction), and only the former is honoured.
	const count = (value: unknown, fallback: number, allowZero: boolean): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
		if (value === 0) return allowZero ? 0 : fallback;
		const floored = Math.floor(value);
		return floored > 0 ? floored : fallback;
	};
	return {
		steer: typeof block.steer === "boolean" ? block.steer : DEFAULT_SETTINGS.steer,
		thinking:
			typeof thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(thinking)
				? (thinking as ThinkingChoice)
				: DEFAULT_SETTINGS.thinking,
		maxWords: count(block.maxWords, DEFAULT_SETTINGS.maxWords, false),
		compactAtPercent: count(block.compactAtPercent, DEFAULT_SETTINGS.compactAtPercent, true),
		compactAtTokens: count(block.compactAtTokens, DEFAULT_SETTINGS.compactAtTokens, true),
	};
}
