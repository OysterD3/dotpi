/**
 * Spotting a turn that ended without the assistant saying or doing anything.
 *
 * A provider that finishes cleanly having produced NOTHING is indistinguishable,
 * to pi, from an assistant that decided it was done — `stopReason: "stop"` means
 * exactly that, and pi correctly ends the turn. The result is work that stops
 * halfway with no error and no explanation.
 *
 * Observed with pi-provider-qoder 0.2.9, whose stream finalisation ends with:
 *
 *   if (toolCallsState.length > 0) output.stopReason = "toolUse";
 *   else output.stopReason = "stop";
 *
 * run unconditionally, overwriting the real `finish_reason` captured earlier.
 * Any stream that ends without tool calls — a dropped connection, a truncated
 * SSE, a token cap, a content filter — is reported as a clean finish. Every one
 * of the local qoder sessions ends with `content: []`, `stopReason: "stop"`
 * after four to eight successful tool calls.
 *
 * Nothing here is qoder-specific, because nothing here needs to be: an assistant
 * message with no content at all is never a legitimate reply, whoever produced
 * it.
 *
 * A SECOND shape turned up later, and it is the one that hurts more because the
 * message is not empty. qoder builds its toolCall content block only once
 * arguments arrive, but marks the call as present the moment any delta for that
 * index does — so a call whose arguments are absent or an empty string yields
 * `stopReason: "toolUse"` on a message containing no tool call at all. pi's loop
 * continues only on tool calls, so it finds nothing to run and the turn ends.
 * Observed repeatedly as "let me consult the advisor" followed by silence; the
 * transcript reads stopReason "toolUse", blocks ["thinking", "text"].
 *
 * That one is also provider-agnostic: a message claiming a tool call and
 * carrying none is unactionable whoever produced it. Fixed upstream in
 * simonsmh/pi-provider-qoder#14, but a provider that lies about its stop reason
 * is exactly what this extension exists to survive.
 *
 * A THIRD shape (isStalled's "error" branch) and a fourth kind of problem
 * entirely (isAbortAfterHungTool, isStaleCompletion, shouldAlertPendingCall)
 * came from forensics on a different benchmark run: see their own doc
 * comments below for what each is answering.
 */

export interface StallCandidate {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

type Block = { type?: string; text?: string };

/**
 * True when the message carries nothing a reader or the loop could act on.
 *
 * Whitespace-only text counts as empty: a provider that emits one blank chunk
 * before dying is the same failure with a byte in it. Thinking blocks do NOT
 * count as content — reasoning with no reply is still no reply, and it is a
 * shape qoder produces.
 */
export function hasNoContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length === 0;
	if (!Array.isArray(content)) return true;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as Block;
		if (block.type === "text") {
			if (typeof block.text === "string" && block.text.trim().length > 0) return false;
			continue;
		}
		// Anything that is not text or thinking — a tool call, an image — is real
		// output and means the turn did something.
		if (block.type !== "thinking") return false;
	}
	return true;
}

/** True when the message contains at least one toolCall block. */
export function hasToolCall(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((part) => (part as Block | null)?.type === "toolCall");
}

/**
 * A third shape, found in the same benchmark forensics as the other two:
 * `stopReason: "error"` with empty content, where pi's own auto-retry looked
 * at the error and declined to touch it. pi retries a fixed whitelist of
 * transient-looking provider/transport errors (rate limits, 5xx, dropped
 * connections, premature stream endings, …) and gives up immediately on
 * everything else — including errors it has never seen before. "Gives up"
 * here means the turn just ends: no tool call, no text, and (outside
 * interactive mode watching the red "Error: …" line appear) nothing that
 * looks different from the two empty-completion shapes above. An unattended
 * multi-hour run — exactly the shape of the benchmark this extension is
 * responding to — has nobody there to notice and retype something.
 *
 * Mirrored, not imported, from @earendil-works/pi-ai's utils/retry.js (as of
 * pi-ai 0.82.1: RETRYABLE_PROVIDER_ERROR_PATTERN / NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN).
 * That file is an internal helper of a transitive dependency two packages
 * away from the extension surface, not something to pin a runtime import to
 * across pi-ai versions. Being a copy means it can drift from pi's real list,
 * but the failure mode of drift is asymmetric and deliberately tolerated: a
 * pattern pi adds later that we do not know about just means one more error
 * text this extension still treats as a stall (a false "needs resuming",
 * costing at most maxResumes wasted attempts against a cap that already
 * exists for this) — never the other way round, resuming something pi's own
 * retry is already handling.
 */
function buildProviderErrorPattern(patterns: string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	"retry delay",
	"you can retry your request",
	"try your request again",
	"please retry your request",
	"ResourceExhausted",
]);

