/**
 * The `recall` tool's lookup: the stored body behind a stub.
 *
 * A stub says what was dropped and how big it was. What it used to say is
 * still in the session — the diet rewrites only the copy bound for the
 * provider — so the model does not have to re-run the tool to read it again.
 * Re-running was the only way back before this existed, and it is wrong twice
 * over: a bash call repeats whatever it did the first time, and a read of a
 * file the model has since edited comes back different from what it was
 * reasoning about. Recall returns the stored bytes, by the toolCallId the
 * stub names.
 *
 * Pure: session entries in, a result (or a throw) out. index.ts wires it to
 * ctx.sessionManager.getBranch(), which is the raw root→leaf walk — every
 * entry type, compaction included — so a result older than a compaction is
 * still reachable for the life of the session. Imports pi for types only, so
 * the test suite keeps running from a bare checkout.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentBytes } from "./diet.ts";

export const RECALL_TOOL = "recall";

export interface RecallDetails {
	toolCallId: string;
	toolName: string;
	bytes: number;
}

/** The stored result for a tool call, or undefined when this session never had one. */
export function findToolResult(entries: readonly SessionEntry[], toolCallId: string): ToolResultMessage | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolCallId?: string };
		if (message.role === "toolResult" && message.toolCallId === toolCallId) return entry.message as ToolResultMessage;
	}
	return undefined;
}

/**
 * What the tool returns: the original content, untouched — text and images
 * alike. Throws when the id names nothing, which pi reports to the model as
 * the tool's error; a wrong id is the model's mistake to see, not to paper over.
 */
export function recallResult(
	entries: readonly SessionEntry[],
	toolCallId: string,
): { content: ToolResultMessage["content"]; details: RecallDetails } {
	const found = findToolResult(entries, toolCallId);
	if (!found) throw new Error(`No tool result with id "${toolCallId}" in this session — the id is the one a dropped-output stub names.`);
	return {
		// A copy: the return value becomes a new session entry of its own, and two
		// entries sharing one content array is an aliasing hazard nothing needs.
		content: structuredClone(found.content),
		details: { toolCallId, toolName: found.toolName, bytes: contentBytes(found.content) },
	};
}
