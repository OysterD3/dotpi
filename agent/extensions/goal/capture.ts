/**
 * `goal.autoCapture`'s trigger: deciding when an "input" event is worth
 * spending the session's one extraction attempt on.
 *
 * Deliberately much narrower than ask-user's `opensWork()` word-list
 * classifier in agent/extensions/ask-user/nudge.ts: extensions here install
 * independently and do not share modules (see model.ts's header for the same
 * stance on a different file), and the hard part of "is this actually a real
 * request, or a quick question, a chat message, a vague ask" is already this
 * feature's own extraction call — CAPTURE_SYSTEM in prompts.ts is explicitly
 * told to return null for exactly those, and to err toward null when unsure.
 *
 * All this gate has to do is keep the one shot per session from being spent on
 * something too short to plausibly state a criterion at all — "hi", "thanks",
 * a bare "/goal" or "!ls" — so that if the session opens with small talk, the
 * message that actually states the work is still there to try.
 *
 * Pure — no pi APIs — so it is testable without a session.
 */

import { CONFIG } from "./config.ts";

/** The subset of pi's InputEvent this gate reads. */
export type CaptureInput = {
	text: string;
	source: "interactive" | "rpc" | "extension";
	/** Present only when the agent is mid-turn: a steer or a follow-up, not a fresh prompt. */
	streamingBehavior?: "steer" | "followUp";
};

/** Whether this input event should spend `goal.autoCapture`'s one-shot attempt. */
export function isCaptureCandidate(event: CaptureInput): boolean {
	// Mid-turn input is not the turn-opening prompt this feature targets, and a
	// non-interactive source (rpc, extension) is not a human typing a request.
	if (event.streamingBehavior !== undefined || event.source !== "interactive") return false;

	const trimmed = event.text.trim();
	// A slash command or a `!` bash line is not a request to the model at all.
	if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;

	const words = trimmed.split(/\s+/).filter((word) => word.length > 0).length;
	return words >= CONFIG.minCaptureWords;
}
