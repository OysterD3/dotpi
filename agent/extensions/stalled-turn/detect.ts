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

/**
 * A turn that ended on nothing.
 *
 * Only `stop` qualifies. `aborted` is the user pressing escape, and `error` is
 * already reported as a failure — re-entering the loop for either would fight
 * the user or loop on a real fault.
 */
export function isStalled(message: StallCandidate | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "stop") return false;
	return hasNoContent(message.content);
}
