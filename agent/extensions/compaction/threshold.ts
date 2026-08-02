/**
 * When to compact, as opposed to pi's own answer.
 *
 * pi triggers on `contextTokens > contextWindow - reserveTokens`. On a
 * million-token model with the default 16k reserve that is ~984k, so on a long
 * session compaction effectively never fires — a measured session here reached
 * 634k without a single compaction, paying cacheRead on the whole of it every
 * turn. reserveTokens cannot be repurposed to fire earlier, because it is also
 * the summary's own token budget (maxTokens = 0.8 * reserveTokens), so raising
 * it to move the trigger would commission an enormous summary.
 *
 * Hence a separate trigger, expressed the two ways the question actually gets
 * asked: as a fraction of the window, and as an absolute token count. The
 * absolute one is the cost control — per-turn cacheRead scales with context
 * size, so a hard ceiling on context is a hard ceiling on the standing cost of
 * every remaining turn, whatever the window happens to be.
 *
 * Either can be disabled with 0, and pi's own trigger always remains as the
 * backstop underneath.
 */

export interface ThresholdSettings {
	/** Compact once context reaches this percent of the window. 0 disables. */
	compactAtPercent: number;
	/** Compact once context reaches this many tokens, whatever the window. 0 disables. */
	compactAtTokens: number;
}

export interface ContextReading {
	tokens: number | null;
	percent: number | null;
}

/**
 * pi reports tokens and percent as null when it has nothing measured yet —
 * notably right after a compaction, before the next response. That is "unknown",
 * not "empty", and triggering on it would compact repeatedly on an empty
 * context.
 */
export function shouldTrigger(reading: ContextReading | undefined, settings: ThresholdSettings): boolean {
	if (!reading) return false;
	if (settings.compactAtTokens > 0 && reading.tokens !== null && reading.tokens >= settings.compactAtTokens) {
		return true;
	}
	if (settings.compactAtPercent > 0 && reading.percent !== null && reading.percent >= settings.compactAtPercent) {
		return true;
	}
	return false;
}