/**
 * True when pi's own retry policy would decline to retry this error and let
 * the turn die where it stands — mirrors pi-ai's isRetryableAssistantError,
 * negated, checking the limit pattern first exactly as pi does (a message
 * that happens to also contain "500" is still a billing wall, not a transient
 * server error, if the billing pattern matches).
 */
function isDeadProviderError(errorMessage: string): boolean {
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return true;
	return !RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/**
 * A turn that ended with nothing for the loop to do.
 *
 * Three shapes, all of which leave the agent stopped mid-task with no error a
 * provider-agnostic caller could tell from a genuine finish:
 *
 *   stop     + no content at all — the provider finished having said nothing.
 *   toolUse  + no tool call      — the provider claimed a call it did not send,
 *                                  so the loop had nothing to execute.
 *   error    + no content at all — pi's own auto-retry looked at errorMessage
 *                                  and declined to retry it (see
 *                                  isDeadProviderError above).
 *
 * `aborted` is the user pressing escape — see isAbortAfterHungTool for the one
 * shape of abort this extension does still act on, as a display-only
 * affordance rather than a resume. A stopReason "error" that pi's own retry
 * WOULD handle is left alone here too: treating it as a stall as well would
 * mean two systems racing to resume the same failed call. Any other stop
 * reason ("length", "content_filter") is a genuine ending the user should
 * see, not something to paper over.
 */
export function isStalled(message: StallCandidate | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason === "stop") return hasNoContent(message.content);
	// A claimed tool call that is not in the message. Text alongside it does not
	// make this a real turn — the model said what it was about to do and then
	// nothing ran.
	if (message.stopReason === "toolUse") return !hasToolCall(message.content);
	if (message.stopReason === "error") {
		if (!hasNoContent(message.content)) return false;
		const errorMessage = message.errorMessage;
		return typeof errorMessage === "string" && errorMessage.length > 0 && isDeadProviderError(errorMessage);
	}
	return false;
}

export interface AbortCandidate {
	role?: string;
	content?: unknown;
	stopReason?: string;
}

/**
 * The abort-recovery fingerprint (B): `stopReason: "aborted"`, empty content,
 * and the message immediately before it in the transcript was a failed
 * (isError) tool result that had actually been running a while. That
 * combination is the user pressing Escape to unstick a hung tool call, not to
 * stop the work — Escape has no finer-grained "cancel just this tool"
 * gesture, so the only signal available afterward is what the abort landed
 * next to.
 *
 * `precedingIsErrorToolResult` is supplied by the caller rather than looked up
 * here: detect.ts has no session access by design (see the file header), so
 * this takes the one fact index.ts already had to fetch via
 * ctx.sessionManager.getLeafEntry() — which, because extensions run BEFORE
 * session persistence on message_end, is still the PRECEDING message at the
 * point index.ts reads it — rather than the object it came from.
 *
 * `precedingElapsedMs` and `minHungMs` are the fix for a false positive the
 * fingerprint above shares with an utterly ordinary sequence: a command that
 * fails fast (isError, nonzero exit, under a second) followed by the user
 * hitting Escape for any unrelated reason produces the exact same shape —
 * aborted + empty content + a failed tool result right behind it — and
 * without a duration check this fingerprint would tell the user a "stuck"
 * tool was unstuck when nothing was ever stuck. index.ts already tracks
 * tool_execution_start times for the pending-call sentinel (A), so the same
 * {toolName, startedAt} record supplies precedingElapsedMs here for free; a
 * call that never ran long enough to plausibly be "hung" is left as a plain,
 * unflagged abort instead.
 *
 * This is deliberately narrower than "any abort after any tool result": a
 * SUCCESSFUL tool result followed by Escape is the user stopping something
 * that was going fine, and treating that as "unfinished, resume me" would be
 * noise on the common case of a clean cancel.
 */
export function isAbortAfterHungTool(
	message: AbortCandidate | undefined,
	precedingIsErrorToolResult: boolean,
	precedingElapsedMs: number,
	minHungMs: number,
): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "aborted") return false;
	if (!hasNoContent(message.content)) return false;
	if (!precedingIsErrorToolResult) return false;
	return precedingElapsedMs >= minHungMs;
}

/**
 * True once a pending tool call has run long enough past completion that its
 * result reflects a stale world (A.3) — see STALE_RESULT_THRESHOLD_MS in
 * config.ts for why the line sits where it does.
 */
export function isStaleCompletion(elapsedMs: number, thresholdMs: number): boolean {
	return elapsedMs > thresholdMs;
}

/**
 * True once a still-pending tool call has run long enough to alert on (A.2).
 * alertThresholdMs <= 0 means the setting is off — every call would otherwise
 * "alert" instantly, which is the opposite of what 0 is documented to mean.
 */
export function shouldAlertPendingCall(elapsedMs: number, alertThresholdMs: number): boolean {
	return alertThresholdMs > 0 && elapsedMs >= alertThresholdMs;
}
