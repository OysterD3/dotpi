/**
 * Advice resurfacing: closing the "fire-and-forget" gap.
 *
 * Before this module, a consult's advice went out as a tool result and was
 * then held nowhere — nothing in the session could later ask "you were told
 * X, you then did not-X". Forensics on a benchmark run (gpt-5.6-sol vs
 * claude-opus-5 on the same GUI-building task) found seven sharp advisor
 * steers each partially ignored within minutes: the agent read the advice,
 * kept working, and drifted off it before the next consult had a chance to
 * catch the drift. Nothing surfaced the conflict until a human did.
 *
 * Two independent mechanisms close that gap, both driven from index.ts's
 * `tool_call` / `tool_result` handlers so this module stays pure and
 * testable without a session:
 *
 *   1. CLOSING_LINE rides every successful consult's own result (see
 *      appendClosingLine), forcing engagement with the advice before anything
 *      else happens — follow it, or say in one line why not — without
 *      dictating what the agent's next message has to open with, which is
 *      guaranteed to collide with every other extension's reminder making the
 *      same claim on the same turn. This closes the immediate window: the one
 *      turn right after advice lands, where the benchmark showed it get
 *      quietly overridden.
 *
 *   2. AdviceState tracks mutating tool calls (write/edit/bash — the calls
 *      that actually change something, as opposed to reads that merely
 *      gather context) since the last consult. Once `afterCalls` of them pass
 *      with no newer consult, the advice head resurfaces ONCE as a hidden
 *      reminder (resurfaceReminder), closing the slower window: advice that
 *      scrolled out of recent context and stopped being weighed at all.
 *
 * State lives in the running extension instance, the same as
 * sessionModel/sessionOff in index.ts, not in the session file: the drift
 * this catches is measured in minutes within one process, and pi tears down
 * and rebuilds the extension runtime on every /resume regardless (same as
 * SessionShutdownEvent's "resume" reason), so there is no state to lose that
 * a fresh consult wouldn't re-establish anyway.
 */

import { CONFIG, type ResurfaceSettings } from "./config.ts";

export type { ResurfaceSettings };

/** Tool names that change something, as opposed to ones that only read. */
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

/** True for the tool names that count toward the resurface threshold. */
export function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

export interface AdviceState {
	/** First ~800 chars of the advice text (before the closing line), for the reminder. */
	adviceHead: string;
	/** Tool-call index (every tool, not just mutating ones) at the moment of this consult. Audit position, not used in the trigger check. */
	atCall: number;
	/** Mutating (write/edit/bash) tool calls seen since this consult. */
	mutatingCallsSince: number;
	/** Whether the one-shot resurface has already fired for this consult. */
	resurfaced: boolean;
}

/** First ~`cap` chars of advice, marked with an ellipsis when it was cut. */
export function truncateAdviceHead(advice: string, cap: number = CONFIG.adviceHeadChars): string {
	const trimmed = advice.trim();
	return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}…`;
}

/**
 * Fresh state after a successful consult.
 *
 * This is the re-arm: `resurfaced` starts false and `mutatingCallsSince`
 * starts at 0 regardless of what the previous consult's state held, so a new
 * consult always gets its own full budget of mutating calls before it can
 * resurface — a fresh "you were just told this" is not stale the instant it
 * lands.
 */
export function onConsult(atCall: number, advice: string): AdviceState {
	return { adviceHead: truncateAdviceHead(advice), atCall, mutatingCallsSince: 0, resurfaced: false };
}

/** A write/edit/bash tool call landed: one step closer to the resurface threshold. */
export function recordMutatingCall(state: AdviceState): AdviceState {
	return { ...state, mutatingCallsSince: state.mutatingCallsSince + 1 };
}

/**
 * Should the standing advice resurface right now?
 *
 * True at most once per consult: `resurfaced` is what makes this a one-shot
 * rather than a repeat-every-call reminder once the threshold is crossed —
 * without it, every mutating call past `afterCalls` would fire again.
 */
export function shouldResurface(state: AdviceState, settings: ResurfaceSettings): boolean {
	if (!settings.enabled || state.resurfaced) return false;
	return state.mutatingCallsSince >= settings.afterCalls;
}

/** Record that the one-shot resurface for this consult has fired. */
export function markResurfaced(state: AdviceState): AdviceState {
	return { ...state, resurfaced: true };
}

/**
 * The hidden reminder text. index.ts wraps this in <system-reminder> — kept
 * separate from the wrapping so the wording is testable on its own.
 *
 * States the advice head as evidence (the agent cannot say "which advice?")
 * and asks for a one-line self-check rather than blind compliance: the
 * advisor's own guidance already tells the agent to weight judgment and
 * verify details, and a mechanical "you must now follow this" would fight
 * that rather than reinforce it. The two ways out — comply, or call the
 * advisor again and say why not — mirror the reconcile-call pattern
 * ADVISOR_TOOL_GUIDANCE already teaches for a conflicting finding.
 */
export function resurfaceReminder(adviceHead: string): string {
	return `Your advisor's standing advice: "${adviceHead}" — in one line: are your actions since then consistent with it? If not, either comply or call the advisor again and surface the conflict explicitly.`;
}

/**
 * Wrap a reminder the way pi's own hidden-message reminders are wrapped.
 *
 * A duplicate of the identical helper in ultracode/reminders.ts and
 * ask-user/nudge.ts, and deliberately so: every extension here installs
 * independently, so none imports another's helpers. See progress.ts's
 * formatElapsed for the same tradeoff made the same way.
 */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Appended to every successful consult's advice text — NOT wrapped in
 * <system-reminder>, because unlike the resurface reminder this rides in the
 * tool result itself, which the agent already reads as part of its own
 * turn. The point is to force engagement before the advice can be quietly
 * shelved: weigh it explicitly and either follow it or say why not, which is
 * the immediate half of the gap this module closes (the resurface reminder
 * above is the delayed half). Deliberately silent on what the next message
 * has to OPEN with — several extensions' reminders can drain into the same
 * turn, and each one dictating the first line would guarantee a collision.
 */
export const CLOSING_LINE = "Before acting on anything else, weigh this advice explicitly: follow it, or state in one line why not.";

/** Advice text with CLOSING_LINE appended — what the agent actually reads as the tool result. */
export function appendClosingLine(advice: string): string {
	return `${advice}\n\n${CLOSING_LINE}`;
}
