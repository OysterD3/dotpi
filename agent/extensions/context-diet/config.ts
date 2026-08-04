/**
 * Constants and settings for the context-diet extension.
 */
export const ENTRY_TYPE = "context-diet";

export const SETTINGS_KEY = "contextDiet";

export const CONFIG = {
	/**
	 * What one image block costs, in tokens. Real image cost is derived from
	 * dimensions, not file size — a 2000x1168 screenshot tiles to roughly this
	 * on the GPT-5 family — so no byte-derived formula would be more honest.
	 * The number only steers *planning*; the provider's real count comes back
	 * on the next response and corrects the running total either way.
	 */
	imageTokens: 1200,
	/** Characters per token. pi's own estimator uses the same divisor. */
	charsPerToken: 4,
	/** Longest tool argument echoed into a stub, before an ellipsis. */
	labelChars: 64,
} as const;

export interface DietSettings {
	enabled: boolean;
	/**
	 * Fraction of the context window at which a diet round runs. Below pi's own
	 * compaction threshold (window - 16384, so 94% of a 272k window) on purpose:
	 * this is meant to keep a long turn from ever reaching that point, since
	 * within a turn pi never checks it.
	 */
	highWaterRatio: number;
	/**
	 * Fraction of the window a round trims down to. The gap between this and
	 * highWaterRatio is the hysteresis — context has to grow by the whole gap
	 * before another round triggers, which is what keeps rounds rare and the
	 * prompt cache stable. Narrowing the gap is the one change here that can
	 * cost more than it saves.
	 */
	targetRatio: number;
	/** Absolute token overrides. 0 means "use the ratio". */
	highWaterTokens: number;
	targetTokens: number;
	/** Newest N tool results are never touched — the live working set. */
	keepRecentResults: number;
	/**
	 * Newest N image-bearing results survive; older ones go even when they fall
	 * inside keepRecentResults. Screenshots stale faster than anything else in a
	 * session and each one is worth ~20 lines of text in tokens.
	 */
	keepImages: number;
	/** Results smaller than this are left alone; the stub would not pay for itself. */
	minResultBytes: number;
	/**
	 * EXPERIMENTAL, default off. Rounds also strip thinking blocks (the encrypted
	 * reasoning signatures) from all but the newest `keepRecentReasoning`
	 * assistant messages. In the measured session those blobs were 1MB across 455
	 * messages — on the order of 10–25% of peak context, re-read on every call.
	 *
	 * Off by default because the risk is a hard failure, not a quality dip: for
	 * reasoning models the OpenAI Responses API can reject a replayed
	 * function_call whose paired reasoning item is missing ("... was provided
	 * without its required reasoning item"). Whether that check applies to
	 * long-completed rounds or only the call being answered is not documented;
	 * the flag exists to find out on a real session. If a turn dies with that
	 * error, turn this back off — nothing else changes, the session is intact.
	 */
	dropOldReasoning: boolean;
	/** Newest N assistant messages keep their reasoning when the flag is on. */
	keepRecentReasoning: number;
}

export const DEFAULT_SETTINGS: DietSettings = {
	enabled: true,
	highWaterRatio: 0.8,
	targetRatio: 0.55,
	highWaterTokens: 0,
	targetTokens: 0,
	keepRecentResults: 24,
	keepImages: 3,
	minResultBytes: 512,
	dropOldReasoning: false,
	keepRecentReasoning: 10,
};

/**
 * Read a settings block, taking only values that make sense and falling back to
 * the default for the rest. A target at or above the high-water mark is the one
 * combination that would make this extension cost money instead of saving it,
 * so that pair is rejected together rather than clamped into something the
 * settings file does not say.
 */
export function resolveSettings(raw: unknown): DietSettings {
	const block = (raw ?? {}) as Record<string, unknown>;
	const bool = (key: keyof DietSettings): boolean =>
		typeof block[key] === "boolean" ? (block[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean);
	const num = (key: keyof DietSettings, min: number, max: number): number => {
		const value = block[key];
		return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
			? value
			: (DEFAULT_SETTINGS[key] as number);
	};

	const highWaterRatio = num("highWaterRatio", 0.1, 0.95);
	const targetRatio = num("targetRatio", 0.05, 0.9);
	const ratiosOrdered = targetRatio < highWaterRatio;

	return {
		enabled: bool("enabled"),
		highWaterRatio: ratiosOrdered ? highWaterRatio : DEFAULT_SETTINGS.highWaterRatio,
		targetRatio: ratiosOrdered ? targetRatio : DEFAULT_SETTINGS.targetRatio,
		highWaterTokens: num("highWaterTokens", 0, Number.MAX_SAFE_INTEGER),
		targetTokens: num("targetTokens", 0, Number.MAX_SAFE_INTEGER),
		keepRecentResults: Math.floor(num("keepRecentResults", 0, 1000)),
		keepImages: Math.floor(num("keepImages", 0, 1000)),
		minResultBytes: Math.floor(num("minResultBytes", 0, Number.MAX_SAFE_INTEGER)),
		dropOldReasoning: bool("dropOldReasoning"),
		// Floor of 1: keeping zero reasoning would strip the message the model is
		// mid-thought on, which no configuration should be able to say.
		keepRecentReasoning: Math.floor(num("keepRecentReasoning", 1, 1000)),
	};
}
