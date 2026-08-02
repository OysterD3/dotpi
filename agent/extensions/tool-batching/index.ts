/**
 * tool-batching — tell the model that independent tool calls go in one message.
 *
 * The measurement behind this is in guideline.ts. Short version: 142 of 151
 * assistant turns in a 53-minute agent made exactly one tool call, every turn
 * re-read ~92k tokens of context, and pi's system prompt never mentions
 * batching. pi has executed batched calls concurrently all along.
 *
 * There is no settings block. This is six lines of prompt describing how the
 * tool loop already works; a kill switch for it would be more code than the
 * feature, and "should the agent waste turns" is not a preference anyone holds.
 *
 * Appended rather than replacing: `systemPrompt` results chain across
 * extensions, so overwriting would silently drop memory's contribution, or
 * visual-reference's, or add-dir's.
 *
 * Only the main session is reached from here. Workflow subagents and `subagents`
 * tasks spawn with --no-extensions, so they carry their own copy of the rule in
 * their spawn preamble — duplicated text rather than a shared import, which is
 * this repo's convention for anything crossing an extension boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_BATCHING_GUIDELINE } from "./guideline.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${TOOL_BATCHING_GUIDELINE}`,
	}));
}
