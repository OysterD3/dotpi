/**
 * Settings for stalled-turn.
 *
 * Settings (agent settings.json — per-machine):
 *   stalledTurn.enabled      boolean, default true
 *   stalledTurn.maxResumes   number, default 2 (per human turn)
 */

export const SETTINGS_KEY = "stalledTurn";

export const ENTRY_TYPE = "stalled-turn";

/** The customType of the nudge, so it is recognisable in the transcript. */
export const RESUME_TYPE = "stalled-turn-resume";

export interface StalledTurnSettings {
	enabled: boolean;
	/**
	 * How many times one human turn may be resumed automatically.
	 *
	 * A cap, not a retry budget: if the provider is returning empty completions
	 * persistently, resuming forever would spend real money producing nothing
	 * and would look like a hang. Two attempts covers a transient drop; a third
	 * failure is a fault worth surfacing rather than papering over.
	 */
	maxResumes: number;
}

export const DEFAULT_SETTINGS: StalledTurnSettings = {
	enabled: true,
	maxResumes: 2,
};

/**
 * What the assistant is told when its turn ended on nothing.
 *
 * Phrased as a fact about the transport rather than a reprimand: the model did
 * not choose to stop, so telling it to "continue as instructed" invites it to
 * apologise or re-plan. It needs to know the last reply was lost and that it
 * should carry on from where the tool results left it.
 */
export const RESUME_PROMPT =
	"Your previous reply arrived empty — the provider ended the response without sending any content, so nothing you wrote was delivered. This was a transport failure, not something you did. Continue the task from where the last tool results left off. Do not restart, do not re-run tools whose results you can already see above, and do not apologise; just carry on.";

export function resolveSettings(raw: unknown): StalledTurnSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
	const block = raw as Record<string, unknown>;
	const maxResumes = block.maxResumes;
	return {
		enabled: typeof block.enabled === "boolean" ? block.enabled : DEFAULT_SETTINGS.enabled,
		// 0 is meaningful — detect and report, never resume.
		maxResumes:
			typeof maxResumes === "number" && Number.isFinite(maxResumes) && maxResumes >= 0
				? Math.floor(maxResumes)
				: DEFAULT_SETTINGS.maxResumes,
	};
}
