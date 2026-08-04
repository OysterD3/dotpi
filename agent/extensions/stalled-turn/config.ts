/**
 * Settings for stalled-turn.
 *
 * Settings (agent settings.json — per-machine):
 *   stalledTurn.enabled                boolean, default true
 *   stalledTurn.maxResumes             number, default 2 (per human turn)
 *   stalledTurn.pendingToolCallAlertMs number, default 600000 (10m); 0 = off
 */

export const SETTINGS_KEY = "stalledTurn";

export const ENTRY_TYPE = "stalled-turn";

/** The customType of the nudge, so it is recognisable in the transcript. */
export const RESUME_TYPE = "stalled-turn-resume";

/** Display-only entry for the abort-recovery affordance (B) — never sent to the LLM. */
export const ABORT_RECOVERY_ENTRY_TYPE = "stalled-turn-abort-recovery";

/** Hidden reminder attached when a pending call finally completes long after it was issued (A.3). */
export const PENDING_STALE_MESSAGE_TYPE = "stalled-turn-pending-stale";

/**
 * How long a pending tool call has to run before its eventual completion is
 * treated as looking at a stale world rather than a merely slow one. Fixed,
 * not a setting: this is the line between "the sandbox took a while" and "the
 * user answered a permission prompt six hours later", and turning it into a
 * knob would just move the same guess to settings.json without a better basis
 * for picking a number.
 */
export const STALE_RESULT_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * How often the pending-call alert sweep checks for calls that have crossed
 * pendingToolCallAlertMs. A minute is frequent enough that the alert lands
 * close to the threshold without polling hard enough to matter next to an
 * LLM call.
 */
export const PENDING_ALERT_TICK_MS = 60_000;

/**
 * How long the tool call immediately preceding an abort must have actually
 * run before that abort is classified as "Escape used to unstick a hung tool"
 * (B) rather than an ordinary cancel. Without a floor, a ROUTINE failure — a
 * command that exits nonzero in under a second, immediately followed by the
 * user pressing Escape for an unrelated reason — has the identical shape
 * (aborted + empty content + a preceding isError toolResult) and would be
 * mislabelled "stuck tool, unstuck" when nothing was ever stuck. Fixed, not a
 * setting, for the same reason STALE_RESULT_THRESHOLD_MS is: this is a guess
 * at where "slow" ends and "hung" begins, and a knob would not make that
 * guess any better informed. Two minutes is comfortably past how long a
 * merely-slow command runs but well short of the tens-of-minutes range a
 * genuinely wedged permission prompt sits for.
 */
export const HUNG_TOOL_MIN_MS = 120_000;

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
	/**
	 * How long a tool call may sit executing before the 60s sentinel sweep
	 * notifies + rings the bell about it, once per call. 0 disables the alert
	 * entirely — tracking and the shutdown warning (A.1) and stale-result
	 * reminder (A.3) stay on regardless, since those cost nothing when quiet
	 * and are the whole point of the sentinel.
	 */
	pendingToolCallAlertMs: number;
}

export const DEFAULT_SETTINGS: StalledTurnSettings = {
	enabled: true,
	maxResumes: 2,
	pendingToolCallAlertMs: 600_000,
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
	const pendingToolCallAlertMs = block.pendingToolCallAlertMs;
	return {
		enabled: typeof block.enabled === "boolean" ? block.enabled : DEFAULT_SETTINGS.enabled,
		// 0 is meaningful — detect and report, never resume.
		maxResumes:
			typeof maxResumes === "number" && Number.isFinite(maxResumes) && maxResumes >= 0
				? Math.floor(maxResumes)
				: DEFAULT_SETTINGS.maxResumes,
		// 0 is meaningful here too — off, not "unset".
		pendingToolCallAlertMs:
			typeof pendingToolCallAlertMs === "number" && Number.isFinite(pendingToolCallAlertMs) && pendingToolCallAlertMs >= 0
				? Math.floor(pendingToolCallAlertMs)
				: DEFAULT_SETTINGS.pendingToolCallAlertMs,
	};
}
