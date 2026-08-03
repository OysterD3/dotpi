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
 */

export interface StallCandidate {
	role?: string;
	content?: unknown;
	stopReason?: string;
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
 * A turn that ended with nothing for the loop to do.
 *
 * Two shapes, both of which leave the agent stopped mid-task with no error:
 *
 *   stop     + no content at all — the provider finished having said nothing.
 *   toolUse  + no tool call      — the provider claimed a call it did not send,
 *                                  so the loop had nothing to execute.
 *
 * `aborted` is the user pressing escape and `error` is already reported as a
 * failure; re-entering the loop for either would fight the user or spin on a
 * real fault. Any other stop reason ("length", "content_filter") is a genuine
 * ending the user should see, not something to paper over.
 */
export function isStalled(message: StallCandidate | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason === "stop") return hasNoContent(message.content);
	// A claimed tool call that is not in the message. Text alongside it does not
	// make this a real turn — the model said what it was about to do and then
	// nothing ran.
	if (message.stopReason === "toolUse") return !hasToolCall(message.content);
	return false;
}
